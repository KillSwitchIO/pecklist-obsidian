// Reading view and Tasks queries: the same marks as Live Preview. Tags on lines that sync get
// their classes, and a linked line gets its bird (click: open the task, right-click: the task
// menu).
//
// Two kinds of element come through Obsidian's post-processor:
// - A section of a note in reading view: its task items carry `data-line`, so each item's own
//   line is known from the section's source.
// - A task's description as the Tasks plugin draws it, in a query or in reading view: a bare
//   <span> rendered for the task's own note (ctx.sourcePath) with no section. The hidden id isn't
//   in the drawn text, so the description is matched to its line among that note's lines.

import { type MarkdownPostProcessorContext, Notice } from 'obsidian';
import { isPeckListTag } from '../core/lists';
import { findDrawnLine } from '../core/plain-text';
import type { ScannedLine } from '../sync/scan';
import type { TaskLineHandle } from '../ui/task-menu';
import { createMarker, lineSyncs } from './marker-decoration';
import type { VaultLines } from './vault-lines';

export interface ReadingActions {
	/** Whether a tag (without `#`) on a syncing line is sent to PeckList as a tag. */
	sent(tag: string): boolean;
	open(id: string): void;
	menu(id: string, event: MouseEvent, path: string, line: TaskLineHandle): void;
	/** After the menu changed (or deleted) a line in a note. */
	changed(path: string, deleted: boolean): void;
}

const tagName = (a: Element): string => (a.getAttribute('href') ?? a.textContent ?? '').replace(/^#/u, '');

export class ReadingMarks {
	constructor(
		private readonly lines: VaultLines,
		private readonly actions: ReadingActions,
	) {}

	process(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const section = ctx.getSectionInfo(el);
		if (!section && el.tagName === 'SPAN' && ctx.sourcePath) {
			void this.markDrawnTask(el, ctx.sourcePath);
			return;
		}
		this.markSection(el, ctx);
	}

	/** A description drawn by the Tasks plugin. */
	private async markDrawnTask(span: HTMLElement, path: string): Promise<void> {
		const drawn = span.textContent ?? '';
		if (!drawn.trim()) return;
		const found = findDrawnLine(await this.lines.lines(path), drawn);
		if (!found) return;
		this.markTags(Array.from(span.querySelectorAll('a.tag')), found.text);
		if ((found.id || found.off) && !span.querySelector('.pecklist-marker')) span.append(this.marker(found, path));
	}

	/** A section of a note in reading view. */
	private markSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const mark = (): void => {
			const section = ctx.getSectionInfo(el);
			const source = section?.text.split(/\r?\n/u);
			el.querySelectorAll('li.task-list-item').forEach((item) => {
				// Items the Tasks plugin draws get their marks from their description (above).
				if (item.classList.contains('plugin-tasks-list-item')) return;
				const attr = item.getAttribute('data-line');
				if (section && attr === null) return;
				const lineNo = section && attr !== null ? section.lineStart + Number(attr) : null;
				const text = lineNo !== null && source ? source[lineNo] : undefined;
				// Only the item's own tags, not those of nested items.
				const tags = Array.from(item.querySelectorAll('a.tag')).filter((a) => a.closest('li') === item);
				if (text === undefined) {
					this.markTags(tags, null);
					return;
				}
				this.markTags(tags, text);
				void this.addSectionMarker(item as HTMLElement, ctx.sourcePath, lineNo as number, text);
			});
		};
		mark();
		// The Tasks plugin draws task items again after this runs; mark the new ones too.
		const observer = new MutationObserver(() => mark());
		observer.observe(el, { childList: true, subtree: true });
		window.setTimeout(() => observer.disconnect(), 3000);
	}

	private async addSectionMarker(item: HTMLElement, path: string, lineNo: number, text: string): Promise<void> {
		if (item.querySelector(':scope > .pecklist-marker')) return;
		const found = (await this.lines.lines(path)).find((l) => l.lineNo === lineNo && l.text === text);
		if (!found || (!found.id && !found.off)) return;
		if (item.querySelector(':scope > .pecklist-marker') || item.classList.contains('plugin-tasks-list-item')) return;
		// Before any nested list, so it sits at the end of the item's own text.
		const nested = Array.from(item.children).find((c) => c.tagName === 'UL' || c.tagName === 'OL');
		const marker = this.marker(found, path);
		if (nested) item.insertBefore(marker, nested);
		else item.append(marker);
	}

	/**
	 * Sets or clears the classes, so a later pass corrects an earlier one. With no line text known,
	 * a list tag on the item is taken to mean it syncs.
	 */
	private markTags(tags: Element[], lineText: string | null): void {
		const syncs = lineText !== null ? lineSyncs(lineText) : tags.some((a) => isPeckListTag(tagName(a)));
		for (const a of tags) {
			const name = tagName(a);
			a.toggleClass('pecklist-list-tag', syncs && isPeckListTag(name));
			a.toggleClass('pecklist-sent-tag', syncs && !isPeckListTag(name) && this.actions.sent(name));
		}
	}

	private marker(found: ScannedLine, path: string): HTMLElement {
		const id = found.id ?? 'off';
		const handle: TaskLineHandle = {
			text: found.text,
			replace: (next) => {
				void this.lines.replace(path, found.lineNo, found.text, next).then((ok) => {
					if (ok) this.actions.changed(path, next === null);
					else new Notice('PeckList: that line changed meanwhile. Try again.');
				});
			},
		};
		return createMarker(id, {
			open: () => this.actions.open(id),
			menu: (event) => this.actions.menu(id, event, path, handle),
		});
	}
}
