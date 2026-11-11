// Repeats: the Tasks plugin's "every ..." text and PeckList's RRULE text, both ways.
// Only the common forms are translated. Anything else returns null and the caller leaves the
// field alone, so an unusual repeat stays as written in the note and on the server.

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
type Day = (typeof DAYS)[number];
const DAY_NAMES: Record<Day, string> = {
	MO: 'Monday',
	TU: 'Tuesday',
	WE: 'Wednesday',
	TH: 'Thursday',
	FR: 'Friday',
	SA: 'Saturday',
	SU: 'Sunday',
};
const WEEKDAYS: Day[] = ['MO', 'TU', 'WE', 'TH', 'FR'];
const FREQ_BY_UNIT: Record<string, string> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const UNIT_BY_FREQ: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

function dayFromName(name: string): Day | null {
	const n = name.trim().toLowerCase().replace(/\.$/u, '');
	if (n.length < 2) return null;
	for (const candidate of n.length > 3 && n.endsWith('s') ? [n, n.slice(0, -1)] : [n]) {
		for (const d of DAYS) if (DAY_NAMES[d].toLowerCase().startsWith(candidate)) return d;
	}
	return null;
}

function dayList(text: string): Day[] | null {
	const parts = text
		.split(/\s*(?:,|\band\b)\s*/u)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const days: Day[] = [];
	for (const p of parts) {
		const d = dayFromName(p);
		if (!d) return null;
		if (!days.includes(d)) days.push(d);
	}
	return days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
}

function ordinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

interface Rule {
	FREQ: string;
	INTERVAL?: number;
	BYDAY?: string[];
	BYMONTHDAY?: number;
	FROM_COMPLETION?: boolean;
}

function format(rule: Rule): string {
	const parts = [`FREQ=${rule.FREQ}`];
	if (rule.INTERVAL && rule.INTERVAL > 1) parts.push(`INTERVAL=${rule.INTERVAL}`);
	if (rule.BYDAY && rule.BYDAY.length > 0) parts.push(`BYDAY=${rule.BYDAY.join(',')}`);
	if (rule.BYMONTHDAY !== undefined) parts.push(`BYMONTHDAY=${rule.BYMONTHDAY}`);
	if (rule.FROM_COMPLETION) parts.push('X-PL-FROM=COMPLETION');
	return parts.join(';');
}

function parseRule(rrule: string): Rule | null {
	const text = rrule.trim().replace(/^RRULE:/iu, '');
	if (!text) return null;
	const rule: Partial<Rule> = {};
	for (const part of text.split(';')) {
		if (!part) continue;
		const [keyRaw, valueRaw] = part.split('=');
		const key = (keyRaw ?? '').toUpperCase();
		const value = (valueRaw ?? '').toUpperCase();
		if (key === 'FREQ') {
			if (!UNIT_BY_FREQ[value]) return null;
			rule.FREQ = value;
		} else if (key === 'INTERVAL') {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) return null;
			rule.INTERVAL = n;
		} else if (key === 'BYDAY') {
			const days = value.split(',');
			if (!days.every((d) => /^(?:[1-4]|-1)?(?:MO|TU|WE|TH|FR|SA|SU)$/u.test(d))) return null;
			rule.BYDAY = days;
		} else if (key === 'BYMONTHDAY') {
			const n = Number(value);
			if (!Number.isInteger(n) || n === 0 || n < -1 || n > 31) return null;
			rule.BYMONTHDAY = n;
		} else if (key === 'X-PL-FROM') {
			if (value !== 'COMPLETION') return null;
			rule.FROM_COMPLETION = true;
		} else if (key === 'WKST') {
			continue;
		} else {
			// COUNT, UNTIL, BYMONTH, BYSETPOS and the rest have no Tasks text here.
			return null;
		}
	}
	return rule.FREQ ? (rule as Rule) : null;
}

/** RRULE text in one canonical form, so two spellings of the same rule compare equal. */
export function normalizeRrule(rrule: string | null | undefined): string | null {
	if (!rrule) return null;
	const rule = parseRule(rrule);
	if (!rule) return rrule.trim().toUpperCase();
	if (rule.BYDAY && rule.BYDAY.every((d) => (DAYS as readonly string[]).includes(d))) {
		rule.BYDAY = [...rule.BYDAY].sort((a, b) => DAYS.indexOf(a as Day) - DAYS.indexOf(b as Day));
	}
	return format(rule);
}

/** The Tasks plugin's text for an RRULE, or null when there's no plain form for it. */
export function rruleToTasks(rrule: string | null | undefined): string | null {
	if (!rrule) return null;
	const rule = parseRule(rrule);
	if (!rule) return null;
	const n = rule.INTERVAL ?? 1;
	const unit = UNIT_BY_FREQ[rule.FREQ] ?? 'day';
	const every = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
	let text: string | null = null;
	if (rule.FREQ === 'WEEKLY' && rule.BYDAY) {
		if (!rule.BYDAY.every((d) => (DAYS as readonly string[]).includes(d))) return null;
		const days = [...rule.BYDAY].sort((a, b) => DAYS.indexOf(a as Day) - DAYS.indexOf(b as Day)) as Day[];
		if (n === 1 && days.join() === WEEKDAYS.join()) text = 'every weekday';
		else text = `${every} on ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
	} else if (rule.FREQ === 'MONTHLY' && rule.BYMONTHDAY !== undefined && !rule.BYDAY) {
		text = `${every} on the ${rule.BYMONTHDAY === -1 ? 'last' : ordinal(rule.BYMONTHDAY)}`;
	} else if (rule.FREQ === 'MONTHLY' && rule.BYDAY && rule.BYMONTHDAY === undefined) {
		if (rule.BYDAY.length !== 1) return null;
		const m = /^([1-4]|-1)(MO|TU|WE|TH|FR|SA|SU)$/u.exec(rule.BYDAY[0] ?? '');
		if (!m) return null;
		const which = m[1] === '-1' ? 'last' : ordinal(Number(m[1]));
		text = `${every} on the ${which} ${DAY_NAMES[m[2] as Day]}`;
	} else if (!rule.BYDAY && rule.BYMONTHDAY === undefined) {
		text = every;
	} else {
		return null;
	}
	return rule.FROM_COMPLETION ? `${text} when done` : text;
}

/** An RRULE for the Tasks plugin's "every ..." text, or null when the form isn't one we read. */
export function tasksToRrule(text: string | null | undefined): string | null {
	if (!text) return null;
	let t = text.trim().toLowerCase().replace(/\s+/gu, ' ');
	let fromCompletion = false;
	if (t.endsWith(' when done')) {
		fromCompletion = true;
		t = t.slice(0, -' when done'.length).trim();
	}
	const rule: Rule = { FREQ: '' };
	if (fromCompletion) rule.FROM_COMPLETION = true;

	if (t === 'every weekday') {
		rule.FREQ = 'WEEKLY';
		rule.BYDAY = [...WEEKDAYS];
		return format(rule);
	}
	const m = /^every(?: (\d+|other))? (day|week|month|year)s?(?: (.*))?$/u.exec(t);
	if (m) {
		const interval = m[1] === 'other' ? 2 : m[1] ? Number(m[1]) : 1;
		if (!Number.isInteger(interval) || interval < 1) return null;
		const unit = m[2] ?? 'day';
		rule.FREQ = FREQ_BY_UNIT[unit] ?? 'DAILY';
		if (interval > 1) rule.INTERVAL = interval;
		const rest = (m[3] ?? '').trim();
		if (!rest) return format(rule);
		if (unit === 'week') {
			const on = /^on (.+)$/u.exec(rest);
			const days = on ? dayList(on[1] ?? '') : null;
			if (!days) return null;
			rule.BYDAY = days;
			return format(rule);
		}
		if (unit === 'month') {
			const last = /^on the last(?: day)?$/u.exec(rest);
			if (last) {
				rule.BYMONTHDAY = -1;
				return format(rule);
			}
			const day = /^on the (\d{1,2})(?:st|nd|rd|th)$/u.exec(rest);
			if (day) {
				const n = Number(day[1]);
				if (n < 1 || n > 31) return null;
				rule.BYMONTHDAY = n;
				return format(rule);
			}
			const nth = /^on the (1st|2nd|3rd|4th|last) (\w+)$/u.exec(rest);
			if (nth) {
				const d = dayFromName(nth[2] ?? '');
				if (!d) return null;
				const which = nth[1] === 'last' ? '-1' : (nth[1] ?? '1').charAt(0);
				rule.BYDAY = [`${which}${d}`];
				return format(rule);
			}
		}
		return null;
	}
	const days = /^every (.+)$/u.exec(t);
	if (days) {
		const list = dayList(days[1] ?? '');
		if (!list) return null;
		rule.FREQ = 'WEEKLY';
		rule.BYDAY = list;
		return format(rule);
	}
	return null;
}
