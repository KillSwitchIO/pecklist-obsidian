// The menu on a linked task's bird (right-click in Live Preview), with the actions PeckList's own
// task menu has that a note line can carry. Every action edits the line, so the next sync sends
// it like any other edit; undo in the note brings the line back.

import { type App, FuzzySuggestModal, Menu } from 'obsidian';
import { ROOT_TAG, tagForList } from '../core/lists';
import { parseLine, statusOf } from '../core/line';
import { closeTaskLines, moveTaskLine, reopenTaskLine } from '../core/task-actions';
import { localDate } from '../sync/values';
import type { Catalog } from './tag-suggest';

/** The task's line in the editor: its text now, and a way to replace (null: delete) it. */
export interface TaskLineHandle {
	text: string;
	replace(next: string | null): void;
}

export interface TaskMenuHooks {
	open(id: string): void;
	catalog(): Catalog;
	/** The Tasks plugin's "toggle done" for a line, which also starts a repeating task's next one. */
	toggleDone(line: string): string | null;
}

export function showTaskMenu(app: App, event: MouseEvent, id: string, handle: TaskLineHandle, hooks: TaskMenuHooks): void {
	const line = parseLine(handle.text);
	const status = line ? statusOf(line) : 'open';
	const today = localDate(null);
	const apply = (next: string | null): void => {
		if (next !== null && next !== handle.text) handle.replace(next);
	};
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle('Open in PeckList')
			.setIcon('external-link')
			.onClick(() => hooks.open(id)),
	);
	if (status === 'open') {
		menu.addItem((item) =>
			item
				.setTitle('Complete')
				.setIcon('check-circle')
				.onClick(() => apply(closeTaskLines(handle.text, 'done', today, (l) => hooks.toggleDone(l)))),
		);
		menu.addItem((item) =>
			item
				.setTitle("Won't do")
				.setIcon('circle-slash')
				.onClick(() => apply(closeTaskLines(handle.text, 'wontdo', today, (l) => hooks.toggleDone(l)))),
		);
	} else {
		menu.addItem((item) =>
			item
				.setTitle('Reopen')
				.setIcon('rotate-ccw')
				.onClick(() => apply(reopenTaskLine(handle.text))),
		);
	}
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle('Move to list...')
			.setIcon('list')
			.onClick(() => new MoveToListModal(app, hooks.catalog(), (tag) => apply(moveTaskLine(handle.text, tag))).open()),
	);
	menu.addItem((item) =>
		item
			.setTitle('Delete task')
			.setIcon('trash-2')
			.setWarning(true)
			.onClick(() => handle.replace(null)),
	);
	menu.showAtMouseEvent(event);
}

interface ListChoice {
	name: string;
	tag: string;
}

class MoveToListModal extends FuzzySuggestModal<ListChoice> {
	constructor(
		app: App,
		private readonly catalog: Catalog,
		private readonly chosen: (tag: string) => void,
	) {
		super(app);
		this.setPlaceholder('Move to list...');
	}

	getItems(): ListChoice[] {
		const lists = [...this.catalog.lists].sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ name: l.name, tag: tagForList(l.name) }));
		const fallback = this.catalog.defaultListName ? `${this.catalog.defaultListName} (default list)` : 'Default list';
		return [{ name: fallback, tag: ROOT_TAG }, ...lists];
	}

	getItemText(item: ListChoice): string {
		return item.name;
	}

	onChooseItem(item: ListChoice): void {
		this.chosen(item.tag);
	}
}
