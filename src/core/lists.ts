// The PeckList tag on a line: `#pecklist` for the default list, `#pecklist/<List>` for another.
// Tags can't hold spaces or most punctuation, so a list name is compared by a key in which any
// run of other characters (spaces, `-`, `_`, `&`, ...) counts the same.

export const ROOT_TAG = 'pecklist';

export function isPeckListTag(tag: string): boolean {
	const t = tag.toLowerCase();
	return t === ROOT_TAG || t.startsWith(`${ROOT_TAG}/`);
}

/** Lowercase, Unicode-normalized, every run of non-letters and non-digits (except `/`) as `-`. */
export function listKey(name: string): string {
	return name
		.normalize('NFC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}/]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
}

/** The list part of a PeckList tag (`pecklist/Home-Projects` gives `Home-Projects`), or null for the default list. */
export function listPartOf(tag: string): string | null {
	const slash = tag.indexOf('/');
	if (slash < 0) return null;
	const part = tag.slice(slash + 1);
	return part ? part : null;
}

/** A key for comparing the PeckList tag on a line: `pecklist` or `pecklist/<listKey>`. */
export function tagKey(tag: string): string {
	const part = listPartOf(tag);
	return part ? `${ROOT_TAG}/${listKey(part)}` : ROOT_TAG;
}

/** The tag to write for a list. */
export function tagForList(name: string | null): string {
	if (name === null) return ROOT_TAG;
	const part = name
		.trim()
		.replace(/[^\p{L}\p{N}_/-]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
	return part ? `${ROOT_TAG}/${part}` : ROOT_TAG;
}

/** A name for a list made from a tag: `Home-Projects` and `Home_Projects` give `Home Projects`. */
export function nameFromListPart(part: string): string {
	return part.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}
