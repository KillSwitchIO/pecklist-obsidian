// Finding PeckList lines in notes, and rewriting one line safely.

import { isPeckListTag } from '../core/lists';
import { type TaskLine, parseLine, statusOf, tagsOf, titleOf } from '../core/line';

export interface ScannedLine {
	path: string;
	/** 0-based line number when scanned. */
	lineNo: number;
	/** The whole line as scanned, used to find it again before an edit. */
	text: string;
	line: TaskLine;
	id: string | null;
	off: boolean;
	/** The first PeckList tag on the line, without `#`, or null. */
	peckListTag: string | null;
}

export interface Exclusions {
	folders: string[];
	notes: string[];
}

function clean(path: string): string {
	return path.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

export function excludedBy(path: string, exclusions: Exclusions): 'folder' | 'note' | null {
	const p = clean(path);
	for (const folder of exclusions.folders) {
		const f = clean(folder);
		if (f && (p === f || p.startsWith(`${f}/`))) return 'folder';
	}
	for (const note of exclusions.notes) {
		const n = clean(note);
		if (n && (p === n || p === `${n}.md`)) return 'note';
	}
	return null;
}

const FENCE = /^\s*(```|~~~)/u;

/** The PeckList lines of one note: lines with a PeckList tag or a PeckList marker. */
export function scanNote(path: string, content: string): ScannedLine[] {
	const out: ScannedLine[] = [];
	const lines = content.split(/\r?\n/u);
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i] ?? '';
		const f = FENCE.exec(text);
		if (f) {
			const mark = f[1] ?? '';
			if (fence === null) fence = mark;
			else if (fence === mark) fence = null;
			continue;
		}
		if (fence !== null) continue;
		if (!text.includes('[')) continue;
		const line = parseLine(text);
		if (!line) continue;
		const peckListTag = tagsOf(line).find(isPeckListTag) ?? null;
		if (!peckListTag && !line.marker) continue;
		out.push({
			path,
			lineNo: i,
			text,
			line,
			id: line.marker?.kind === 'id' ? line.marker.id : null,
			off: line.marker?.kind === 'off',
			peckListTag,
		});
	}
	return out;
}

/** Whether a scanned line would be made in PeckList as a new task. */
export function isNewCandidate(s: ScannedLine): boolean {
	return !s.id && !s.off && s.peckListTag !== null && statusOf(s.line) === 'open' && titleOf(s.line) !== '';
}

/**
 * Replaces one line, found by its exact text: the line at `lineNo` if it still matches, else the
 * nearest line with the same text. Returns null when the line changed since it was scanned,
 * so a sync never overwrites typing it hasn't seen.
 */
export function replaceLine(content: string, lineNo: number, expected: string, next: string | null): string | null {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/u);
	let at = -1;
	if (lines[lineNo] === expected) at = lineNo;
	else {
		let best = Infinity;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === expected && Math.abs(i - lineNo) < best) {
				best = Math.abs(i - lineNo);
				at = i;
			}
		}
	}
	if (at < 0) return null;
	if (next === null) lines.splice(at, 1);
	else lines[at] = next;
	return lines.join(eol);
}
