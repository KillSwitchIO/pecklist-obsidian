// Reading and writing one Markdown task line in the Tasks plugin's emoji format.
//
// A line is split into its checkbox prefix, a free-text description, the PeckList marker
// (`%%[pecklist:: <id>]%%`, an Obsidian comment, so it's hidden in reading view), and the
// trailing tokens the Tasks plugin reads from the end of the line (dates, priority, repeat,
// tags, block link). The marker is always written between the description and the trailing
// tokens: the Tasks plugin stops reading fields at the first text it doesn't know, so a marker
// at the very end would hide the dates from it.

export type Status = 'open' | 'done' | 'wontdo';

export type TokenKind =
	| 'priority'
	| 'recurrence'
	| 'onCompletion'
	| 'created'
	| 'start'
	| 'scheduled'
	| 'due'
	| 'cancelled'
	| 'done'
	| 'id'
	| 'depends'
	| 'tag'
	| 'block';

export interface Token {
	kind: TokenKind;
	/** The token as written, without surrounding spaces. */
	raw: string;
	/** The value: a date, the repeat text, the priority emoji, the tag without `#`. */
	value: string;
}

export type Marker = { kind: 'id'; id: string } | { kind: 'off' };

export interface TaskLine {
	/** Indent, bullet and `[`. */
	lead: string;
	statusChar: string;
	/** `]` and the spaces after it. */
	afterStatus: string;
	/** The free text, without the marker and the trailing tokens. */
	description: string;
	marker: Marker | null;
	tokens: Token[];
}

const LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*)$/u;
const MARKER = /\s*%%\[pecklist::\s*([0-9A-Za-z_-]+)\s*\]%%/u;
const DATE = '(\\d{4}-\\d{2}-\\d{2})';

const TRAILING: { kind: TokenKind; re: RegExp }[] = [
	{ kind: 'priority', re: /([🔺⏫🔼🔽⏬])️?$/u },
	{ kind: 'start', re: new RegExp(`🛫\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'created', re: new RegExp(`➕\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'scheduled', re: new RegExp(`[⏳⌛]\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'due', re: new RegExp(`[📅📆🗓]\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'done', re: new RegExp(`✅\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'cancelled', re: new RegExp(`❌\\uFE0F? *${DATE}$`, 'u') },
	{ kind: 'recurrence', re: /🔁️? *([a-zA-Z0-9, !]+)$/u },
	{ kind: 'onCompletion', re: /🏁️? *([a-zA-Z]+)$/u },
	{ kind: 'depends', re: /⛔️? *([a-zA-Z0-9_-]+(?: *, *[a-zA-Z0-9_-]+)*)$/u },
	{ kind: 'id', re: /🆔️? *([a-zA-Z0-9_-]+)$/u },
	{ kind: 'block', re: /(?:^|\s)\^([a-zA-Z0-9-]+)$/u },
	{ kind: 'tag', re: /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)$/u },
];

const TAG_IN_TEXT = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Order the Tasks plugin writes its fields in; a new field goes before the first later one. */
const FIELD_ORDER: TokenKind[] = [
	'priority',
	'recurrence',
	'onCompletion',
	'created',
	'start',
	'scheduled',
	'due',
	'cancelled',
	'done',
	'id',
	'depends',
	'block',
];

export function parseLine(text: string): TaskLine | null {
	const m = LINE.exec(text);
	if (!m) return null;
	const [, lead = '', statusChar = ' ', afterStatus = '', bodyRaw = ''] = m;
	let body = bodyRaw;
	let marker: Marker | null = null;
	const found = MARKER.exec(body);
	if (found) {
		const value = found[1] ?? '';
		marker = value === 'off' ? { kind: 'off' } : { kind: 'id', id: value };
		body = body.slice(0, found.index) + body.slice(found.index + found[0].length);
	}
	const tokens: Token[] = [];
	for (let guard = 0; guard < 40; guard++) {
		body = body.replace(/\s+$/u, '');
		let matched = false;
		for (const { kind, re } of TRAILING) {
			const t = re.exec(body);
			if (!t) continue;
			const raw = t[0].trim();
			tokens.unshift({ kind, raw, value: t[1] ?? '' });
			body = body.slice(0, t.index);
			matched = true;
			break;
		}
		if (!matched) break;
	}
	return { lead, statusChar, afterStatus, description: body.trim(), marker, tokens };
}

export function renderLine(line: TaskLine): string {
	const parts: string[] = [];
	if (line.description) parts.push(line.description);
	if (line.marker) parts.push(`%%[pecklist:: ${line.marker.kind === 'off' ? 'off' : line.marker.id}]%%`);
	for (const t of line.tokens) parts.push(t.raw);
	return line.lead + line.statusChar + line.afterStatus + parts.join(' ');
}

export function statusOf(line: TaskLine): Status {
	if (line.statusChar === 'x' || line.statusChar === 'X') return 'done';
	if (line.statusChar === '-') return 'wontdo';
	return 'open';
}

/** Every tag on the line, in order, without `#`, from the description and the trailing tokens. */
export function tagsOf(line: TaskLine): string[] {
	const tags: string[] = [];
	for (const m of line.description.matchAll(TAG_IN_TEXT)) tags.push(m[2] ?? '');
	for (const t of line.tokens) if (t.kind === 'tag') tags.push(t.value);
	return tags;
}

/** The description without tags or the marker, spaces collapsed. */
export function titleOf(line: TaskLine): string {
	return line.description.replace(TAG_IN_TEXT, '$1').replace(/\s+/gu, ' ').trim();
}

export function fieldOf(line: TaskLine, kind: TokenKind): string | null {
	for (let i = line.tokens.length - 1; i >= 0; i--) {
		const t = line.tokens[i];
		if (t && t.kind === kind) return t.value;
	}
	return null;
}

export const PRIORITY_FROM_EMOJI: Record<string, number> = { '🔺': 3, '⏫': 3, '🔼': 2, '🔽': 1, '⏬': 1 };
const EMOJI_FOR_PRIORITY: Record<number, string> = { 3: '⏫', 2: '🔼', 1: '🔽' };

export function priorityOf(line: TaskLine): number {
	const p = fieldOf(line, 'priority');
	return p ? (PRIORITY_FROM_EMOJI[p] ?? 0) : 0;
}

// --- Edits. Each returns a new line and leaves the rest of it as written. ---

function clone(line: TaskLine): TaskLine {
	return { ...line, tokens: line.tokens.map((t) => ({ ...t })) };
}

const PREFIX: Partial<Record<TokenKind, string>> = {
	recurrence: '🔁',
	start: '🛫',
	scheduled: '⏳',
	due: '📅',
	done: '✅',
	cancelled: '❌',
};

/** Sets (or with null removes) a trailing field such as `due`. */
export function withField(line: TaskLine, kind: TokenKind, value: string | null): TaskLine {
	const next = clone(line);
	const existing = next.tokens.filter((t) => t.kind === kind);
	if (value === null) {
		next.tokens = next.tokens.filter((t) => t.kind !== kind);
		return next;
	}
	const raw = kind === 'priority' ? value : `${PREFIX[kind] ?? ''} ${value}`;
	if (existing.length > 0) {
		let kept = false;
		next.tokens = next.tokens.filter((t) => {
			if (t.kind !== kind) return true;
			if (kept) return false;
			kept = true;
			t.raw = raw;
			t.value = value;
			return true;
		});
		return next;
	}
	const rank = FIELD_ORDER.indexOf(kind);
	let at = next.tokens.length;
	for (let i = 0; i < next.tokens.length; i++) {
		const t = next.tokens[i];
		if (!t || t.kind === 'tag') continue;
		if (FIELD_ORDER.indexOf(t.kind) > rank) {
			at = i;
			break;
		}
	}
	next.tokens.splice(at, 0, { kind, raw, value });
	return next;
}

export function withPriority(line: TaskLine, priority: number): TaskLine {
	if (priorityOf(line) === priority) return line;
	return withField(line, 'priority', EMOJI_FOR_PRIORITY[priority] ?? null);
}

export function withStatus(line: TaskLine, status: Status, date: string | null): TaskLine {
	let next = clone(line);
	if (status === 'open') {
		next.statusChar = ' ';
		next = withField(withField(next, 'done', null), 'cancelled', null);
	} else if (status === 'done') {
		next.statusChar = 'x';
		next = withField(next, 'cancelled', null);
		if (date) next = withField(next, 'done', date);
	} else {
		next.statusChar = '-';
		next = withField(next, 'done', null);
		if (date) next = withField(next, 'cancelled', date);
	}
	return next;
}

export function withMarker(line: TaskLine, marker: Marker | null): TaskLine {
	return { ...clone(line), marker };
}

/** Replaces the title, keeping the tags that were in the description after it. */
export function withTitle(line: TaskLine, title: string): TaskLine {
	const inText: string[] = [];
	for (const m of line.description.matchAll(TAG_IN_TEXT)) inText.push(`#${m[2] ?? ''}`);
	return { ...clone(line), description: [title.trim(), ...inText].filter(Boolean).join(' ') };
}

/** Removes every tag matching `match` (compared without `#`), wherever it is on the line. */
export function withoutTags(line: TaskLine, match: (tag: string) => boolean): TaskLine {
	const next = clone(line);
	next.description = next.description
		.replace(TAG_IN_TEXT, (all, space: string, tag: string) => (match(tag) ? space : all))
		.replace(/\s+/gu, ' ')
		.trim();
	next.tokens = next.tokens.filter((t) => !(t.kind === 'tag' && match(t.value)));
	return next;
}

/** Adds tags after the last trailing tag, or before the first field when there is none. */
export function withAddedTags(line: TaskLine, tags: string[]): TaskLine {
	if (tags.length === 0) return line;
	const next = clone(line);
	let at = 0;
	for (let i = 0; i < next.tokens.length; i++) if (next.tokens[i]?.kind === 'tag') at = i + 1;
	next.tokens.splice(at, 0, ...tags.map((tag) => ({ kind: 'tag' as const, raw: `#${tag}`, value: tag })));
	return next;
}

/** Swaps one tag for another in place (used for the list tag). */
export function withReplacedTag(line: TaskLine, match: (tag: string) => boolean, tag: string): TaskLine {
	const next = clone(line);
	let done = false;
	next.description = next.description.replace(TAG_IN_TEXT, (all, space: string, t: string) => {
		if (done || !match(t)) return all;
		done = true;
		return `${space}#${tag}`;
	});
	for (const t of next.tokens) {
		if (done) break;
		if (t.kind === 'tag' && match(t.value)) {
			t.raw = `#${tag}`;
			t.value = tag;
			done = true;
		}
	}
	return done ? next : withAddedTags(next, [tag]);
}
