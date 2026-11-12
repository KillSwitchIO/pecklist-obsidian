// What the task manager lists: every PeckList line in the vault with its sync state, links whose
// line is gone, and tasks that are only in PeckList. Free of Obsidian imports, so it's tested on
// its own.

import type { ApiTask } from '../api/types';
import { type Status, fieldOf, statusOf, titleOf } from '../core/line';
import type { SyncError } from './engine';
import { type Exclusions, type ScannedLine, excludedBy } from './scan';
import { FIELDS, type Snapshot, localChanged, localValues } from './values';

export type RowState =
	/** Linked and nothing waiting. */
	| 'synced'
	/** Linked, changed in the note since the last sync. */
	| 'changed'
	/** Linked, but this device hasn't synced it yet. */
	| 'unknown'
	/** Tagged, not in PeckList yet. */
	| 'new'
	/** Something to look at: an error, a copied link, a line with no text, a line gone. */
	| 'attention'
	/** Left out with `%%[pecklist:: off]%%`. */
	| 'off'
	/** In a folder or note left out in the settings. */
	| 'excluded'
	/** Done before it was ever synced, so never sent. */
	| 'skipped'
	/** Only in PeckList. */
	| 'remote';

export interface OverviewRow {
	key: string;
	kind: 'line' | 'missing' | 'remote';
	state: RowState;
	/** Why the row is in its state, in a sentence, or null when there's nothing to say. */
	reason: string | null;
	title: string;
	status: Status;
	id: string | null;
	path: string | null;
	lineNo: number | null;
	/** The line as scanned (line rows), to find it again before an edit. */
	text: string | null;
	/** The PeckList tag on the line, without `#` (line rows). */
	peckListTag: string | null;
	listName: string;
	tags: string[];
	start: string | null;
	due: string | null;
	/** The task as PeckList has it (remote rows). */
	task: ApiTask | null;
}

export interface OverviewInput {
	lines: readonly ScannedLine[];
	snaps: Readonly<Record<string, Snapshot>>;
	/** The last sync's errors. */
	errors: readonly SyncError[];
	/** Open tasks in PeckList, or null when they weren't loaded. */
	remoteTasks: readonly ApiTask[] | null;
	exclusions: Exclusions;
	ignoredTags: readonly string[];
	/** The list a PeckList tag (without `#`) stands for; `pecklist` or null is the default list. */
	listNameForTag(tag: string | null): string;
	listNameForId(id: string | null): string;
}

/** Waiting rows: a sync would send something for them. */
export const WAITING: readonly RowState[] = ['new', 'changed', 'unknown'];
/** Rows left out of syncing on purpose. */
export const LEFT_OUT: readonly RowState[] = ['off', 'excluded', 'skipped'];

export function buildOverview(input: OverviewInput): OverviewRow[] {
	const ignored = new Set(input.ignoredTags.map((t) => t.replace(/^#/u, '').toLowerCase()));
	const rows: OverviewRow[] = [];

	// Lines sharing an id: a repeating task's closed copies are fine, any other is a copied line.
	const byId = new Map<string, ScannedLine[]>();
	for (const l of input.lines) if (l.id) byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
	const copies = new Set<ScannedLine>();
	for (const [id, group] of byId) {
		if (group.length < 2) continue;
		const open = group.filter((l) => statusOf(l.line) === 'open');
		const repeats = group.some((l) => fieldOf(l.line, 'recurrence')) || !!input.snaps[id]?.remote.recurrence;
		if (repeats && open.length === 1) continue;
		const primary = group.find((l) => l.path === input.snaps[id]?.path) ?? group[0];
		for (const l of group) if (l !== primary) copies.add(l);
	}

	for (const l of input.lines) {
		const local = localValues(l.line, ignored);
		const snap = l.id ? input.snaps[l.id] : undefined;
		const title = titleOf(l.line);
		const excluded = excludedBy(l.path, input.exclusions);
		const error = input.errors.find((e) => e.path === l.path && e.title === title);
		let state: RowState;
		let reason: string | null = null;
		if (l.off) {
			state = 'off';
			reason = 'Left out of syncing.';
		} else if (excluded) {
			state = 'excluded';
			reason = excluded === 'folder' ? 'In a folder left out in the settings.' : 'In a note left out in the settings.';
		} else if (error) {
			state = 'attention';
			reason = `Not synced: ${error.message}`;
		} else if (copies.has(l)) {
			state = 'attention';
			reason = 'A copy of another linked line. The next sync makes it a task of its own.';
		} else if (!title) {
			state = 'attention';
			reason = 'No text, so it can’t sync.';
		} else if (l.id && !l.peckListTag) {
			state = 'changed';
			reason = 'PeckList tag taken off: the next sync moves the task to PeckList’s trash.';
		} else if (!l.id) {
			state = local.status === 'open' ? 'new' : 'skipped';
			reason = local.status === 'open' ? 'Not in PeckList yet.' : 'Done before it was synced, so it was never sent.';
		} else if (!snap) {
			state = 'unknown';
			reason = 'Not synced on this device yet.';
		} else if (FIELDS.some((f) => localChanged(f, local, snap.local))) {
			state = 'changed';
			reason = 'Changed in the note, waiting to sync.';
		} else {
			state = 'synced';
		}
		rows.push({
			key: `line:${l.path}:${l.lineNo}`,
			kind: 'line',
			state,
			reason,
			title: title || '(no text)',
			status: local.status,
			id: l.id,
			path: l.path,
			lineNo: l.lineNo,
			text: l.text,
			peckListTag: l.peckListTag,
			listName: input.listNameForTag(l.peckListTag),
			tags: local.tags,
			start: local.scheduled,
			due: local.due,
			task: null,
		});
	}

	const onLines = new Set(input.lines.map((l) => l.id).filter((id): id is string => !!id));
	for (const [id, snap] of Object.entries(input.snaps)) {
		if (onLines.has(id)) continue;
		const excluded = excludedBy(snap.path, input.exclusions);
		rows.push({
			key: `missing:${id}`,
			kind: 'missing',
			state: 'attention',
			reason: excluded
				? 'Its note is now left out. The next sync forgets the link and leaves the task in PeckList.'
				: 'Its line is gone from your notes. The next sync moves the task to PeckList’s trash.',
			title: snap.local.title || '(no text)',
			status: snap.local.status,
			id,
			path: snap.path,
			lineNo: null,
			text: null,
			peckListTag: null,
			listName: input.listNameForId(snap.remote.listId),
			tags: snap.local.tags,
			start: snap.local.scheduled,
			due: snap.local.due,
			task: null,
		});
	}

	if (input.remoteTasks) {
		const known = new Set([...onLines, ...Object.keys(input.snaps)]);
		for (const t of input.remoteTasks) {
			if (known.has(t.id) || t.deletedAt) continue;
			rows.push({
				key: `remote:${t.id}`,
				kind: 'remote',
				state: 'remote',
				reason: null,
				title: t.title.trim() || '(no title)',
				status: t.status,
				id: t.id,
				path: null,
				lineNo: null,
				text: null,
				peckListTag: null,
				listName: input.listNameForId(t.listId),
				tags: [...t.tags],
				start: t.schedule ? t.schedule.start.slice(0, 10) : null,
				due: t.due ? t.due.at.slice(0, 10) : null,
				task: t,
			});
		}
	}
	return rows;
}
