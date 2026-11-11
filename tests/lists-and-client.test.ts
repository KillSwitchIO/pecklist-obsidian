import { describe, expect, it } from 'vitest';
import { ApiError, PeckListClient } from '../src/api/client';
import { listKey, nameFromListPart, tagForList, tagKey } from '../src/core/lists';
import { ULID_PATTERN, ulid } from '../src/core/ulid';

describe('list tags', () => {
	it('matches a tag to a list whatever stands in for the spaces', () => {
		expect(listKey('Home Projects')).toBe('home-projects');
		expect(tagKey('pecklist/Home_Projects')).toBe('pecklist/home-projects');
		expect(tagKey('PeckList/home-projects')).toBe('pecklist/home-projects');
		expect(tagKey('pecklist')).toBe('pecklist');
	});

	it('writes a list name as a valid tag, and names a new list from a tag', () => {
		expect(tagForList('Home Projects')).toBe('pecklist/Home-Projects');
		expect(tagForList('Bills & Money')).toBe('pecklist/Bills-Money');
		expect(tagForList(null)).toBe('pecklist');
		expect(nameFromListPart('Home-Projects')).toBe('Home Projects');
	});
});

describe('ulid', () => {
	it('makes ids the Task API accepts', () => {
		for (let i = 0; i < 20; i++) expect(ulid()).toMatch(ULID_PATTERN);
	});
});

describe('PeckListClient', () => {
	it('sends the key and reads problem+json errors', async () => {
		const seen: { url: string; auth?: string }[] = [];
		const client = new PeckListClient('https://tasks.example.com/', 'pl_x_y', async (r) => {
			seen.push({ url: r.url, auth: r.headers.Authorization });
			return {
				status: 404,
				headers: { 'content-type': 'application/problem+json' },
				text: JSON.stringify({ status: 404, code: 'not_found', detail: 'no task' }),
			};
		});
		await expect(client.task('A')).rejects.toMatchObject({ status: 404, code: 'not_found' });
		expect(seen[0]).toEqual({ url: 'https://tasks.example.com/api/v1/tasks/A', auth: 'Bearer pl_x_y' });
	});

	it('waits as Retry-After says on 429, then gives up', async () => {
		const waits: number[] = [];
		let calls = 0;
		const client = new PeckListClient(
			'https://t.example',
			'k',
			async () => {
				calls++;
				return { status: 429, headers: { 'Retry-After': '7' }, text: '{"code":"rate_limited"}' };
			},
			{ sleep: async (ms) => void waits.push(ms), retries: 2 },
		);
		const error = await client.me().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(calls).toBe(3);
		expect(waits).toEqual([7000, 7000]);
	});

	it('answers 204 with nothing', async () => {
		const client = new PeckListClient('https://t.example', 'k', async () => ({ status: 204, headers: {}, text: '' }));
		await expect(client.deleteTask('A')).resolves.toBeUndefined();
	});
});
