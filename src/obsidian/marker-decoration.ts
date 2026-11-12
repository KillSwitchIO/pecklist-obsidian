// In Live Preview, the hidden link `%%[pecklist:: <id>]%%` shows as a small bird icon instead of
// the raw comment. Putting the cursor on it shows the text again, so it can still be edited or
// deleted. Clicking the icon opens the task in PeckList; right-clicking it opens the task menu
// (src/ui/task-menu.ts). Source mode shows the text as written.
//
// On task lines that sync, tags get classes too (Live Preview and source mode): the `#` of a
// PeckList list tag gets `pecklist-list-tag` and every tag sent to PeckList gets
// `pecklist-sent-tag`. styles.css draws them with the theme's own colors.

import type { Extension, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { editorLivePreviewField, setIcon, setTooltip } from 'obsidian';
import type { TaskLineHandle } from '../ui/task-menu';
import { isPeckListTag } from '../core/lists';
import { parseLine, statusOf } from '../core/line';

const MARKER = /%%\[pecklist::\s*([0-9A-Za-z_-]+)\s*\]%%/gu;
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s/u;
const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const LIST_TAG = Decoration.mark({ class: 'pecklist-list-tag' });
const SENT_TAG = Decoration.mark({ class: 'pecklist-sent-tag' });

export interface MarkerActions {
	/** Opens the task in PeckList. */
	open(id: string): void;
	/** Shows the task menu for a linked line. */
	menu(id: string, event: MouseEvent, line: TaskLineHandle): void;
	/** Called after the menu changed or deleted the task's line in the editor. */
	changed(view: EditorView, deleted: boolean): void;
	/** Whether a tag (without `#`) on a syncing line is sent to PeckList as a tag. */
	sent(tag: string): boolean;
}

/**
 * The widget's line as it is now. Replacing it later checks the line still reads the same, so an
 * edit made while the menu was open is never overwritten. Undo brings the old line back.
 */
function lineHandle(view: EditorView, el: HTMLElement, changed: (deleted: boolean) => void): TaskLineHandle | null {
	let pos: number;
	try {
		pos = view.posAtDOM(el);
	} catch {
		return null;
	}
	const { number, text } = view.state.doc.lineAt(pos);
	return {
		text,
		replace(next: string | null): void {
			const doc = view.state.doc;
			if (number > doc.lines) return;
			const line = doc.line(number);
			if (line.text !== text) return;
			if (next !== null) {
				view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
			} else {
				const last = number === doc.lines;
				view.dispatch({ changes: { from: last ? Math.max(0, line.from - 1) : line.from, to: last ? line.to : line.to + 1 } });
			}
			changed(next === null);
		},
	};
}

class MarkerWidget extends WidgetType {
	constructor(
		private readonly id: string,
		private readonly actions: MarkerActions,
	) {
		super();
	}

	eq(other: MarkerWidget): boolean {
		return other.id === this.id;
	}

	toDOM(view: EditorView): HTMLElement {
		const off = this.id === 'off';
		const el = createSpan({ cls: off ? 'pecklist-marker is-off' : 'pecklist-marker' });
		setIcon(el, off ? 'eye-off' : 'bird');
		setTooltip(el, off ? 'Left out of PeckList sync' : 'Linked to PeckList: select to open the task');
		if (!off) {
			el.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.button === 0) this.actions.open(this.id);
			});
			el.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const handle = lineHandle(view, el, (deleted) => this.actions.changed(view, deleted));
				if (handle) this.actions.menu(this.id, e, handle);
			});
		}
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function build(view: EditorView, actions: MarkerActions): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	const live = view.state.field(editorLivePreviewField, false);
	const selection = view.state.selection.ranges;
	const doc = view.state.doc;
	for (const { from, to } of view.visibleRanges) {
		for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
			const line = doc.line(n);
			if (!TASK_LINE.test(line.text)) continue;
			const markers = [...line.text.matchAll(MARKER)];
			if (live) {
				for (const m of markers) {
					const start = line.from + (m.index ?? 0);
					const end = start + m[0].length;
					// The cursor on the marker shows its text.
					if (selection.some((r) => r.from <= end && r.to >= start)) continue;
					ranges.push(Decoration.replace({ widget: new MarkerWidget(m[1] ?? '', actions) }).range(start, end));
				}
			}
			markTags(line.from, line.text, actions, ranges);
		}
	}
	return Decoration.set(ranges, true);
}

/** Classes for the tags of a line that syncs: one with a list tag or a link, and not left out. */
/**
 * Whether a task line syncs: it has a link that isn't "off", or it's an open line with a list
 * tag (it becomes a new task). Closed lines without a link are never sent.
 */
export function lineSyncs(text: string): boolean {
	if (!TASK_LINE.test(text)) return false;
	const markers = [...text.matchAll(MARKER)];
	if (markers.some((m) => m[1] === 'off')) return false;
	if (markers.length > 0) return true;
	const parsed = parseLine(text);
	return !!parsed && statusOf(parsed) === 'open' && [...text.matchAll(TAG)].some((t) => isPeckListTag(t[2] ?? ''));
}

function markTags(lineStart: number, text: string, actions: MarkerActions, ranges: Range<Decoration>[]): void {
	if (!lineSyncs(text)) return;
	for (const t of text.matchAll(TAG)) {
		const name = t[2] ?? '';
		// A tag needs at least one character that isn't a digit.
		if (!/[^\d/]/u.test(name)) continue;
		const hash = lineStart + (t.index ?? 0) + (t[1] ?? '').length;
		if (isPeckListTag(name)) ranges.push(LIST_TAG.range(hash, hash + 1));
		else if (actions.sent(name)) ranges.push(SENT_TAG.range(hash, hash + 1 + name.length));
	}
}

export function markerDecoration(actions: MarkerActions): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view, actions);
			}
			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged || update.selectionSet || update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)) {
					this.decorations = build(update.view, actions);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
}
