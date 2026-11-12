// The task manager: every PeckList task in one window, with its sync state and what can be done
// about it. Lines in notes, links whose line is gone, and tasks that are only in PeckList.
//
// Line edits go through the note (only if the line still reads as listed), then sync; tasks only
// in PeckList are changed through the Task API. The rows reload after every action and every
// sync.

import { type App, FuzzySuggestModal, Menu, Modal, Notice, type TFile, setIcon, setTooltip } from 'obsidian';
import type { PeckListClient } from '../api/client';
import type { ApiList, ApiTask } from '../api/types';
import { ROOT_TAG, tagForList } from '../core/lists';
import { closeTaskLines, editTagsLine, moveTaskLine, reopenTaskLine } from '../core/task-actions';
import type PeckListPlugin from '../main';
import type { SyncEngine } from '../sync/engine';
import { LEFT_OUT, type OverviewRow, type RowState, WAITING } from '../sync/overview';
import { localDate } from '../sync/values';
import { MoveToListModal } from './task-menu';

type Filter = 'all' | 'attention' | 'waiting' | 'synced' | 'left-out' | 'remote';

const FILTERS: { value: Filter; label: string; match: (r: OverviewRow) => boolean }[] = [
	{ value: 'all', label: 'All tasks', match: () => true },
	{ value: 'attention', label: 'Needs attention', match: (r) => r.state === 'attention' },
	{ value: 'waiting', label: 'Waiting to sync', match: (r) => WAITING.includes(r.state) },
	{ value: 'synced', label: 'Synced', match: (r) => r.state === 'synced' },
	{ value: 'left-out', label: 'Left out', match: (r) => LEFT_OUT.includes(r.state) },
	{ value: 'remote', label: 'Only in PeckList', match: (r) => r.kind === 'remote' },
];

const STATE: Record<RowState, { icon: string; label: string; order: number }> = {
	attention: { icon: 'alert-triangle', label: 'Needs attention', order: 0 },
	new: { icon: 'circle-dashed', label: 'Not in PeckList yet', order: 1 },
	changed: { icon: 'refresh-cw', label: 'Waiting to sync', order: 1 },
	unknown: { icon: 'refresh-cw', label: 'Not synced on this device yet', order: 1 },
	synced: { icon: 'bird', label: 'Synced', order: 2 },
	off: { icon: 'eye-off', label: 'Left out', order: 3 },
	excluded: { icon: 'eye-off', label: 'Left out', order: 3 },
	skipped: { icon: 'circle-slash', label: 'Never sent', order: 3 },
	remote: { icon: 'cloud', label: 'Only in PeckList', order: 4 },
};

/** Rows drawn at once; a search narrows longer lists. */
const MAX_ROWS = 400;

export class TaskManagerModal extends Modal {
	private rows: OverviewRow[] = [];
	private lists: ApiList[] = [];
	private remote: 'loaded' | 'skipped' | 'failed' = 'skipped';
	private filter: Filter = 'all';
	private listFilter = '';
	private query = '';
	private readonly selected = new Set<string>();
	private loading = false;
	private busy = false;
	private unsubscribe: (() => void) | null = null;

	private statusEl!: HTMLElement;
	private filterSelect!: HTMLSelectElement;
	private listSelect!: HTMLSelectElement;
	private toolbarEl!: HTMLElement;
	private bulkEl!: HTMLElement;
	private bulkCountEl!: HTMLElement;
	private listEl!: HTMLElement;
	private footEl!: HTMLElement;

	constructor(
		app: App,
		private readonly plugin: PeckListPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('pecklist-manager');
		this.titleEl.setText('PeckList tasks');
		const { contentEl } = this;
		contentEl.empty();

		const head = contentEl.createDiv({ cls: 'pecklist-mgr-head' });
		this.statusEl = head.createDiv({ cls: 'pecklist-mgr-status' });
		const actions = head.createDiv({ cls: 'pecklist-mgr-head-actions' });
		this.iconButton(actions, 'list-checks', 'Review what syncs', () => {
			this.close();
			void this.plugin.openReview(false);
		});
		const syncButton = actions.createEl('button', { text: 'Sync now', cls: 'mod-cta' });
		syncButton.addEventListener('click', () => void this.syncNow());

		// The toolbar and the bulk bar share one row of fixed height, so nothing moves when rows are selected.
		const bar = contentEl.createDiv({ cls: 'pecklist-mgr-bar' });
		this.toolbarEl = bar.createDiv({ cls: 'pecklist-mgr-toolbar' });
		const search = this.toolbarEl.createEl('input', { type: 'search', cls: 'pecklist-mgr-search', attr: { placeholder: 'Search tasks', 'aria-label': 'Search tasks' } });
		search.addEventListener('input', () => {
			this.query = search.value.trim().toLowerCase();
			this.renderRows();
		});
		this.filterSelect = this.toolbarEl.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Show' } });
		this.filterSelect.addEventListener('change', () => {
			this.filter = this.filterSelect.value as Filter;
			this.renderRows();
		});
		this.listSelect = this.toolbarEl.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'List' } });
		this.listSelect.addEventListener('change', () => {
			this.listFilter = this.listSelect.value;
			this.renderRows();
		});

		this.bulkEl = bar.createDiv({ cls: 'pecklist-mgr-bulk' });
		this.bulkEl.hide();
		this.bulkCountEl = this.bulkEl.createSpan({ cls: 'pecklist-mgr-bulk-count' });
		const bulk = (label: string, run: () => void): void => {
			const b = this.bulkEl.createEl('button', { text: label });
			b.addEventListener('click', run);
		};
		bulk('Move to list', () => this.bulkMove());
		bulk('Add tag', () => this.bulkTags('add'));
		bulk('Remove tag', () => this.bulkTags('remove'));
		bulk('Complete', () => void this.bulkComplete());
		bulk('Leave out', () => void this.bulkLeaveOut());
		const clear = this.bulkEl.createEl('button', { text: 'Clear', cls: 'pecklist-mgr-bulk-clear' });
		clear.addEventListener('click', () => {
			this.selected.clear();
			this.renderRows();
		});

		this.listEl = contentEl.createDiv({ cls: 'pecklist-mgr-list' });
		window.setTimeout(() => search.focus(), 0);
		this.footEl = contentEl.createDiv({ cls: 'pecklist-mgr-foot' });

		this.unsubscribe = this.plugin.onSynced(() => {
			if (!this.busy) void this.reload(false);
		});
		void this.reload(true);
	}

	onClose(): void {
		this.unsubscribe?.();
		this.contentEl.empty();
	}

	// --- Loading ---

	private async reload(withRemote: boolean): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		if (this.rows.length === 0) this.listEl.setText('Loading tasks...');
		try {
			// Tasks only in PeckList are fetched on open and on request; other reloads keep the last ones.
			const keepRemote = !withRemote && this.remote === 'loaded' ? this.rows.filter((r) => r.kind === 'remote') : null;
			const result = await this.plugin.overview(withRemote && this.plugin.isSignedIn());
			this.lists = result.lists;
			if (keepRemote) {
				const known = new Set(result.rows.map((r) => r.id).filter(Boolean));
				this.rows = [...result.rows, ...keepRemote.filter((r) => !known.has(r.id))];
			} else {
				this.rows = result.rows;
				this.remote = result.remote;
			}
			const keys = new Set(this.rows.map((r) => r.key));
			for (const key of [...this.selected]) if (!keys.has(key)) this.selected.delete(key);
		} finally {
			this.loading = false;
		}
		this.renderStatus();
		this.renderFilters();
		this.renderRows();
	}

	private async syncNow(): Promise<void> {
		this.busy = true;
		try {
			await this.plugin.sync('manual');
		} finally {
			this.busy = false;
		}
		await this.reload(true);
	}

	// --- Drawing ---

	private renderStatus(): void {
		const el = this.statusEl;
		el.empty();
		const last = this.plugin.lastSync;
		const icon = el.createSpan({ cls: 'pecklist-mgr-status-icon' });
		const text = el.createDiv({ cls: 'pecklist-mgr-status-text' });
		const line = text.createDiv();
		const time = last.at ? new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
		const errors = last.report?.errors.length ?? 0;
		if (!this.plugin.isSignedIn()) {
			setIcon(icon, 'log-in');
			line.setText('Not signed in on this device.');
		} else if (last.error) {
			setIcon(icon, 'alert-triangle');
			el.addClass('is-error');
			line.setText(`Not synced${time ? ` (${time})` : ''}: ${last.error}`);
		} else if (errors > 0) {
			setIcon(icon, 'alert-triangle');
			el.addClass('is-error');
			line.setText(`${errors} ${errors === 1 ? 'task' : 'tasks'} not synced${time ? ` at ${time}` : ''}.`);
		} else if (time) {
			setIcon(icon, 'check-circle');
			line.setText(`Synced at ${time}.`);
		} else {
			setIcon(icon, 'clock');
			line.setText('Not synced yet since Obsidian started.');
		}
		if (!last.error && errors === 0) el.removeClass('is-error');
		const inNotes = this.rows.filter((r) => r.kind === 'line' && r.id).length;
		const waiting = this.rows.filter((r) => WAITING.includes(r.state)).length;
		const remote = this.rows.filter((r) => r.kind === 'remote').length;
		const parts = [this.plugin.signedInText().replace(/\.$/u, ''), `${inNotes} linked in notes`];
		if (waiting) parts.push(`${waiting} waiting`);
		if (this.remote === 'loaded') parts.push(`${remote} only in PeckList`);
		else if (this.remote === 'failed') parts.push('PeckList-only tasks could not be loaded');
		text.createDiv({ cls: 'pecklist-mgr-status-sub', text: parts.join(' · ') });
	}

	private renderFilters(): void {
		this.filterSelect.empty();
		for (const f of FILTERS) {
			if (f.value === 'remote' && this.remote !== 'loaded') continue;
			const n = this.rows.filter(f.match).length;
			this.filterSelect.createEl('option', { value: f.value, text: `${f.label} (${n})` });
		}
		if (!Array.from(this.filterSelect.options).some((o) => o.value === this.filter)) this.filter = 'all';
		this.filterSelect.value = this.filter;

		this.listSelect.empty();
		this.listSelect.createEl('option', { value: '', text: 'All lists' });
		for (const name of [...new Set(this.rows.map((r) => r.listName))].sort((a, b) => a.localeCompare(b))) {
			this.listSelect.createEl('option', { value: name, text: name });
		}
		if (!Array.from(this.listSelect.options).some((o) => o.value === this.listFilter)) this.listFilter = '';
		this.listSelect.value = this.listFilter;
	}

	private visibleRows(): OverviewRow[] {
		const match = FILTERS.find((f) => f.value === this.filter)?.match ?? (() => true);
		return this.rows
			.filter((r) => match(r))
			.filter((r) => !this.listFilter || r.listName === this.listFilter)
			.filter((r) => !this.query || `${r.title} ${r.listName} ${r.tags.join(' ')} ${r.path ?? ''}`.toLowerCase().includes(this.query))
			.sort((a, b) => STATE[a.state].order - STATE[b.state].order || (a.path ?? '~').localeCompare(b.path ?? '~') || (a.lineNo ?? 0) - (b.lineNo ?? 0) || a.title.localeCompare(b.title));
	}

	private renderRows(): void {
		const rows = this.visibleRows();
		this.listEl.empty();
		if (rows.length === 0) {
			this.listEl.createDiv({ cls: 'pecklist-mgr-empty', text: this.rows.length === 0 ? 'No PeckList tasks in your notes yet. Tag a task line #pecklist to start.' : 'Nothing matches.' });
		}
		for (const row of rows.slice(0, MAX_ROWS)) this.renderRow(row);
		this.footEl.setText(rows.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${rows.length}. Search or filter to see the rest.` : '');
		this.renderBulk();
	}

	private renderRow(row: OverviewRow): void {
		const el = this.listEl.createDiv({ cls: 'pecklist-mgr-row', attr: { 'data-state': row.state } });
		if (row.status !== 'open') el.addClass('is-closed');
		const pick = el.createEl('input', { type: 'checkbox', cls: 'pecklist-mgr-pick', attr: { 'aria-label': `Select ${row.title}` } });
		pick.checked = this.selected.has(row.key);
		pick.disabled = row.kind === 'missing';
		pick.addEventListener('change', () => {
			if (pick.checked) this.selected.add(row.key);
			else this.selected.delete(row.key);
			this.renderBulk();
		});
		const state = el.createSpan({ cls: 'pecklist-mgr-state' });
		setIcon(state, STATE[row.state].icon);
		setTooltip(state, row.reason ?? STATE[row.state].label);

		const main = el.createDiv({ cls: 'pecklist-mgr-main' });
		const title = main.createDiv({ cls: 'pecklist-mgr-title', text: row.title });
		title.addEventListener('click', () => this.openRow(row));
		const meta = main.createDiv({ cls: 'pecklist-mgr-meta' });
		const parts: string[] = [row.listName];
		if (row.start) parts.push(`Starts ${shortDate(row.start)}`);
		if (row.due) parts.push(`Due ${shortDate(row.due)}`);
		if (row.tags.length > 0) parts.push(row.tags.map((t) => `#${t}`).join(' '));
		meta.createSpan({ text: parts.join(' · ') });
		if (row.path) {
			const note = meta.createSpan({ cls: 'pecklist-mgr-note' });
			setIcon(note.createSpan({ cls: 'pecklist-mgr-note-icon' }), 'file-text');
			note.createSpan({ text: noteName(row.path) });
			setTooltip(note, row.path);
		}
		if (row.reason && (row.state === 'attention' || row.state === 'changed' || row.state === 'unknown')) {
			main.createDiv({ cls: 'pecklist-mgr-reason', text: row.reason });
		}

		this.iconButton(el, 'more-horizontal', 'Actions', (e) => this.rowMenu(row, e));
		el.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.rowMenu(row, e);
		});
	}

	private renderBulk(): void {
		const n = this.selected.size;
		this.bulkCountEl.setText(`${n} selected`);
		this.toolbarEl.toggle(n === 0);
		this.bulkEl.toggle(n > 0);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, run: (e: MouseEvent) => void): HTMLElement {
		const b = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
		setIcon(b, icon);
		b.addEventListener('click', (e) => run(e));
		return b;
	}

	// --- One row ---

	private openRow(row: OverviewRow): void {
		if (row.kind === 'line' && row.path !== null) void this.goToLine(row.path, row.lineNo ?? 0);
		else if (row.id) this.plugin.openInPeckList(row.id);
	}

	private async goToLine(path: string, lineNo: number): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		this.close();
		await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: lineNo }, active: true });
	}

	private rowMenu(row: OverviewRow, event: MouseEvent): void {
		const menu = new Menu();
		const item = (title: string, icon: string, run: () => void, warning = false): void => {
			menu.addItem((i) => {
				i.setTitle(title).setIcon(icon).onClick(run);
				if (warning) i.setWarning(true);
			});
		};
		if (row.kind === 'line') {
			const path = row.path as string;
			item('Go to the line', 'file-text', () => void this.goToLine(path, row.lineNo ?? 0));
			if (row.id) item('Open in PeckList', 'external-link', () => this.plugin.openInPeckList(row.id as string));
			if (row.state !== 'off' && row.state !== 'excluded') {
				menu.addSeparator();
				if (row.status === 'open') {
					item('Complete', 'check-circle', () => void this.editLine(row, (t) => closeTaskLines(t, 'done', localDate(null), (l) => this.plugin.menuHooks(path).toggleDone(l))));
					item("Won't do", 'circle-slash', () => void this.editLine(row, (t) => closeTaskLines(t, 'wontdo', localDate(null), (l) => this.plugin.menuHooks(path).toggleDone(l))));
				} else {
					item('Reopen', 'rotate-ccw', () => void this.editLine(row, (t) => reopenTaskLine(t)));
				}
				item('Move to list...', 'list', () => this.pickList((tag) => void this.editLine(row, (t) => moveTaskLine(t, tag))));
				item('Edit tags...', 'tags', () =>
					new TagsModal(this.app, 'Tags', row.tags, (tags) => void this.editLine(row, (t) => editTagsLine(t, tags, row.tags.filter((x) => !tags.some((y) => y.toLowerCase() === x.toLowerCase()))))).open(),
				);
			}
			menu.addSeparator();
			if (row.state === 'attention' && row.reason?.startsWith('A copy')) {
				item('Make it a task of its own', 'copy-plus', () => void this.engineLine(row, (e) => e.splitLine(path, row.lineNo as number, row.text as string)));
			}
			if (row.state !== 'off' && row.state !== 'excluded') {
				item(row.id ? 'Link to another task...' : 'Link to an existing task...', 'link', () =>
					this.pickRemoteTask((task) => void this.engineLine(row, (e) => e.relinkLine(path, row.lineNo as number, row.text as string, task.id))),
				);
			}
			if (row.id) item('Unlink (the task stays in PeckList)', 'unlink', () => void this.engineLine(row, (e) => e.unlinkLine(path, row.lineNo as number, row.text as string)));
			if (row.state === 'off') {
				item('Include in sync', 'eye', () => void this.engineLine(row, (e) => e.setLineOff(path, row.lineNo as number, false)));
			} else if (row.state !== 'excluded') {
				item('Leave out of sync', 'eye-off', () => void this.engineLine(row, (e) => e.leaveOutLine(path, row.lineNo as number, row.text as string)));
			}
			if (row.id) item('Delete the line and the task', 'trash-2', () => void this.editLine(row, () => null, true), true);
		} else if (row.kind === 'missing') {
			const id = row.id as string;
			item('Open in PeckList', 'external-link', () => this.plugin.openInPeckList(id));
			if (row.path && this.app.vault.getFileByPath(row.path)) {
				item('Add it back to its note', 'file-plus', () => void this.engineRun(row.path, (e) => e.addToNote(row.path as string, id)));
			}
			item('Forget the link (the task stays in PeckList)', 'unlink', () => void this.engineRun(null, async (e) => (await e.forgetLinks([id]), true)));
			item("Move the task to PeckList's trash", 'trash-2', () => void this.remoteRun(async (client) => (await client.deleteTask(id), true)), true);
		} else {
			const task = row.task as ApiTask;
			item('Open in PeckList', 'external-link', () => this.plugin.openInPeckList(task.id));
			item('Add to a note...', 'file-plus', () => new NoteModal(this.app, (file) => void this.engineRun(file.path, (e) => e.addToNote(file.path, task.id))).open());
			menu.addSeparator();
			item('Complete', 'check-circle', () => void this.remoteRun(async (c) => (await c.complete(task.id, 'done'), true)));
			item("Won't do", 'circle-slash', () => void this.remoteRun(async (c) => (await c.complete(task.id, 'wontdo'), true)));
			item('Move to list...', 'list', () =>
				this.pickList((tag) => {
					const listId = this.listIdForTag(tag);
					if (listId) void this.remoteRun(async (c) => (await c.updateTask(task.id, { listId }), true));
				}),
			);
			item('Edit tags...', 'tags', () =>
				new TagsModal(this.app, 'Tags', task.tags, (tags) => void this.remoteRun(async (c) => (await c.updateTask(task.id, { tags }), true))).open(),
			);
			menu.addSeparator();
			item("Move to PeckList's trash", 'trash-2', () => void this.remoteRun(async (c) => (await c.deleteTask(task.id), true)), true);
		}
		menu.showAtMouseEvent(event);
	}

	// --- Doing things ---

	/** Edits a line in its note (null from `change`: delete it), then syncs. */
	private async editLine(row: OverviewRow, change: (text: string) => string | null, deleting = false): Promise<void> {
		if (row.kind !== 'line' || row.path === null || row.text === null || row.lineNo === null) return;
		const next = change(row.text);
		if (!deleting && (next === null || next === row.text)) return;
		await this.run(async () => {
			const ok = await this.plugin.lines.replace(row.path as string, row.lineNo as number, row.text as string, deleting ? null : next);
			if (!ok) throw new Error('that line changed meanwhile. Try again.');
			await this.plugin.afterLineEdit(row.path as string, deleting);
		});
	}

	private async engineLine(row: OverviewRow, work: (engine: SyncEngine) => Promise<boolean>): Promise<void> {
		await this.engineRun(row.path, work);
	}

	/** Runs an engine action, then saves the note it changed (when open) and syncs. */
	private async engineRun(path: string | null, work: (engine: SyncEngine) => Promise<boolean>): Promise<void> {
		await this.run(async () => {
			const ok = await this.plugin.withEngine((engine) => work(engine));
			if (ok === null) return;
			if (!ok) throw new Error('that line changed meanwhile. Try again.');
			if (path) {
				this.plugin.lines.forget(path);
				await this.plugin.afterLineEdit(path, false);
			} else await this.plugin.sync('change');
			// A task unlinked or swapped out is now only in PeckList (and one added is no longer).
		}, true);
	}

	/** A change to a task only in PeckList, through the Task API. */
	private async remoteRun(work: (client: PeckListClient) => Promise<boolean>): Promise<void> {
		await this.run(async () => {
			await this.plugin.withEngine((_engine, client) => work(client));
		}, true);
	}

	private async run(work: () => Promise<void>, reloadRemote = false): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.modalEl.addClass('is-busy');
		try {
			await work();
		} catch (e) {
			new Notice(`PeckList: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busy = false;
			this.modalEl.removeClass('is-busy');
		}
		await this.reload(reloadRemote);
	}

	// --- Several rows ---

	private selectedRows(): OverviewRow[] {
		return this.rows.filter((r) => this.selected.has(r.key) && r.kind !== 'missing');
	}

	/** Line edits for several rows, note by note, then one sync. */
	private async bulkLines(change: (row: OverviewRow) => ((text: string) => string | null) | null, remote: ((row: OverviewRow) => Promise<unknown>) | null): Promise<void> {
		const rows = this.selectedRows();
		await this.run(async () => {
			let failed = 0;
			const paths = new Set<string>();
			for (const row of rows) {
				if (row.kind === 'line' && row.path !== null && row.text !== null && row.lineNo !== null) {
					const edit = change(row);
					const next = edit ? edit(row.text) : null;
					if (next === null || next === row.text) continue;
					if (await this.plugin.lines.replace(row.path, row.lineNo, row.text, next)) paths.add(row.path);
					else failed++;
				} else if (row.kind === 'remote' && remote) {
					await this.plugin.withEngine(async () => {
						await remote(row);
						return true;
					});
				}
			}
			for (const path of paths) await this.plugin.afterLineEdit(path, false);
			if (paths.size === 0) await this.plugin.sync('change');
			if (failed > 0) new Notice(`PeckList: ${failed} ${failed === 1 ? 'line' : 'lines'} changed meanwhile and were left as they are.`);
			this.selected.clear();
		}, rows.some((r) => r.kind === 'remote'));
	}

	private bulkMove(): void {
		this.pickList((tag) => {
			const listId = this.listIdForTag(tag);
			void this.bulkLines(
				() => (t) => moveTaskLine(t, tag),
				async (row) => {
					const client = this.plugin.client();
					if (client && listId) await client.updateTask(row.id as string, { listId });
				},
			);
		});
	}

	private bulkTags(mode: 'add' | 'remove'): void {
		new TagsModal(this.app, mode === 'add' ? 'Add tags' : 'Remove tags', [], (tags) => {
			void this.bulkLines(
				() => (t) => (mode === 'add' ? editTagsLine(t, tags, []) : editTagsLine(t, [], tags)),
				async (row) => {
					const client = this.plugin.client();
					if (client) await client.updateTask(row.id as string, mode === 'add' ? { addTags: tags } : { removeTags: tags });
				},
			);
		}).open();
	}

	private async bulkComplete(): Promise<void> {
		await this.bulkLines(
			(row) => (row.status === 'open' && row.state !== 'off' && row.state !== 'excluded' ? (t) => closeTaskLines(t, 'done', localDate(null), (l) => this.plugin.menuHooks(row.path).toggleDone(l)) : null),
			async (row) => {
				const client = this.plugin.client();
				if (client && row.status === 'open') await client.complete(row.id as string, 'done');
			},
		);
	}

	private async bulkLeaveOut(): Promise<void> {
		const rows = this.selectedRows().filter((r) => r.kind === 'line' && r.state !== 'off' && r.state !== 'excluded');
		await this.run(async () => {
			const paths = new Set<string>();
			await this.plugin.withEngine(async (engine) => {
				for (const row of rows) if (await engine.leaveOutLine(row.path as string, row.lineNo as number, row.text as string)) paths.add(row.path as string);
				return true;
			});
			for (const path of paths) {
				this.plugin.lines.forget(path);
				await this.plugin.afterLineEdit(path, false);
			}
			this.selected.clear();
		});
	}

	// --- Pickers ---

	private pickList(chosen: (tag: string) => void): void {
		new MoveToListModal(this.app, this.plugin.catalog(), chosen).open();
	}

	private listIdForTag(tag: string): string | null {
		if (tag === ROOT_TAG) return (this.lists.find((l) => l.id === this.plugin.settings.defaultListId) ?? this.lists.find((l) => l.isInbox))?.id ?? null;
		return this.lists.find((l) => tagForList(l.name) === tag)?.id ?? null;
	}

	private pickRemoteTask(chosen: (task: ApiTask) => void): void {
		const tasks = this.rows.filter((r) => r.kind === 'remote' && r.task).map((r) => ({ task: r.task as ApiTask, list: r.listName }));
		if (this.remote !== 'loaded') {
			new Notice('PeckList: the tasks only in PeckList could not be loaded. Sync, then try again.');
			return;
		}
		if (tasks.length === 0) {
			new Notice('PeckList: every open task in PeckList is already linked to a line.');
			return;
		}
		new TaskPickModal(this.app, tasks, chosen).open();
	}
}

function shortDate(date: string): string {
	const d = new Date(`${date.slice(0, 10)}T00:00:00`);
	if (Number.isNaN(d.getTime())) return date;
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function noteName(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.md$/u, '');
}

class TaskPickModal extends FuzzySuggestModal<{ task: ApiTask; list: string }> {
	constructor(
		app: App,
		private readonly tasks: { task: ApiTask; list: string }[],
		private readonly chosen: (task: ApiTask) => void,
	) {
		super(app);
		this.setPlaceholder('Link to which PeckList task?');
	}

	getItems(): { task: ApiTask; list: string }[] {
		return this.tasks;
	}

	getItemText(item: { task: ApiTask; list: string }): string {
		return `${item.task.title} (${item.list})`;
	}

	onChooseItem(item: { task: ApiTask; list: string }): void {
		this.chosen(item.task);
	}
}

class NoteModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly chosen: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Add the task to the end of which note?');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path.replace(/\.md$/u, '');
	}

	onChooseItem(file: TFile): void {
		this.chosen(file);
	}
}

/** Tags typed with or without `#`, separated by spaces or commas. */
class TagsModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly initial: string[],
		private readonly done: (tags: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'pecklist-tags-input', attr: { placeholder: 'Tags, such as #errands #weekend', 'aria-label': 'Tags' } });
		input.value = this.initial.map((t) => `#${t}`).join(' ');
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const save = buttons.createEl('button', { text: 'Save', cls: 'mod-cta' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		const submit = (): void => {
			const tags = input.value
				.split(/[\s,]+/u)
				.map((t) => t.replace(/^#/u, '').trim())
				.filter((t) => t && /[^\d/]/u.test(t));
			this.close();
			this.done(tags);
		};
		save.addEventListener('click', submit);
		cancel.addEventListener('click', () => this.close());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
