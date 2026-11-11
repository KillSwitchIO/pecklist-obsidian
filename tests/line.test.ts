import { describe, expect, it } from 'vitest';
import {
	fieldOf,
	parseLine,
	priorityOf,
	renderLine,
	statusOf,
	tagsOf,
	titleOf,
	withAddedTags,
	withField,
	withMarker,
	withPriority,
	withReplacedTag,
	withStatus,
	withTitle,
	withoutTags,
} from '../src/core/line';

function parse(text: string) {
	const line = parseLine(text);
	if (!line) throw new Error(`not a task line: ${text}`);
	return line;
}

describe('parseLine', () => {
	it('reads the Tasks fields from the end of the line', () => {
		const line = parse('- [ ] Mow the lawn #pecklist #yard ⏫ 🔁 every week on Saturday ⏳ 2026-11-14 📅 2026-11-15');
		expect(titleOf(line)).toBe('Mow the lawn');
		expect(tagsOf(line)).toEqual(['pecklist', 'yard']);
		expect(priorityOf(line)).toBe(3);
		expect(fieldOf(line, 'recurrence')).toBe('every week on Saturday');
		expect(fieldOf(line, 'scheduled')).toBe('2026-11-14');
		expect(fieldOf(line, 'due')).toBe('2026-11-15');
		expect(statusOf(line)).toBe('open');
	});

	it('round-trips a line it did not change', () => {
		const text = '  - [x] Call #bob about the car #pecklist/Work 🔼 📅 2026-11-12 ✅ 2026-11-11';
		expect(renderLine(parse(text))).toBe(text);
	});

	it('finds the marker anywhere and keeps fields readable after it', () => {
		const line = parse('- [ ] Pay rent %%[pecklist:: 01JC8R5K2Z4N6PX0M3WQ7HB9TA]%% #pecklist 📅 2026-12-01');
		expect(line.marker).toEqual({ kind: 'id', id: '01JC8R5K2Z4N6PX0M3WQ7HB9TA' });
		expect(fieldOf(line, 'due')).toBe('2026-12-01');
		expect(titleOf(line)).toBe('Pay rent');
	});

	it('writes the marker before the fields so the Tasks plugin still sees them', () => {
		const line = withMarker(parse('- [ ] Pay rent #pecklist 📅 2026-12-01'), { kind: 'id', id: 'ABC' });
		expect(renderLine(line)).toBe('- [ ] Pay rent %%[pecklist:: ABC]%% #pecklist 📅 2026-12-01');
	});

	it('reads the off mark', () => {
		expect(parse('- [ ] Secret %%[pecklist:: off]%% #pecklist').marker).toEqual({ kind: 'off' });
	});

	it('reads numbered lists, other bullets and custom statuses', () => {
		expect(statusOf(parse('1. [-] Dropped #pecklist'))).toBe('wontdo');
		expect(statusOf(parse('* [/] Halfway #pecklist'))).toBe('open');
		expect(statusOf(parse('+ [X] Done #pecklist'))).toBe('done');
	});

	it('is not fooled by things that are not task lines', () => {
		expect(parseLine('- not a task #pecklist')).toBeNull();
		expect(parseLine('[ ] no bullet')).toBeNull();
	});

	it('maps the five Tasks priorities onto PeckList\'s three', () => {
		expect(priorityOf(parse('- [ ] a 🔺'))).toBe(3);
		expect(priorityOf(parse('- [ ] a ⏫'))).toBe(3);
		expect(priorityOf(parse('- [ ] a 🔼'))).toBe(2);
		expect(priorityOf(parse('- [ ] a 🔽'))).toBe(1);
		expect(priorityOf(parse('- [ ] a ⏬'))).toBe(1);
		expect(priorityOf(parse('- [ ] a'))).toBe(0);
	});

	it('does not treat a number as a tag', () => {
		expect(tagsOf(parse('- [ ] issue #123 #pecklist'))).toEqual(['pecklist']);
	});
});

describe('edits', () => {
	const base = '- [ ] Mow #pecklist #yard 🔼 ⏳ 2026-11-14';

	it('sets, replaces and removes fields in the Tasks order', () => {
		let line = withField(parse(base), 'due', '2026-11-20');
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #yard 🔼 ⏳ 2026-11-14 📅 2026-11-20');
		line = withField(line, 'scheduled', '2026-11-15');
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #yard 🔼 ⏳ 2026-11-15 📅 2026-11-20');
		line = withField(line, 'recurrence', 'every day');
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #yard 🔼 🔁 every day ⏳ 2026-11-15 📅 2026-11-20');
		line = withField(line, 'scheduled', null);
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #yard 🔼 🔁 every day 📅 2026-11-20');
	});

	it('keeps 🔺 when the level is the same, and changes it when not', () => {
		const top = parse('- [ ] a 🔺');
		expect(renderLine(withPriority(top, 3))).toBe('- [ ] a 🔺');
		expect(renderLine(withPriority(top, 2))).toBe('- [ ] a 🔼');
		expect(renderLine(withPriority(top, 0))).toBe('- [ ] a');
	});

	it('ticks and unticks with the done and cancelled dates', () => {
		const done = withStatus(parse(base), 'done', '2026-11-11');
		expect(renderLine(done)).toBe('- [x] Mow #pecklist #yard 🔼 ⏳ 2026-11-14 ✅ 2026-11-11');
		const cancelled = withStatus(done, 'wontdo', '2026-11-12');
		expect(renderLine(cancelled)).toBe('- [-] Mow #pecklist #yard 🔼 ⏳ 2026-11-14 ❌ 2026-11-12');
		expect(renderLine(withStatus(cancelled, 'open', null))).toBe(base);
	});

	it('changes the title and keeps tags that sat inside it', () => {
		const line = parse('- [ ] Call #bob about the car #pecklist');
		expect(renderLine(withTitle(line, 'Phone the garage'))).toBe('- [ ] Phone the garage #bob #pecklist');
	});

	it('adds, removes and swaps tags', () => {
		let line = withAddedTags(parse(base), ['garden']);
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #yard #garden 🔼 ⏳ 2026-11-14');
		line = withoutTags(line, (t) => t === 'yard');
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist #garden 🔼 ⏳ 2026-11-14');
		line = withReplacedTag(line, (t) => t.startsWith('pecklist'), 'pecklist/Work');
		expect(renderLine(line)).toBe('- [ ] Mow #pecklist/Work #garden 🔼 ⏳ 2026-11-14');
	});
});
