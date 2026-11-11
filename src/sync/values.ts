// The fields that sync, as the note sees them and as the server sees them.
//
// Each linked task keeps a snapshot of both views from its last sync. A field changed in the
// note when its note value differs from the note snapshot, and changed in PeckList when its
// server value differs from the server snapshot. Keeping both views means a value the two sides
// spell differently (tag case, a tag with a space, a repeat with no Tasks text) never looks like
// a change and never loops.

import type { ApiTask } from '../api/types';
import { isPeckListTag, tagKey } from '../core/lists';
import { type TaskLine, type Status, fieldOf, priorityOf, statusOf, tagsOf, titleOf } from '../core/line';
import { normalizeRrule, tasksToRrule } from '../core/recurrence';

export const FIELDS = ['title', 'list', 'tags', 'priority', 'due', 'scheduled', 'recurrence', 'status'] as const;
export type Field = (typeof FIELDS)[number];

export interface LocalValues {
	title: string;
	/** `pecklist` or `pecklist/<listKey>`. */
	listTag: string;
	/** Tags as written, without `#`, without PeckList tags and ignored tags. */
	tags: string[];
	priority: number;
	due: string | null;
	scheduled: string | null;
	/** The 🔁 text, lowercased, or null. */
	recurrence: string | null;
	status: Status;
}

export interface RemoteValues {
	title: string;
	listId: string | null;
	tags: string[];
	priority: number;
	due: string | null;
	scheduled: string | null;
	/** Canonical RRULE, or null. */
	recurrence: string | null;
	status: Status;
}

export interface Snapshot {
	path: string;
	local: LocalValues;
	remote: RemoteValues;
	/** Whether the vault tag was given to the task (once; taken off in PeckList, it stays off). */
	vaultTagged?: boolean;
}

export function localValues(line: TaskLine, ignoredTags: ReadonlySet<string>): LocalValues {
	const all = tagsOf(line);
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const t of all) {
		const key = t.toLowerCase();
		if (isPeckListTag(t) || ignoredTags.has(key) || seen.has(key)) continue;
		seen.add(key);
		tags.push(t);
	}
	const pl = all.find(isPeckListTag);
	const rec = fieldOf(line, 'recurrence');
	return {
		title: titleOf(line),
		listTag: pl ? tagKey(pl) : 'pecklist',
		tags,
		priority: priorityOf(line),
		due: fieldOf(line, 'due'),
		scheduled: fieldOf(line, 'scheduled'),
		recurrence: rec ? rec.trim().toLowerCase().replace(/\s+/gu, ' ') : null,
		status: statusOf(line),
	};
}

export function remoteValues(task: ApiTask): RemoteValues {
	return {
		title: task.title.replace(/\s+/gu, ' ').trim(),
		listId: task.listId,
		tags: [...task.tags],
		priority: task.priority,
		due: task.due ? task.due.at.slice(0, 10) : null,
		scheduled: task.schedule ? task.schedule.start.slice(0, 10) : null,
		recurrence: normalizeRrule(task.recurrence),
		status: task.status,
	};
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
	const x = new Set(a.map((t) => t.toLowerCase()));
	const y = new Set(b.map((t) => t.toLowerCase()));
	if (x.size !== y.size) return false;
	for (const t of x) if (!y.has(t)) return false;
	return true;
}

export function localChanged(field: Field, now: LocalValues, then: LocalValues): boolean {
	switch (field) {
		case 'list':
			return now.listTag !== then.listTag;
		case 'tags':
			return !sameTags(now.tags, then.tags);
		default:
			return now[field] !== then[field];
	}
}

export function remoteChanged(field: Field, now: RemoteValues, then: RemoteValues): boolean {
	switch (field) {
		case 'list':
			return now.listId !== then.listId;
		case 'tags':
			return !sameTags(now.tags, then.tags);
		default:
			return now[field] !== then[field];
	}
}

/** Whether the note's value already says what the server says (so neither side needs to move). */
export function agrees(field: Field, local: LocalValues, remote: RemoteValues, listIdFor: (listTag: string) => string | null): boolean {
	switch (field) {
		case 'list':
			return listIdFor(local.listTag) === remote.listId;
		case 'tags':
			return sameTags(local.tags.map(tagForRemote), remote.tags.map(tagForRemote));
		case 'recurrence': {
			if (local.recurrence === null) return remote.recurrence === null;
			const rule = tasksToRrule(local.recurrence);
			// A repeat with no RRULE form here: we can't tell, so leave both alone.
			return rule === null ? true : normalizeRrule(rule) === remote.recurrence;
		}
		default:
			return local[field] === remote[field];
	}
}

/** How a PeckList tag name is written as an Obsidian tag: no spaces or punctuation. */
export function tagForRemote(name: string): string {
	return name
		.trim()
		.replace(/[^\p{L}\p{N}_/-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.toLowerCase();
}

/** A PeckList tag written into a note. */
export function obsidianTag(name: string): string | null {
	const t = name
		.trim()
		.replace(/[^\p{L}\p{N}_/-]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
	// A tag needs at least one non-digit.
	return t && /[^\d/]/u.test(t) ? t : null;
}

/** A date or local date-time with its date part replaced, keeping a time of day if it had one. */
export function withDatePart(date: string, existing: string | null | undefined): string {
	return existing && existing.length > 10 ? date + existing.slice(10) : date;
}

/** A UTC time as a local date (YYYY-MM-DD). */
export function localDate(iso: string | null | undefined, fallback: Date = new Date()): string {
	const d = iso ? new Date(iso) : fallback;
	const when = Number.isNaN(d.getTime()) ? fallback : d;
	const y = when.getFullYear();
	const m = String(when.getMonth() + 1).padStart(2, '0');
	const day = String(when.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
