// "Review what syncs": shown before the first sync on each device, and from the settings or the
// command palette at any time. It lists every PeckList line by folder and note, with a summary,
// and lets the person leave out folders, notes or single lines before anything is sent.

import { type App, Modal, Setting } from 'obsidian';
import type { Preview, PreviewLine, PreviewNote } from '../sync/engine';

export interface ReviewChoice {
	/** Folders to leave out (exact folder paths). */
	excludeFolders: string[];
	/** Folders that were left out and are now included again. */
	includeFolders: string[];
	excludeNotes: string[];
	includeNotes: string[];
	/** Lines to mark so they never sync. */
	lineOff: { path: string; lineNo: number }[];
	/** Lines marked off that are now included again. */
	lineOn: { path: string; lineNo: number }[];
}

interface Options {
	firstSync: boolean;
	excludedFolders: string[];
	excludedNotes: string[];
	onConfirm: (choice: ReviewChoice) => void | Promise<void>;
}

function folderOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function lineKey(line: PreviewLine): string {
	return `${line.path}\n${line.lineNo}`;
}

// A linked line is left out with its note or folder, or by taking its tag off (which trashes
// the task), not on its own.
const SELECTABLE = new Set(['new', 'off']);

interface FolderRow {
	folder: string;
	input: HTMLInputElement;
	/** Left out by a parent folder in the settings: can't be ticked here. */
	locked: boolean;
}

interface NoteRow {
	note: PreviewNote;
	input: HTMLInputElement;
}

interface LineRow {
	line: PreviewLine;
	note: PreviewNote;
	input: HTMLInputElement;
	badge: HTMLElement;
}

export class ReviewModal extends Modal {
	private readonly folderOn = new Map<string, boolean>();
	private readonly noteOn = new Map<string, boolean>();
	private readonly lineOn = new Map<string, boolean>();
	private readonly folderRows: FolderRow[] = [];
	private readonly noteRows: NoteRow[] = [];
	private readonly lineRows: LineRow[] = [];
	private summaryEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly preview: Preview,
		private readonly options: Options,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('pecklist-review');
		this.setTitle(this.options.firstSync ? 'Before the first sync' : 'What syncs with PeckList');

		this.summaryEl = contentEl.createDiv({ cls: 'pecklist-review-summary' });
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Only lines tagged #pecklist (or #pecklist/List) sync. Untick a folder, a note or a line to leave it out. Tasks that exist only in PeckList are not added to your notes.',
		});

		const byFolder = new Map<string, PreviewNote[]>();
		for (const note of this.preview.notes) {
			const folder = folderOf(note.path);
			const list = byFolder.get(folder) ?? [];
			list.push(note);
			byFolder.set(folder, list);
		}

		if (byFolder.size > 0) {
			const bulk = contentEl.createDiv({ cls: 'pecklist-review-bulk' });
			const all = bulk.createEl('button', { text: 'Select all' });
			const none = bulk.createEl('button', { text: 'Unselect all' });
			all.addEventListener('click', () => this.setAll(true));
			none.addEventListener('click', () => this.setAll(false));
		}

		const tree = contentEl.createDiv({ cls: 'pecklist-review-tree' });
		if (byFolder.size === 0) {
			tree.createEl('p', { text: 'No lines are tagged #pecklist yet. Add the tag to a task line, then sync.' });
		}
		for (const folder of [...byFolder.keys()].sort()) this.renderFolder(tree, folder, byFolder.get(folder) ?? []);

		this.refresh();

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.options.firstSync ? 'Start syncing' : 'Save')
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						await this.options.onConfirm(this.choice());
						this.close();
					}),
			)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private folderExcludedExactly(folder: string): boolean {
		return this.options.excludedFolders.some((f) => f === folder);
	}

	private renderFolder(parent: HTMLElement, folder: string, notes: PreviewNote[]): void {
		const leftOut = notes.every((n) => n.excluded === 'folder');
		const locked = leftOut && folder !== '' && !this.folderExcludedExactly(folder);
		this.folderOn.set(folder, !leftOut);

		const details = parent.createEl('details', { cls: 'pecklist-review-folder' });
		details.open = true;
		const summary = details.createEl('summary');
		const input = summary.createEl('input', { type: 'checkbox' });
		summary.createSpan({ text: ` ${folder || 'Vault root'}` });
		if (locked) summary.createSpan({ cls: 'pecklist-review-badge', text: 'left out by a parent folder in settings' });
		input.addEventListener('click', (e) => e.stopPropagation());
		input.addEventListener('change', () => {
			this.folderOn.set(folder, input.checked);
			this.refresh();
		});
		this.folderRows.push({ folder, input, locked });

		const body = details.createDiv({ cls: 'pecklist-review-folder-body' });
		for (const note of notes.sort((a, b) => a.path.localeCompare(b.path))) this.renderNote(body, note);
	}

	private renderNote(parent: HTMLElement, note: PreviewNote): void {
		this.noteOn.set(note.path, note.excluded !== 'note');
		const wrap = parent.createDiv({ cls: 'pecklist-review-note-row' });
		const head = wrap.createEl('label', { cls: 'pecklist-review-note-head' });
		const input = head.createEl('input', { type: 'checkbox' });
		const name = note.path.split('/').pop() ?? note.path;
		head.createSpan({ text: ` ${name.replace(/\.md$/u, '')}` });
		input.addEventListener('change', () => {
			this.noteOn.set(note.path, input.checked);
			this.refresh();
		});
		this.noteRows.push({ note, input });

		const lines = wrap.createDiv({ cls: 'pecklist-review-lines' });
		for (const line of note.lines) this.renderLine(lines, line, note);
	}

	private renderLine(parent: HTMLElement, line: PreviewLine, note: PreviewNote): void {
		const row = parent.createEl('label', { cls: 'pecklist-review-line' });
		const input = row.createEl('input', { type: 'checkbox' });
		if (SELECTABLE.has(line.state)) this.lineOn.set(lineKey(line), line.state === 'new');
		row.createSpan({ text: ` ${line.title || '(no title)'}` });
		const badge = row.createSpan({ cls: 'pecklist-review-badge' });
		input.addEventListener('change', () => {
			this.lineOn.set(lineKey(line), input.checked);
			this.refresh();
		});
		this.lineRows.push({ line, note, input, badge });
	}

	/** Shows every checkbox as what will happen: a left-out folder or note leaves its lines out too. */
	private refresh(): void {
		for (const r of this.folderRows) {
			r.input.checked = this.folderOn.get(r.folder) ?? true;
			r.input.disabled = r.locked;
		}
		for (const r of this.noteRows) {
			const folderOn = this.folderOn.get(folderOf(r.note.path)) ?? true;
			r.input.checked = folderOn && (this.noteOn.get(r.note.path) ?? true);
			r.input.disabled = !folderOn;
			r.input.parentElement?.toggleClass('is-left-out', !r.input.checked);
		}
		for (const r of this.lineRows) {
			const parentOn = this.parentOn(r.note);
			const selectable = SELECTABLE.has(r.line.state);
			const sendable = selectable || r.line.state === 'linked';
			if (selectable) {
				r.input.checked = parentOn && (this.lineOn.get(lineKey(r.line)) ?? false);
				r.input.disabled = !parentOn;
			} else {
				r.input.checked = parentOn && r.line.state === 'linked';
				r.input.disabled = true;
			}
			r.badge.setText(sendable && !parentOn ? 'left out with its note or folder' : this.badge(r.line, r.input.checked));
			r.input.parentElement?.toggleClass('is-left-out', !r.input.checked);
		}
		this.updateSummary();
	}

	private parentOn(note: PreviewNote): boolean {
		return (this.folderOn.get(folderOf(note.path)) ?? true) && (this.noteOn.get(note.path) ?? true);
	}

	/**
	 * Ticks or unticks every checkbox: folders, notes and lines. A linked line can't be unticked on
	 * its own, so unticking all leaves it out with its note, which forgets the link and keeps the
	 * task. A folder left out by a parent folder in the settings stays as it is.
	 */
	private setAll(on: boolean): void {
		for (const r of this.folderRows) if (!r.locked) this.folderOn.set(r.folder, on);
		for (const r of this.noteRows) this.noteOn.set(r.note.path, on);
		for (const key of this.lineOn.keys()) this.lineOn.set(key, on);
		this.refresh();
	}

	private badge(line: PreviewLine, on: boolean): string {
		switch (line.state) {
			case 'new':
			case 'off':
				if (!on) return 'left out';
				return line.listIsNew ? `new task in ${line.listName} (new list)` : `new task in ${line.listName}`;
			case 'linked':
				return 'already linked';
			case 'closed':
				return 'done, not sent';
			case 'untitled':
				return 'no title, not sent';
		}
	}

	private included(line: PreviewLine, note: PreviewNote): boolean {
		if (!this.parentOn(note)) return false;
		return line.state === 'linked' || (this.lineOn.get(lineKey(line)) ?? false);
	}

	private updateSummary(): void {
		if (!this.summaryEl) return;
		let create = 0;
		let linked = 0;
		let closed = 0;
		let leftOut = 0;
		let unlinked = 0;
		const lists = new Set<string>();
		const newLists = new Set<string>();
		const notes = new Set<string>();
		for (const note of this.preview.notes) {
			for (const line of note.lines) {
				if (line.state === 'closed') closed++;
				const sendable = SELECTABLE.has(line.state) || line.state === 'linked';
				if (!this.included(line, note)) {
					if (line.state === 'linked') unlinked++;
					else if (sendable) leftOut++;
					continue;
				}
				if (line.state === 'new' || line.state === 'off') {
					create++;
					lists.add(line.listName);
					if (line.listIsNew) newLists.add(line.listName);
					notes.add(note.path);
				} else if (line.state === 'linked') {
					linked++;
					notes.add(note.path);
				}
			}
		}
		const el = this.summaryEl;
		el.empty();
		const items = el.createEl('ul');
		items.createEl('li', { text: `${create} new ${create === 1 ? 'task' : 'tasks'} will be made in PeckList, from ${notes.size} ${notes.size === 1 ? 'note' : 'notes'}.` });
		if (linked > 0) items.createEl('li', { text: `${linked} already linked ${linked === 1 ? 'line keeps' : 'lines keep'} syncing.` });
		if (lists.size > 0) items.createEl('li', { text: `Lists: ${[...lists].sort().join(', ')}.` });
		if (newLists.size > 0) items.createEl('li', { text: `New lists to make: ${[...newLists].sort().join(', ')}.` });
		if (leftOut > 0) items.createEl('li', { text: `${leftOut} tagged ${leftOut === 1 ? 'line is' : 'lines are'} left out.` });
		if (unlinked > 0)
			items.createEl('li', { text: `${unlinked} linked ${unlinked === 1 ? 'line stops' : 'lines stop'} syncing. ${unlinked === 1 ? 'Its task stays' : 'Their tasks stay'} in PeckList.` });
		if (closed > 0) items.createEl('li', { text: `${closed} done ${closed === 1 ? 'line is' : 'lines are'} not sent.` });
		items.createEl('li', { text: `Lines tagged #pecklist alone go to ${this.preview.defaultListName ?? 'your inbox'}.` });
		items.createEl('li', { text: 'After this, changes sync both ways: titles, dates, priority, tags, repeats and done.' });
	}

	private choice(): ReviewChoice {
		const choice: ReviewChoice = { excludeFolders: [], includeFolders: [], excludeNotes: [], includeNotes: [], lineOff: [], lineOn: [] };
		const rootOff = this.folderOn.get('') === false;
		for (const [folder, on] of this.folderOn) {
			if (folder === '') continue;
			const exact = this.folderExcludedExactly(folder);
			if (!on && !exact) choice.excludeFolders.push(folder);
			if (on && exact) choice.includeFolders.push(folder);
		}
		for (const note of this.preview.notes) {
			// The vault root can't be left out as a folder: its notes are left out instead.
			const on = (this.noteOn.get(note.path) ?? true) && !(rootOff && folderOf(note.path) === '');
			const listed = this.options.excludedNotes.includes(note.path);
			if (!on && !listed) choice.excludeNotes.push(note.path);
			if (on && listed) choice.includeNotes.push(note.path);
			for (const line of note.lines) {
				const lineOn = this.lineOn.get(lineKey(line));
				if (lineOn === undefined) continue;
				if (!lineOn && line.state !== 'off') choice.lineOff.push({ path: line.path, lineNo: line.lineNo });
				if (lineOn && line.state === 'off') choice.lineOn.push({ path: line.path, lineNo: line.lineNo });
			}
		}
		return choice;
	}
}
