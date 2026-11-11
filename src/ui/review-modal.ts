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

// A linked line is left out with its note or folder, or by taking its tag off (which trashes
// the task), not here.
const SELECTABLE = new Set(['new', 'off']);

export class ReviewModal extends Modal {
	private readonly folderOn = new Map<string, boolean>();
	private readonly noteOn = new Map<string, boolean>();
	private readonly lineOn = new Map<string, boolean>();
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
		const tree = contentEl.createDiv({ cls: 'pecklist-review-tree' });
		if (byFolder.size === 0) {
			tree.createEl('p', { text: 'No lines are tagged #pecklist yet. Add the tag to a task line, then sync.' });
		}
		for (const folder of [...byFolder.keys()].sort()) this.renderFolder(tree, folder, byFolder.get(folder) ?? []);

		this.updateSummary();

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
		const byAncestor = notes.every((n) => n.excluded === 'folder') && !this.folderExcludedExactly(folder);
		const startOn = !notes.every((n) => n.excluded === 'folder');
		this.folderOn.set(folder, startOn);

		const details = parent.createEl('details', { cls: 'pecklist-review-folder' });
		details.open = true;
		const summary = details.createEl('summary');
		const box = summary.createEl('input', { type: 'checkbox' });
		box.checked = startOn;
		box.disabled = byAncestor;
		summary.createSpan({ text: ` ${folder || 'Vault root'}` });
		if (byAncestor) summary.createSpan({ cls: 'pecklist-review-note', text: ' (left out by a parent folder in settings)' });

		const body = details.createDiv({ cls: 'pecklist-review-folder-body' });
		const noteBoxes: HTMLInputElement[] = [];
		for (const note of notes.sort((a, b) => a.path.localeCompare(b.path))) noteBoxes.push(this.renderNote(body, note));
		box.addEventListener('click', (e) => e.stopPropagation());
		box.addEventListener('change', () => {
			this.folderOn.set(folder, box.checked);
			for (const nb of noteBoxes) nb.disabled = !box.checked;
			this.updateSummary();
		});
		for (const nb of noteBoxes) nb.disabled = !startOn;
	}

	private renderNote(parent: HTMLElement, note: PreviewNote): HTMLInputElement {
		const startOn = note.excluded !== 'note';
		this.noteOn.set(note.path, startOn);
		const wrap = parent.createDiv({ cls: 'pecklist-review-note-row' });
		const head = wrap.createEl('label', { cls: 'pecklist-review-note-head' });
		const box = head.createEl('input', { type: 'checkbox' });
		box.checked = startOn;
		const name = note.path.split('/').pop() ?? note.path;
		head.createSpan({ text: ` ${name.replace(/\.md$/u, '')}` });

		const lines = wrap.createDiv({ cls: 'pecklist-review-lines' });
		for (const line of note.lines) this.renderLine(lines, line);
		box.addEventListener('change', () => {
			this.noteOn.set(note.path, box.checked);
			this.updateSummary();
		});
		return box;
	}

	private renderLine(parent: HTMLElement, line: PreviewLine): void {
		const key = `${line.path}\n${line.lineNo}`;
		const row = parent.createEl('label', { cls: 'pecklist-review-line' });
		const box = row.createEl('input', { type: 'checkbox' });
		const selectable = SELECTABLE.has(line.state);
		box.checked = line.state === 'new' || line.state === 'linked';
		box.disabled = !selectable;
		if (selectable) this.lineOn.set(key, box.checked);
		row.createSpan({ text: ` ${line.title || '(no title)'}` });
		const tag = row.createSpan({ cls: 'pecklist-review-badge' });
		tag.setText(this.badge(line));
		box.addEventListener('change', () => {
			this.lineOn.set(key, box.checked);
			this.updateSummary();
		});
	}

	private badge(line: PreviewLine): string {
		switch (line.state) {
			case 'new':
				return line.listIsNew ? `new task in ${line.listName} (new list)` : `new task in ${line.listName}`;
			case 'linked':
				return 'already linked';
			case 'closed':
				return 'done, not sent';
			case 'untitled':
				return 'no title, not sent';
			case 'off':
				return 'left out';
		}
	}

	private included(line: PreviewLine, note: PreviewNote): boolean {
		const folderOn = this.folderOn.get(folderOf(note.path)) ?? true;
		const noteOn = this.noteOn.get(note.path) ?? true;
		const lineOn = line.state === 'linked' || (this.lineOn.get(`${line.path}\n${line.lineNo}`) ?? false);
		return folderOn && noteOn && lineOn;
	}

	private updateSummary(): void {
		if (!this.summaryEl) return;
		let create = 0;
		let linked = 0;
		let closed = 0;
		const lists = new Set<string>();
		const newLists = new Set<string>();
		const notes = new Set<string>();
		for (const note of this.preview.notes) {
			for (const line of note.lines) {
				if (line.state === 'closed') closed++;
				if (!this.included(line, note)) continue;
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
		if (closed > 0) items.createEl('li', { text: `${closed} done ${closed === 1 ? 'line is' : 'lines are'} not sent.` });
		items.createEl('li', { text: `Lines tagged #pecklist alone go to ${this.preview.defaultListName ?? 'your inbox'}.` });
		items.createEl('li', { text: 'After this, changes sync both ways: titles, dates, priority, tags, repeats and done.' });
	}

	private choice(): ReviewChoice {
		const choice: ReviewChoice = { excludeFolders: [], includeFolders: [], excludeNotes: [], includeNotes: [], lineOff: [], lineOn: [] };
		for (const [folder, on] of this.folderOn) {
			if (folder === '') {
				// The vault root can't be left out as a folder: leave out its notes instead.
				if (!on) for (const note of this.preview.notes) if (folderOf(note.path) === '') this.noteOn.set(note.path, false);
				continue;
			}
			const exact = this.folderExcludedExactly(folder);
			if (!on && !exact) choice.excludeFolders.push(folder);
			if (on && exact) choice.includeFolders.push(folder);
		}
		for (const note of this.preview.notes) {
			const on = this.noteOn.get(note.path) ?? true;
			const listed = this.options.excludedNotes.includes(note.path);
			if (!on && !listed) choice.excludeNotes.push(note.path);
			if (on && listed) choice.includeNotes.push(note.path);
			for (const line of note.lines) {
				const lineOn = this.lineOn.get(`${line.path}\n${line.lineNo}`);
				if (lineOn === undefined) continue;
				if (!lineOn && line.state !== 'off') choice.lineOff.push({ path: line.path, lineNo: line.lineNo });
				if (lineOn && line.state === 'off') choice.lineOn.push({ path: line.path, lineNo: line.lineNo });
			}
		}
		return choice;
	}
}
