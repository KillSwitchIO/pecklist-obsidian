// In Live Preview, the hidden link `%%[pecklist:: <id>]%%` shows as a small bird icon instead of
// the raw comment. Putting the cursor on it shows the text again, so it can still be edited or
// deleted. Clicking the icon opens the task in PeckList. Source mode shows the text as written.

import { type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { editorLivePreviewField, setIcon, setTooltip } from 'obsidian';

const MARKER = /%%\[pecklist::\s*([0-9A-Za-z_-]+)\s*\]%%/gu;

class MarkerWidget extends WidgetType {
	constructor(
		private readonly id: string,
		private readonly open: (id: string) => void,
	) {
		super();
	}

	eq(other: MarkerWidget): boolean {
		return other.id === this.id;
	}

	toDOM(): HTMLElement {
		const off = this.id === 'off';
		const el = createSpan({ cls: off ? 'pecklist-marker is-off' : 'pecklist-marker' });
		setIcon(el, off ? 'eye-off' : 'bird');
		setTooltip(el, off ? 'Left out of PeckList sync' : 'Linked to PeckList: select to open the task');
		if (!off) {
			el.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.open(this.id);
			});
		}
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function build(view: EditorView, open: (id: string) => void): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	if (!view.state.field(editorLivePreviewField, false)) return builder.finish();
	const selection = view.state.selection.ranges;
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		for (const m of text.matchAll(MARKER)) {
			const start = from + (m.index ?? 0);
			const end = start + m[0].length;
			// The cursor on the marker shows its text.
			if (selection.some((r) => r.from <= end && r.to >= start)) continue;
			builder.add(start, end, Decoration.replace({ widget: new MarkerWidget(m[1] ?? '', open) }));
		}
	}
	return builder.finish();
}

export function markerDecoration(open: (id: string) => void): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view, open);
			}
			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged || update.selectionSet || update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)) {
					this.decorations = build(update.view, open);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
}
