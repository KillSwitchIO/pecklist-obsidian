// One sync run between the vault and PeckList. Free of Obsidian imports: the vault, the API and
// the clock are ports, so the tests run it against fakes and a real server.

import { ApiError, type PeckListClient } from '../api/client';
import type { ApiList, ApiTask, TaskInput } from '../api/types';
import {
	type TaskLine,
	fieldOf,
	renderLine,
	statusOf,
	titleOf,
	withAddedTags,
	withField,
	withMarker,
	withPriority,
	withReplacedTag,
	withStatus,
	withTitle,
	withoutTags,
} from '../core/line';
import { ROOT_TAG, isPeckListTag, listKey, listPartOf, nameFromListPart, tagForList, tagKey } from '../core/lists';
import { rruleToTasks, tasksToRrule } from '../core/recurrence';
import { ulid } from '../core/ulid';
import { type Exclusions, type ScannedLine, excludedBy, isNewCandidate, replaceLine, scanNote } from './scan';
import {
	FIELDS,
	type Field,
	type LocalValues,
	type Snapshot,
	agrees,
	localChanged,
	localDate,
	localValues,
	obsidianTag,
	remoteChanged,
	remoteValues,
	tagForRemote,
	withDatePart,
} from './values';

export interface VaultPort {
	/** Markdown files that may hold PeckList lines: a PeckList tag in the cache, or not indexed yet. */
	candidatePaths(): string[];
	allMarkdownPaths(): string[];
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	/** Last change time in ms. */
	mtime(path: string): number;
	/** Rewrites a note atomically. `change` gets the current text and returns the new text, or null for no change. */
	edit(path: string, change: (content: string) => string | null): Promise<boolean>;
	/** A link that opens the note, put in a new task's notes. */
	noteLink(path: string): string;
}

export type Api = Pick<
	PeckListClient,
	'lists' | 'createList' | 'task' | 'createTask' | 'updateTask' | 'complete' | 'reopen' | 'deleteTask' | 'changes'
>;

export interface SyncState {
	version: 1;
	server: string;
	accountId: string | null;
	cursor: string | null;
	firstSyncDone: boolean;
	snaps: Record<string, Snapshot>;
	/** Tasks whose last sync failed; read from the server again next time. */
	refetch: string[];
}

export function emptyState(server: string, accountId: string | null): SyncState {
	return { version: 1, server, accountId, cursor: null, firstSyncDone: false, snaps: {}, refetch: [] };
}

export interface EngineOptions {
	defaultListId: string | null;
	exclusions: Exclusions;
	/** Tags never sent, such as the Tasks plugin's global filter. Without `#`. */
	ignoredTags: string[];
	/** Put a link to the note in a new task's notes. */
	addNoteLink: boolean;
	newId?: () => string;
	now?: () => Date;
	/** Saves the state; called after steps that change it. */
	save?: (state: SyncState) => void;
}

export interface HeldDeletion {
	id: string;
	title: string;
	path: string;
}

export interface SyncError {
	path: string;
	title: string;
	message: string;
}

export interface SyncReport {
	created: number;
	sent: number;
	received: number;
	completed: number;
	reopened: number;
	trashed: number;
	unlinked: number;
	skippedClosed: number;
	held: HeldDeletion[];
	errors: SyncError[];
}

export type LineState = 'new' | 'linked' | 'closed' | 'untitled' | 'off';

export interface PreviewLine {
	path: string;
	lineNo: number;
	title: string;
	state: LineState;
	listName: string;
	listIsNew: boolean;
}

export interface PreviewNote {
	path: string;
	excluded: 'folder' | 'note' | null;
	lines: PreviewLine[];
}

export interface Preview {
	notes: PreviewNote[];
	defaultListName: string | null;
	newLists: string[];
}

/** A setup problem the person has to fix in settings (no default list, for example). */
export class SetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SetupError';
	}
}

function emptyReport(): SyncReport {
	return { created: 0, sent: 0, received: 0, completed: 0, reopened: 0, trashed: 0, unlinked: 0, skippedClosed: 0, held: [], errors: [] };
}

function isNotFound(e: unknown): boolean {
	return e instanceof ApiError && e.status === 404;
}

/** Errors that stop the whole run: signed out, no permission, the server unreachable. */
function isFatal(e: unknown): boolean {
	if (!(e instanceof ApiError)) return !(e instanceof SetupError) && !(e instanceof LineError);
	return e.status === 401 || (e.status === 403 && e.code === 'scope') || e.status === 429 || e.status === 503;
}

class LineError extends Error {}

export class SyncEngine {
	private lists: ApiList[] = [];
	private readonly ignored: Set<string>;
	private readonly newId: () => string;
	private readonly now: () => Date;
	private report: SyncReport = emptyReport();

	constructor(
		private readonly vault: VaultPort,
		private readonly api: Api,
		private readonly state: SyncState,
		private readonly options: EngineOptions,
	) {
		this.ignored = new Set(options.ignoredTags.map((t) => t.replace(/^#/u, '').toLowerCase()).filter(Boolean));
		this.newId = options.newId ?? (() => ulid());
		this.now = options.now ?? (() => new Date());
	}

	// --- Reading the vault ---

	private async scan(includeExcluded: boolean, paths?: string[]): Promise<{ lines: ScannedLine[]; excluded: Map<string, 'folder' | 'note'> }> {
		const lines: ScannedLine[] = [];
		const excluded = new Map<string, 'folder' | 'note'>();
		const wanted = new Set(paths ?? this.vault.candidatePaths());
		if (!paths) for (const snap of Object.values(this.state.snaps)) if (this.vault.exists(snap.path)) wanted.add(snap.path);
		for (const path of [...wanted].sort()) {
			const reason = excludedBy(path, this.options.exclusions);
			if (reason) {
				excluded.set(path, reason);
				if (!includeExcluded) continue;
			}
			lines.push(...scanNote(path, await this.vault.read(path)));
		}
		return { lines, excluded };
	}

	// --- Lists ---

	private async loadLists(): Promise<void> {
		this.lists = (await this.api.lists()).filter((l) => !l.deletedAt);
	}

	private defaultList(): ApiList {
		const chosen = this.options.defaultListId ? this.lists.find((l) => l.id === this.options.defaultListId) : undefined;
		const list = chosen ?? this.lists.find((l) => l.isInbox);
		if (!list) throw new SetupError('Choose a default list in the PeckList settings.');
		return list;
	}

	private listByKey(key: string): ApiList | undefined {
		const matches = this.lists.filter((l) => listKey(l.name) === key);
		return matches.find((l) => !l.archived) ?? matches[0];
	}

	private listIdFor = (listTagKey: string): string | null => {
		if (listTagKey === ROOT_TAG) return this.defaultList().id;
		return this.listByKey(listTagKey.slice(ROOT_TAG.length + 1))?.id ?? null;
	};

	private async ensureListId(rawTag: string | null): Promise<string> {
		const part = rawTag ? listPartOf(rawTag) : null;
		if (!part) return this.defaultList().id;
		const found = this.listByKey(listKey(part));
		if (found) return found.id;
		const made = await this.api.createList(this.newId(), nameFromListPart(part));
		this.lists.push(made);
		return made.id;
	}

	private tagForListId(listId: string | null): string | null {
		if (!listId) return null;
		if (listId === this.defaultList().id) return ROOT_TAG;
		const list = this.lists.find((l) => l.id === listId);
		return list ? tagForList(list.name) : null;
	}

	// --- Preview for the review before the first sync ---

	async preview(): Promise<Preview> {
		await this.loadLists();
		let defaultName: string | null = null;
		try {
			defaultName = this.defaultList().name;
		} catch {
			defaultName = null;
		}
		const { lines, excluded } = await this.scan(true);
		const notes = new Map<string, PreviewNote>();
		const newLists = new Set<string>();
		for (const s of lines) {
			let note = notes.get(s.path);
			if (!note) {
				note = { path: s.path, excluded: excluded.get(s.path) ?? null, lines: [] };
				notes.set(s.path, note);
			}
			const part = s.peckListTag ? listPartOf(s.peckListTag) : null;
			const list = part ? this.listByKey(listKey(part)) : undefined;
			const listName = part ? (list?.name ?? nameFromListPart(part)) : (defaultName ?? 'Default list');
			const listIsNew = part !== null && !list;
			const state: LineState = s.off
				? 'off'
				: s.id
					? 'linked'
					: titleOf(s.line) === ''
						? 'untitled'
						: statusOf(s.line) !== 'open'
							? 'closed'
							: 'new';
			if (state === 'new' && listIsNew && !note.excluded) newLists.add(listName);
			note.lines.push({ path: s.path, lineNo: s.lineNo, title: titleOf(s.line), state, listName, listIsNew });
		}
		return { notes: [...notes.values()], defaultListName: defaultName, newLists: [...newLists].sort() };
	}

	/** Marks lines so they never sync (`%%[pecklist:: off]%%`), or clears that mark. */
	async setLineOff(path: string, lineNo: number, off: boolean): Promise<boolean> {
		return this.vault.edit(path, (content) => {
			const lines = content.split(/\r?\n/u);
			const text = lines[lineNo];
			if (text === undefined) return null;
			const found = scanNote(path, text)[0];
			if (!found || found.id) return null;
			if (found.off === off) return null;
			return replaceLine(content, lineNo, text, renderLine(withMarker(found.line, off ? { kind: 'off' } : null)));
		});
	}

	// --- The sync run ---

	async sync(options: { allowManyDeletes?: boolean } = {}): Promise<SyncReport> {
		this.report = emptyReport();
		await this.loadLists();
		this.defaultList();

		let { lines } = await this.scan(false);
		const scannedPaths = new Set(lines.map((l) => l.path));
		const wanted = new Set<string>([...lines.map((l) => l.id).filter((id): id is string => !!id), ...Object.keys(this.state.snaps)]);

		// What changed on the server since last time.
		const remote = new Map<string, ApiTask>();
		const revoked = new Set<string>();
		let cursor = this.state.cursor;
		for (let page = 0; page < 1000; page++) {
			const changes = await this.api.changes(cursor);
			for (const t of changes.tasks) if (wanted.has(t.id)) remote.set(t.id, t);
			for (const id of changes.revoked) if (wanted.has(id)) revoked.add(id);
			cursor = changes.cursor;
			if (!changes.more) break;
		}

		// Snapshots whose line wasn't found: look through every note before calling them deleted.
		const found = new Set(lines.map((l) => l.id).filter(Boolean));
		const missing = Object.keys(this.state.snaps).filter((id) => !found.has(id));
		if (missing.length > 0) {
			const extra: string[] = [];
			for (const path of this.vault.allMarkdownPaths()) {
				if (scannedPaths.has(path) || excludedBy(path, this.options.exclusions)) continue;
				const content = await this.vault.read(path);
				if (missing.some((id) => content.includes(`pecklist:: ${id}`))) extra.push(path);
			}
			if (extra.length > 0) lines = lines.concat((await this.scan(false, extra)).lines);
		}

		// Tasks a line names that this device hasn't synced yet, or whose last sync failed.
		const refetch = new Set(this.state.refetch);
		for (const s of lines) if (s.id && !this.state.snaps[s.id]) refetch.add(s.id);
		const pendingCreate = new Set<string>();
		for (const id of refetch) {
			if (remote.has(id) || revoked.has(id)) continue;
			try {
				remote.set(id, await this.api.task(id));
			} catch (e) {
				if (isNotFound(e)) pendingCreate.add(id);
				else throw e;
			}
		}
		this.state.refetch = [];

		const groups = new Map<string, ScannedLine[]>();
		for (const s of lines) {
			if (!s.id) continue;
			const g = groups.get(s.id) ?? [];
			g.push(s);
			groups.set(s.id, g);
		}

		for (const [id, group] of groups) {
			const first = group[0];
			try {
				await this.syncLinked(id, group, remote.get(id), revoked.has(id), pendingCreate.has(id));
			} catch (e) {
				if (isFatal(e)) throw e;
				this.state.refetch.push(id);
				this.fail(first, e);
			}
		}

		await this.syncDeleted(groups, options.allowManyDeletes === true);
		await this.createNew(lines);

		this.state.cursor = cursor;
		this.options.save?.(this.state);
		return this.report;
	}

	/** After the person confirms held deletions: trash them in PeckList, or only forget the links. */
	async resolveHeld(ids: string[], trash: boolean): Promise<void> {
		for (const id of ids) {
			if (trash) {
				try {
					await this.api.deleteTask(id);
				} catch (e) {
					if (!isNotFound(e)) throw e;
				}
			}
			delete this.state.snaps[id];
		}
		this.options.save?.(this.state);
	}

	private fail(s: ScannedLine | undefined, e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		this.report.errors.push({ path: s?.path ?? '', title: s ? titleOf(s.line) : '', message });
	}

	// --- Writing lines ---

	private async writeLine(s: ScannedLine, next: TaskLine): Promise<boolean> {
		const text = renderLine(next);
		if (text === s.text) return true;
		const ok = await this.vault.edit(s.path, (content) => replaceLine(content, s.lineNo, s.text, text));
		if (!ok) throw new LineError('the line changed while syncing; it will sync next time');
		s.text = text;
		s.line = next;
		return true;
	}

	private unlinkedLine(line: TaskLine): TaskLine {
		return withMarker(withoutTags(line, isPeckListTag), null);
	}

	// --- Linked lines ---

	private async syncLinked(id: string, group: ScannedLine[], task: ApiTask | undefined, isRevoked: boolean, isPending: boolean): Promise<void> {
		const snap = this.state.snaps[id];

		// Deleted in PeckList or no longer shared: the line stays, as plain text.
		if (isRevoked || task?.deletedAt) {
			for (const s of group) await this.writeLine(s, this.unlinkedLine(s.line));
			delete this.state.snaps[id];
			this.report.unlinked++;
			return;
		}

		// The PeckList tag was taken off: trash the task, keep the line.
		if (!group.some((s) => s.peckListTag)) {
			if (snap || task) {
				try {
					await this.api.deleteTask(id);
				} catch (e) {
					if (!isNotFound(e)) throw e;
				}
				this.report.trashed++;
			}
			for (const s of group) await this.writeLine(s, withMarker(s.line, null));
			delete this.state.snaps[id];
			return;
		}

		let primary = group[0] as ScannedLine;
		if (group.length > 1) {
			const open = group.filter((s) => statusOf(s.line) === 'open');
			const closed = group.filter((s) => statusOf(s.line) !== 'open');
			const repeats = !!(task?.recurrence ?? snap?.remote.recurrence) || group.some((s) => fieldOf(s.line, 'recurrence'));
			if (repeats && open.length === 1 && closed.length > 0) {
				await this.repeatDone(id, open[0] as ScannedLine, closed, snap, task);
				return;
			}
			// A copied line: the copy becomes a task of its own next time.
			primary = group.find((s) => s.path === snap?.path) ?? primary;
			for (const s of group) if (s !== primary) await this.writeLine(s, withMarker(s.line, null));
		}

		if (!snap && !task) {
			if (isPending) await this.create(primary, id);
			return;
		}
		await this.reconcile(primary, id, snap, task);
	}

	/** The Tasks plugin closed a repeating task and wrote the next one as a new line. */
	private async repeatDone(id: string, open: ScannedLine, closed: ScannedLine[], snap: Snapshot | undefined, task: ApiTask | undefined): Promise<void> {
		for (const s of closed) await this.writeLine(s, withMarker(s.line, null));
		let current = task ?? (await this.api.task(id));
		const before = snap?.remote;
		const serverMoved = before !== undefined && (before.due !== remoteValues(current).due || before.scheduled !== remoteValues(current).scheduled);
		if (current.status === 'open' && !serverMoved) {
			const closedAs = statusOf((closed[0] as ScannedLine).line) === 'wontdo' ? 'wontdo' : 'done';
			const result = await this.api.complete(id, closedAs);
			this.report.completed++;
			current = result.next ?? result.completed;
		}
		// The server owns repeats: the open line takes its dates.
		const fields: Field[] = ['priority', 'due', 'scheduled', 'recurrence', 'status'];
		const next = this.applyPull(open.line, fields, current, null);
		await this.writeLine(open, next);
		this.state.snaps[id] = { path: open.path, local: localValues(next, this.ignored), remote: remoteValues(current) };
	}

	private async reconcile(s: ScannedLine, id: string, snap: Snapshot | undefined, task: ApiTask | undefined): Promise<void> {
		const local = localValues(s.line, this.ignored);
		const remoteNow = task ? remoteValues(task) : (snap as Snapshot).remote;
		const push: Field[] = [];
		const pull: Field[] = [];
		const localTime = this.vault.mtime(s.path);
		const remoteTime = task?.updatedAt ? Date.parse(task.updatedAt) : 0;
		for (const f of FIELDS) {
			const lc = snap ? localChanged(f, local, snap.local) : true;
			const rc = snap ? remoteChanged(f, remoteNow, snap.remote) : true;
			if (!lc && !rc) continue;
			if (agrees(f, local, remoteNow, this.listIdFor)) continue;
			if (lc && rc) (localTime > remoteTime ? push : pull).push(f);
			else (lc ? push : pull).push(f);
		}

		let current = task;
		if (push.length > 0 && !current) current = await this.fetchOrUnlink(s, id);
		if (push.length > 0 && !current) return;

		let pullAll = false;
		const patchFields = push.filter((f) => f !== 'status');
		if (patchFields.length > 0 && current) {
			const input = await this.patchFor(patchFields, local, s, snap, current);
			if (Object.keys(input).length > 0) {
				current = await this.api.updateTask(id, input);
				this.report.sent++;
			}
		}
		if (push.includes('status') && current) {
			if (local.status === 'open') {
				current = await this.api.reopen(id);
				this.report.reopened++;
			} else {
				if (current.status !== 'open') current = await this.api.reopen(id);
				const result = await this.api.complete(id, local.status);
				this.report.completed++;
				current = result.next ?? result.completed;
				// A repeating task moved on: the line takes the next dates and opens again.
				if (result.next) pullAll = true;
			}
		}

		let next = s.line;
		const pullFields = pullAll ? FIELDS.filter((f) => f !== 'title' && f !== 'tags' && f !== 'list') : pull;
		if (pullFields.length > 0 && current) {
			next = this.applyPull(s.line, pullFields, current, snap ? snap.remote.tags : null);
			if (renderLine(next) !== s.text) {
				await this.writeLine(s, next);
				this.report.received++;
			}
		}
		this.state.snaps[id] = {
			path: s.path,
			local: localValues(next, this.ignored),
			remote: current ? remoteValues(current) : remoteNow,
		};
	}

	private async fetchOrUnlink(s: ScannedLine, id: string): Promise<ApiTask | undefined> {
		try {
			const t = await this.api.task(id);
			if (!t.deletedAt) return t;
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
		await this.writeLine(s, this.unlinkedLine(s.line));
		delete this.state.snaps[id];
		this.report.unlinked++;
		return undefined;
	}

	private async patchFor(fields: Field[], local: LocalValues, s: ScannedLine, snap: Snapshot | undefined, task: ApiTask): Promise<TaskInput> {
		const input: TaskInput = {};
		for (const f of fields) {
			switch (f) {
				case 'title':
					if (local.title) input.title = local.title;
					break;
				case 'list':
					input.listId = await this.ensureListId(s.peckListTag);
					break;
				case 'tags': {
					if (!snap) {
						input.tags = local.tags;
						break;
					}
					const before = new Set(snap.local.tags.map((t) => t.toLowerCase()));
					const now = new Set(local.tags.map((t) => t.toLowerCase()));
					const add = local.tags.filter((t) => !before.has(t.toLowerCase()));
					const remove = snap.local.tags
						.filter((t) => !now.has(t.toLowerCase()))
						.map((t) => task.tags.find((r) => tagForRemote(r) === tagForRemote(t)) ?? t);
					if (add.length > 0) input.addTags = add;
					if (remove.length > 0) input.removeTags = remove;
					break;
				}
				case 'priority':
					input.priority = local.priority;
					break;
				case 'due':
					input.due = local.due
						? { at: withDatePart(local.due, task.due?.at), ...(task.due ? { allDay: task.due.allDay, timeZone: task.due.timeZone } : {}) }
						: null;
					break;
				case 'scheduled': {
					if (!local.scheduled) {
						input.schedule = null;
						break;
					}
					const start = withDatePart(local.scheduled, task.schedule?.start);
					const end = task.schedule?.end && task.schedule.end >= start ? task.schedule.end : null;
					input.schedule = task.schedule
						? { start, end, allDay: task.schedule.allDay, timeZone: task.schedule.timeZone }
						: { start };
					break;
				}
				case 'recurrence': {
					if (local.recurrence === null) input.recurrence = null;
					else {
						const rule = tasksToRrule(local.recurrence);
						if (rule) input.recurrence = rule;
					}
					break;
				}
				case 'status':
					break;
			}
		}
		return input;
	}

	private applyPull(line: TaskLine, fields: readonly Field[], task: ApiTask, baseTags: string[] | null): TaskLine {
		let next = line;
		for (const f of fields) {
			switch (f) {
				case 'title':
					if (task.title.trim()) next = withTitle(next, task.title);
					break;
				case 'list': {
					const tag = this.tagForListId(task.listId);
					const current = localValues(next, this.ignored).listTag;
					if (tag && tagKey(tag) !== current) next = withReplacedTag(next, isPeckListTag, tag);
					break;
				}
				case 'tags': {
					const onLine = localValues(next, this.ignored).tags;
					const base = baseTags ?? onLine;
					const baseKeys = new Set(base.map(tagForRemote));
					const remoteKeys = new Set(task.tags.map(tagForRemote));
					const lineKeys = new Set(onLine.map(tagForRemote));
					const remove = new Set([...baseKeys].filter((k) => !remoteKeys.has(k)));
					next = withoutTags(next, (t) => !isPeckListTag(t) && remove.has(tagForRemote(t)));
					const add: string[] = [];
					for (const t of task.tags) {
						const key = tagForRemote(t);
						if (baseKeys.has(key) && baseTags !== null) continue;
						if (lineKeys.has(key)) continue;
						const written = obsidianTag(t);
						if (written) {
							add.push(written);
							lineKeys.add(key);
						}
					}
					next = withAddedTags(next, add);
					break;
				}
				case 'priority':
					next = withPriority(next, task.priority);
					break;
				case 'due':
					next = withField(next, 'due', task.due ? task.due.at.slice(0, 10) : null);
					break;
				case 'scheduled':
					next = withField(next, 'scheduled', task.schedule ? task.schedule.start.slice(0, 10) : null);
					break;
				case 'recurrence': {
					if (!task.recurrence) next = withField(next, 'recurrence', null);
					else {
						const text = rruleToTasks(task.recurrence);
						if (text) next = withField(next, 'recurrence', text);
					}
					break;
				}
				case 'status':
					next = withStatus(next, task.status, task.status === 'open' ? null : localDate(task.completedAt, this.now()));
					break;
			}
		}
		return next;
	}

	// --- Deleted lines ---

	private async syncDeleted(groups: Map<string, ScannedLine[]>, allowMany: boolean): Promise<void> {
		const gone: HeldDeletion[] = [];
		for (const [id, snap] of Object.entries(this.state.snaps)) {
			if (groups.has(id)) continue;
			if (excludedBy(snap.path, this.options.exclusions)) {
				// Moved out of sync on purpose: forget the link, leave the task.
				delete this.state.snaps[id];
				this.report.unlinked++;
				continue;
			}
			gone.push({ id, title: snap.local.title, path: snap.path });
		}
		if (gone.length === 0) return;
		const linked = Object.keys(this.state.snaps).length;
		if (!allowMany && gone.length > Math.max(5, Math.ceil(linked * 0.2))) {
			this.report.held = gone;
			return;
		}
		for (const g of gone) {
			try {
				await this.api.deleteTask(g.id);
			} catch (e) {
				if (!isNotFound(e)) {
					if (isFatal(e)) throw e;
					this.report.errors.push({ path: g.path, title: g.title, message: e instanceof Error ? e.message : String(e) });
					continue;
				}
			}
			delete this.state.snaps[g.id];
			this.report.trashed++;
		}
	}

	// --- New lines ---

	private async createNew(lines: ScannedLine[]): Promise<void> {
		const byPath = new Map<string, ScannedLine[]>();
		for (const s of lines) {
			if (s.id || s.off || !s.peckListTag) continue;
			if (!isNewCandidate(s)) {
				if (statusOf(s.line) !== 'open') this.report.skippedClosed++;
				continue;
			}
			const list = byPath.get(s.path) ?? [];
			list.push(s);
			byPath.set(s.path, list);
		}
		for (const [path, candidates] of byPath) {
			// The id goes into the note before the task is made, so a retry from any device can't duplicate it.
			const assigned: { s: ScannedLine; id: string; text: string }[] = [];
			await this.vault.edit(path, (content) => {
				let text = content;
				for (const s of candidates) {
					const id = this.newId();
					const lineText = renderLine(withMarker(s.line, { kind: 'id', id }));
					const changed = replaceLine(text, s.lineNo, s.text, lineText);
					if (changed === null) continue;
					text = changed;
					assigned.push({ s, id, text: lineText });
				}
				return assigned.length > 0 ? text : null;
			});
			for (const a of assigned) {
				a.s.text = a.text;
				a.s.line = withMarker(a.s.line, { kind: 'id', id: a.id });
				a.s.id = a.id;
				try {
					await this.create(a.s, a.id);
				} catch (e) {
					if (isFatal(e)) throw e;
					this.fail(a.s, e);
				}
			}
			this.options.save?.(this.state);
		}
	}

	private async create(s: ScannedLine, id: string): Promise<void> {
		const local = localValues(s.line, this.ignored);
		if (!local.title) return;
		const input: TaskInput = { id, title: local.title, listId: await this.ensureListId(s.peckListTag) };
		if (local.priority > 0) input.priority = local.priority;
		if (local.due) input.due = { at: local.due };
		if (local.scheduled) input.schedule = { start: local.scheduled };
		if (local.tags.length > 0) input.tags = local.tags;
		const rule = local.recurrence ? tasksToRrule(local.recurrence) : null;
		if (rule) input.recurrence = rule;
		if (this.options.addNoteLink) input.notes = `From Obsidian: ${this.vault.noteLink(s.path)}`;
		let task: ApiTask;
		try {
			task = await this.api.createTask(input);
		} catch (e) {
			if (!(e instanceof ApiError && e.code === 'id_taken')) throw e;
			// The id belongs to something this account can't use: give the line a fresh one.
			const fresh = this.newId();
			await this.writeLine(s, withMarker(s.line, { kind: 'id', id: fresh }));
			s.id = fresh;
			task = await this.api.createTask({ ...input, id: fresh });
		}
		if (local.status !== 'open') {
			const result = await this.api.complete(task.id, local.status);
			task = result.completed;
		}
		this.report.created++;
		this.state.snaps[task.id] = { path: s.path, local: localValues(s.line, this.ignored), remote: remoteValues(task) };
	}
}
