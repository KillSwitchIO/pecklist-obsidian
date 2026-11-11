// The parts of PeckList's Task API v1 this plugin uses. v1 only ever gains fields, so every
// shape here is a subset and unknown fields are ignored.

export interface ApiSchedule {
	start: string;
	end: string | null;
	allDay: boolean;
	timeZone: string;
}

export interface ApiDue {
	at: string;
	allDay: boolean;
	timeZone: string;
}

export type ApiStatus = 'open' | 'done' | 'wontdo';

export interface ApiTask {
	id: string;
	title: string;
	notes: string;
	listId: string | null;
	sectionId: string | null;
	parentId: string | null;
	status: ApiStatus;
	completedAt: string | null;
	priority: number;
	schedule: ApiSchedule | null;
	due: ApiDue | null;
	tags: string[];
	recurrence: string | null;
	updatedAt: string | null;
	deletedAt: string | null;
}

export interface ApiList {
	id: string;
	name: string;
	archived: boolean;
	isInbox: boolean;
	role: string | null;
	deletedAt: string | null;
}

export interface ApiMe {
	id: string;
	username: string;
	role: string;
	key: { id: string; name: string; scopes: string[] } | null;
}

export interface ApiChanges {
	cursor: string;
	more: boolean;
	tasks: ApiTask[];
	lists: ApiList[];
	revoked: string[];
}

export interface ApiCompleted {
	completed: ApiTask;
	next: ApiTask | null;
}

/** The fields a create or a change may send. Left out: unchanged. null: cleared. */
export interface TaskInput {
	id?: string;
	title?: string;
	notes?: string;
	listId?: string;
	priority?: number;
	schedule?: { start: string; end?: string | null; allDay?: boolean; timeZone?: string } | null;
	due?: { at: string; allDay?: boolean; timeZone?: string } | null;
	tags?: string[];
	addTags?: string[];
	removeTags?: string[];
	recurrence?: string | null;
}

export interface CliStarted {
	userCode: string;
	approveUrl: string | null;
	pollToken: string;
	interval: number;
	expiresIn: number;
}

export interface CliCollected {
	token: string;
	key: { id: string; name: string; scopes: string[] };
}
