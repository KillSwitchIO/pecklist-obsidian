// A small client for PeckList's Task API v1 (`/api/v1/`). The HTTP call itself is a port, so
// the plugin uses Obsidian's requestUrl (no CORS, works on mobile) and the tests use a fake or
// fetch.

import type {
	ApiChanges,
	ApiCompleted,
	ApiList,
	ApiMe,
	ApiTask,
	CliCollected,
	CliStarted,
	TaskInput,
} from './types';

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** An error answer from the server, read from its problem+json body. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: string,
		readonly retryAfter: number | null = null,
	) {
		super(`${status} ${code}${detail ? `: ${detail}` : ''}`);
		this.name = 'ApiError';
	}
}

export interface ClientOptions {
	/** Waits between retries on 429 and 503; replaced in tests. */
	sleep?: (ms: number) => Promise<void>;
	/** How many times a 429 or 503 is retried before giving up. */
	retries?: number;
}

export function normalizeServerUrl(url: string): string {
	return url.trim().replace(/\/+$/u, '');
}

export class PeckListClient {
	private readonly base: string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly retries: number;

	constructor(
		serverUrl: string,
		private readonly token: string | null,
		private readonly http: Http,
		options: ClientOptions = {},
	) {
		this.base = normalizeServerUrl(serverUrl);
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
		this.retries = options.retries ?? 3;
	}

	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		for (let attempt = 0; ; attempt++) {
			const response = await this.http({
				url: this.base + path,
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.status >= 200 && response.status < 300) {
				if (response.status === 204 || response.text === '') return undefined as T;
				return JSON.parse(response.text) as T;
			}
			const error = readProblem(response);
			if ((error.status === 429 || error.status === 503) && attempt < this.retries && error.code !== 'slow_down') {
				await this.sleep(Math.min(60, Math.max(1, error.retryAfter ?? 2 ** attempt)) * 1000);
				continue;
			}
			throw error;
		}
	}

	me(): Promise<ApiMe> {
		return this.call('GET', '/api/v1/me');
	}

	async lists(): Promise<ApiList[]> {
		const page = await this.call<{ items: ApiList[] }>('GET', '/api/v1/lists');
		return page.items;
	}

	async tags(): Promise<{ id: string; name: string }[]> {
		const page = await this.call<{ items: { id: string; name: string; deletedAt?: string | null }[] }>('GET', '/api/v1/tags');
		return page.items.filter((t) => !t.deletedAt);
	}

	createList(id: string, name: string): Promise<ApiList> {
		return this.call('POST', '/api/v1/lists', { id, name });
	}

	task(id: string): Promise<ApiTask> {
		return this.call('GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
	}

	createTask(input: TaskInput): Promise<ApiTask> {
		return this.call('POST', '/api/v1/tasks', input);
	}

	updateTask(id: string, input: TaskInput): Promise<ApiTask> {
		return this.call('PATCH', `/api/v1/tasks/${encodeURIComponent(id)}`, input);
	}

	complete(id: string, status: 'done' | 'wontdo'): Promise<ApiCompleted> {
		return this.call('POST', `/api/v1/tasks/${encodeURIComponent(id)}/complete`, { status });
	}

	reopen(id: string): Promise<ApiTask> {
		return this.call('POST', `/api/v1/tasks/${encodeURIComponent(id)}/reopen`, {});
	}

	deleteTask(id: string): Promise<void> {
		return this.call('DELETE', `/api/v1/tasks/${encodeURIComponent(id)}`);
	}

	changes(cursor: string | null, limit = 500): Promise<ApiChanges> {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor) query.set('cursor', cursor);
		return this.call('GET', `/api/v1/changes?${query.toString()}`);
	}

	// Signing in with a code approved in the browser (the same flow as the PeckList CLI).

	startSignIn(name: string): Promise<CliStarted> {
		return this.call('POST', '/api/v1/cli/sign-in', { name, admin: false });
	}

	pollSignIn(pollToken: string): Promise<CliCollected> {
		return this.call('POST', '/api/v1/cli/sign-in/poll', { pollToken });
	}

	/** Revokes the key this client signs in with. */
	signOut(): Promise<void> {
		return this.call('DELETE', '/api/v1/cli/sign-in');
	}
}

function readProblem(response: HttpResponse): ApiError {
	let code = `http_${response.status}`;
	let detail = '';
	try {
		const problem = JSON.parse(response.text) as { code?: unknown; detail?: unknown; title?: unknown };
		if (typeof problem.code === 'string') code = problem.code;
		if (typeof problem.detail === 'string') detail = problem.detail;
		else if (typeof problem.title === 'string') detail = problem.title;
	} catch {
		detail = response.text.slice(0, 200);
	}
	const retry = headerValue(response.headers, 'retry-after');
	const seconds = retry === null ? null : Number(retry);
	return new ApiError(response.status, code, detail, seconds !== null && Number.isFinite(seconds) ? seconds : null);
}

function headerValue(headers: Record<string, string>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
	return null;
}
