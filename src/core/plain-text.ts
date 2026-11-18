// Matching a task as the Tasks plugin draws it (in a query, or in reading view) back to its line
// in the note. The drawn description has no Markdown, no tags the Tasks plugin hides (its global
// filter) and no comments, so both sides are reduced to their plain words before comparing.

/** What matching needs from a scanned line. */
export interface DrawnCandidate {
	line: { description: string };
	id: string | null;
	off: boolean;
}

/** Plain words of Markdown or drawn text: no comments, link syntax, tags, emphasis or case. */
export function plainKey(text: string): string {
	return text
		.replace(/%%[\s\S]*?%%/gu, ' ')
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/gu, '$2')
		.replace(/\[\[([^\]]*)\]\]/gu, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
		.replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, '$1')
		.replace(/[*_~=`]/gu, '')
		.replace(/\s+/gu, ' ')
		.trim()
		.toLowerCase();
}

/** Only letters and digits: what's left when a link is drawn differently ("Note > Heading"). */
function looseKey(text: string): string {
	return plainKey(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The line a drawn description belongs to, among one note's lines. Null when none matches, or
 * when several lines match and they aren't the same task (the same text twice in one note).
 */
export function findDrawnLine<T extends DrawnCandidate>(lines: readonly T[], drawn: string): T | null {
	const pick = (key: (s: string) => string): T | null | undefined => {
		const want = key(drawn);
		if (!want) return undefined;
		const found = lines.filter((l) => key(l.line.description) === want);
		if (found.length === 0) return undefined;
		const first = found[0] as T;
		return found.every((l) => l.id === first.id && l.off === first.off) ? first : null;
	};
	const exact = pick(plainKey);
	if (exact !== undefined) return exact;
	return pick(looseKey) ?? null;
}
