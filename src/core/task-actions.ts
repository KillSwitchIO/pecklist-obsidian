// Line edits behind the task menu on a linked line's bird (src/ui/task-menu.ts). Pure, so they
// are tested without Obsidian.

import { isPeckListTag } from './lists';
import { parseLine, renderLine, statusOf, withReplacedTag, withStatus } from './line';

/**
 * The line(s) that close a task as done or won't do. A repeating task goes through the Tasks
 * plugin so its next one is written the way Tasks writes it; won't do then turns the closed copy
 * from done into won't do.
 */
export function closeTaskLines(text: string, status: 'done' | 'wontdo', today: string, toggleDone: (line: string) => string | null): string | null {
	const line = parseLine(text);
	if (!line || statusOf(line) !== 'open') return null;
	const repeats = line.tokens.some((t) => t.kind === 'recurrence');
	const toggled = repeats ? toggleDone(text) : null;
	if (toggled !== null && toggled !== text) {
		if (status === 'done') return toggled;
		return toggled
			.split('\n')
			.map((l) => {
				const p = parseLine(l);
				return p && statusOf(p) === 'done' ? renderLine(withStatus(p, 'wontdo', today)) : l;
			})
			.join('\n');
	}
	return renderLine(withStatus(line, status, today));
}

export function reopenTaskLine(text: string): string | null {
	const line = parseLine(text);
	if (!line || statusOf(line) === 'open') return null;
	return renderLine(withStatus(line, 'open', null));
}

export function moveTaskLine(text: string, listTag: string): string | null {
	const line = parseLine(text);
	if (!line) return null;
	return renderLine(withReplacedTag(line, isPeckListTag, listTag));
}
