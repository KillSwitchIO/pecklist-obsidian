// In-memory stand-ins for a PeckList server (the v1 behaviour the plugin relies on) and a vault.

import { ApiError } from '../src/api/client';
import type { ApiChanges, ApiCompleted, ApiList, ApiTask, TaskInput } from '../src/api/types';
import type { Api, VaultPort } from '../src/sync/engine';

export class Clock {
	constructor(public ms = Date.parse('2026-11-11T12:00:00.000Z')) {}
	tick(): number {
		this.ms += 1000;
		return this.ms;
	}
}

let counter = 0;
export function testId(): string {
	counter++;
	return `01TEST${String(counter).padStart(20, '0')}`;
}

export interface Call {
	method: string;
	id?: string;
	body?: unknown;
}

function addDays(date: string, days: number): string {
	const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10) + date.slice(10);
}

export class FakeServer {
	tasks = new Map<string, ApiTask>();
	lists: ApiList[] = [
		{ id: 'L-INBOX', name: 'Inbox', archived: false, isInbox: true, role: 'owner', deletedAt: null },
		{ id: 'L-WORK', name: 'Work', archived: false, isInbox: false, role: 'owner', deletedAt: null },
	];
	calls: Call[] = [];
	private seq = 0;
	private changed = new Map<string, number>();
	private revoked: { id: string; seq: number }[] = [];
	/** Ids that belong to something the account can't see. */
	taken = new Set<string>();

	constructor(private readonly clock: Clock) {}

	writes(): Call[] {
		return this.calls.filter((c) => c.method !== 'changes' && c.method !== 'lists' && c.method !== 'task');
	}

	private touch(t: ApiTask): ApiTask {
		t.updatedAt = new Date(this.clock.tick()).toISOString();
		this.changed.set(t.id, ++this.seq);
		return t;
	}

	private get(id: string): ApiTask {
		const t = this.tasks.get(id);
		if (!t) throw new ApiError(404, 'not_found', `no task ${id} that you can see`);
		return t;
	}

	/** A change made in the PeckList app. */
	edit(id: string, change: Partial<ApiTask>): ApiTask {
		const t = this.get(id);
		Object.assign(t, change);
		return structuredClone(this.touch(t));
	}

	revoke(id: string): void {
		this.tasks.delete(id);
		this.revoked.push({ id, seq: ++this.seq });
	}

	seed(task: Partial<ApiTask> & { id: string; title: string }): ApiTask {
		const t: ApiTask = {
			notes: '',
			listId: 'L-INBOX',
			sectionId: null,
			parentId: null,
			status: 'open',
			completedAt: null,
			priority: 0,
			schedule: null,
			due: null,
			tags: [],
			recurrence: null,
			updatedAt: null,
			deletedAt: null,
			...task,
		};
		this.tasks.set(t.id, t);
		return structuredClone(this.touch(t));
	}

	private apply(t: ApiTask, input: TaskInput): void {
		if (input.title !== undefined) t.title = input.title;
		if (input.notes !== undefined) t.notes = input.notes;
		if (input.listId !== undefined) {
			if (!this.lists.some((l) => l.id === input.listId)) throw new ApiError(400, 'invalid_request', 'listId: no such list');
			t.listId = input.listId;
		}
		if (input.priority !== undefined) t.priority = input.priority;
		if (input.due !== undefined) t.due = input.due ? { at: input.due.at, allDay: input.due.allDay ?? input.due.at.length === 10, timeZone: input.due.timeZone ?? 'America/Chicago' } : null;
		if (input.schedule !== undefined)
			t.schedule = input.schedule
				? { start: input.schedule.start, end: input.schedule.end ?? null, allDay: input.schedule.allDay ?? input.schedule.start.length === 10, timeZone: input.schedule.timeZone ?? 'America/Chicago' }
				: null;
		if (input.tags !== undefined) t.tags = [...input.tags];
		if (input.addTags) for (const tag of input.addTags) if (!t.tags.includes(tag)) t.tags.push(tag);
		if (input.removeTags) t.tags = t.tags.filter((x) => !input.removeTags?.includes(x));
		if (input.recurrence !== undefined) t.recurrence = input.recurrence;
	}

	api(): Api {
		return {
			lists: async () => {
				this.calls.push({ method: 'lists' });
				return structuredClone(this.lists);
			},
			createList: async (id: string, name: string) => {
				this.calls.push({ method: 'createList', id, body: { name } });
				const list: ApiList = { id, name, archived: false, isInbox: false, role: 'owner', deletedAt: null };
				this.lists.push(list);
				return structuredClone(list);
			},
			task: async (id: string) => {
				this.calls.push({ method: 'task', id });
				return structuredClone(this.get(id));
			},
			createTask: async (input: TaskInput) => {
				this.calls.push({ method: 'createTask', id: input.id, body: input });
				if (input.id && this.taken.has(input.id)) throw new ApiError(409, 'id_taken', 'that id is used');
				if (input.id && this.tasks.has(input.id)) return structuredClone(this.get(input.id));
				const t = this.seed({ id: input.id ?? testId(), title: input.title ?? '' });
				this.apply(t, input);
				this.tasks.set(t.id, Object.assign(this.get(t.id), t));
				return structuredClone(this.touch(this.get(t.id)));
			},
			updateTask: async (id: string, input: TaskInput) => {
				this.calls.push({ method: 'updateTask', id, body: input });
				const t = this.get(id);
				this.apply(t, input);
				return structuredClone(this.touch(t));
			},
			complete: async (id: string, status: 'done' | 'wontdo'): Promise<ApiCompleted> => {
				this.calls.push({ method: 'complete', id, body: { status } });
				const t = this.get(id);
				if (t.status !== 'open') return { completed: structuredClone(t), next: null };
				const now = new Date(this.clock.tick()).toISOString();
				if (t.recurrence && (t.due || t.schedule)) {
					// As the server does: the closed copy keeps the history and doesn't repeat.
					const closed: ApiTask = { ...structuredClone(t), id: testId(), status, completedAt: now, recurrence: null };
					this.tasks.set(closed.id, closed);
					this.touch(closed);
					const days = t.recurrence.includes('WEEKLY') ? 7 : 1;
					if (t.due) t.due = { ...t.due, at: addDays(t.due.at, days) };
					if (t.schedule) t.schedule = { ...t.schedule, start: addDays(t.schedule.start, days) };
					this.touch(t);
					return { completed: structuredClone(closed), next: structuredClone(t) };
				}
				t.status = status;
				t.completedAt = now;
				return { completed: structuredClone(this.touch(t)), next: null };
			},
			reopen: async (id: string) => {
				this.calls.push({ method: 'reopen', id });
				const t = this.get(id);
				t.status = 'open';
				t.completedAt = null;
				return structuredClone(this.touch(t));
			},
			deleteTask: async (id: string) => {
				this.calls.push({ method: 'deleteTask', id });
				const t = this.get(id);
				t.deletedAt = new Date(this.clock.tick()).toISOString();
				this.touch(t);
			},
			changes: async (cursor: string | null): Promise<ApiChanges> => {
				this.calls.push({ method: 'changes' });
				const from = cursor ? Number(cursor) : 0;
				const tasks = [...this.changed.entries()]
					.filter(([, s]) => s > from)
					.map(([id]) => this.tasks.get(id))
					.filter((t): t is ApiTask => !!t)
					.map((t) => structuredClone(t));
				const revoked = this.revoked.filter((r) => r.seq > from).map((r) => r.id);
				return { cursor: String(this.seq), more: false, tasks, lists: [], revoked };
			},
		} as Api;
	}
}

export class FakeVault implements VaultPort {
	files = new Map<string, { content: string; mtime: number }>();

	constructor(private readonly clock: Clock) {}

	write(path: string, content: string): void {
		this.files.set(path, { content, mtime: this.clock.tick() });
	}

	text(path: string): string {
		return this.files.get(path)?.content ?? '';
	}

	candidatePaths(): string[] {
		return [...this.files.keys()].filter((p) => /#pecklist/iu.test(this.text(p)));
	}

	allMarkdownPaths(): string[] {
		return [...this.files.keys()];
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		return this.text(path);
	}

	mtime(path: string): number {
		return this.files.get(path)?.mtime ?? 0;
	}

	async edit(path: string, change: (content: string) => string | null): Promise<boolean> {
		const f = this.files.get(path);
		if (!f) return false;
		const next = change(f.content);
		if (next === null || next === f.content) return false;
		this.write(path, next);
		return true;
	}

	noteLink(path: string): string {
		return `obsidian://open?vault=Test&file=${encodeURIComponent(path)}`;
	}
}
