import { describe, expect, it } from 'vitest';
import { closeTaskLines, moveTaskLine, reopenTaskLine } from '../src/core/task-actions';

const ID = '%%[pecklist:: 01ABC]%%';
const none = (): string | null => null;

describe('task menu line edits', () => {
	it('completes and marks won\'t do with today\'s date', () => {
		const line = `- [ ] Call the plumber ${ID} #task #pecklist 📅 2026-11-13`;
		expect(closeTaskLines(line, 'done', '2026-11-11', none)).toBe(`- [x] Call the plumber ${ID} #task #pecklist 📅 2026-11-13 ✅ 2026-11-11`);
		expect(closeTaskLines(line, 'wontdo', '2026-11-11', none)).toBe(`- [-] Call the plumber ${ID} #task #pecklist 📅 2026-11-13 ❌ 2026-11-11`);
	});

	it('leaves a closed line alone', () => {
		expect(closeTaskLines('- [x] Done #pecklist ✅ 2026-11-10', 'done', '2026-11-11', none)).toBeNull();
	});

	it('lets the Tasks plugin write a repeating task, and turns its closed copy into won\'t do', () => {
		const line = `- [ ] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-14`;
		const tasks = (): string => `- [ ] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-21\n- [x] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-14 ✅ 2026-11-11`;
		expect(closeTaskLines(line, 'done', '2026-11-11', tasks)).toBe(tasks());
		expect(closeTaskLines(line, 'wontdo', '2026-11-11', tasks)).toBe(
			`- [ ] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-21\n- [-] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-14 ❌ 2026-11-11`,
		);
	});

	it('closes a repeating task in place when the Tasks plugin is missing', () => {
		const line = `- [ ] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-14`;
		expect(closeTaskLines(line, 'done', '2026-11-11', none)).toBe(`- [x] Mow ${ID} #pecklist 🔁 every week 📅 2026-11-14 ✅ 2026-11-11`);
	});

	it('reopens a closed line and drops its date', () => {
		expect(reopenTaskLine(`- [-] Call ${ID} #pecklist ❌ 2026-11-11`)).toBe(`- [ ] Call ${ID} #pecklist`);
		expect(reopenTaskLine(`- [ ] Call ${ID} #pecklist`)).toBeNull();
	});

	it('moves to another list by swapping the list tag', () => {
		expect(moveTaskLine(`- [ ] Buy filters ${ID} #task #pecklist/Home-Projects ⏫`, 'pecklist/Work')).toBe(`- [ ] Buy filters ${ID} #task #pecklist/Work ⏫`);
		expect(moveTaskLine(`- [ ] Buy filters ${ID} #task #pecklist/Work`, 'pecklist')).toBe(`- [ ] Buy filters ${ID} #task #pecklist`);
	});
});
