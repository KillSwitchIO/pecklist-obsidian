// The sync engine against a real PeckList server. Run against a throwaway local container, never
// a server with real data:
//
//   PECKLIST_URL=http://localhost:18181 PECKLIST_TOKEN=pl_... npm run test:contract
//
// PECKLIST_COOKIE (a signed-in web session for the same account) also checks the browser sign-in.

import { beforeAll, describe, expect, it } from 'vitest';
import { type Http, PeckListClient } from '../../src/api/client';
import { ulid } from '../../src/core/ulid';
import { SyncEngine, type SyncState, emptyState } from '../../src/sync/engine';
import { Clock, FakeVault } from '../fakes';

const url = process.env.PECKLIST_URL ?? '';
const token = process.env.PECKLIST_TOKEN ?? '';
const cookie = process.env.PECKLIST_COOKIE ?? '';
const run = url && token ? describe : describe.skip;

const requests: { method: string; url: string }[] = [];
const http: Http = async (r) => {
	requests.push({ method: r.method, url: r.url });
	const response = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => (headers[k] = v));
	return { status: response.status, headers, text: await response.text() };
};
const writes = () => requests.filter((r) => r.method !== 'GET');

let client: PeckListClient;
let listId: string;
let vault: FakeVault;
let state: SyncState;

function engine(vaultTag: string | null = null): SyncEngine {
	return new SyncEngine(vault, client, state, {
		defaultListId: listId,
		exclusions: { folders: [], notes: [] },
		ignoredTags: ['task'],
		addNoteLink: true,
		vaultTag,
	});
}

function idIn(path: string, lineNo = 0): string {
	const m = /pecklist:: ([0-9A-Z]+)/u.exec(vault.text(path).split('\n')[lineNo] ?? '');
	if (!m?.[1]) throw new Error(`no id on line ${lineNo}:\n${vault.text(path)}`);
	return m[1];
}

run('against a real server', () => {
	beforeAll(async () => {
		client = new PeckListClient(url, token, http);
		const list = await client.createList(ulid(), `Obsidian contract ${new Date().toISOString().slice(0, 19)}`);
		listId = list.id;
		vault = new FakeVault(new Clock(Date.now()));
		state = emptyState(url, null);
		state.firstSyncDone = true;
	});

	it('makes tasks from lines with every synced field', async () => {
		vault.write(
			'Home.md',
			[
				'- [ ] Mow the lawn #task #pecklist #yard/front ⏫ 🔁 every week on Saturday ⏳ 2026-11-14 📅 2026-11-15',
				'- [ ] Plain one #pecklist',
			].join('\n'),
		);
		const report = await engine().sync();
		expect(report.errors).toEqual([]);
		expect(report.created).toBe(2);
		const task = await client.task(idIn('Home.md'));
		expect(task).toMatchObject({
			title: 'Mow the lawn',
			listId,
			priority: 3,
			tags: ['yard/front'],
			recurrence: 'FREQ=WEEKLY;BYDAY=SA',
		});
		expect(task.due?.at).toBe('2026-11-15');
		expect(task.schedule?.start).toBe('2026-11-14');
		expect(task.notes).toContain('obsidian://open?vault=Test&file=Home.md');
	});

	it('sends nothing on a second run', async () => {
		requests.length = 0;
		const before = vault.text('Home.md');
		await engine().sync();
		expect(writes()).toEqual([]);
		expect(vault.text('Home.md')).toBe(before);
	});

	it('sends a note edit field by field', async () => {
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace('Mow the lawn', 'Mow the back lawn').replace('#yard/front', '#yard/back').replace('📅 2026-11-15', '📅 2026-11-16'));
		const report = await engine().sync();
		expect(report.errors).toEqual([]);
		const task = await client.task(id);
		expect(task.title).toBe('Mow the back lawn');
		expect(task.tags).toEqual(['yard/back']);
		expect(task.due?.at).toBe('2026-11-16');
		requests.length = 0;
		await engine().sync();
		expect(writes()).toEqual([]);
	});

	it('writes a change made in PeckList into the line', async () => {
		const id = idIn('Home.md', 1);
		await client.updateTask(id, { title: 'Plain one, renamed', priority: 2, addTags: ['errands'], due: { at: '2026-11-20' } });
		const report = await engine().sync();
		expect(report.errors).toEqual([]);
		expect(vault.text('Home.md').split('\n')[1]).toBe(`- [ ] Plain one, renamed %%[pecklist:: ${id}]%% #pecklist #errands 🔼 📅 2026-11-20`);
		requests.length = 0;
		await engine().sync();
		expect(writes()).toEqual([]);
	});

	it('completes a repeating task once when the Tasks plugin writes the next line', async () => {
		const id = idIn('Home.md');
		const [first = '', second = ''] = vault.text('Home.md').split('\n');
		const next = first.replace('⏳ 2026-11-14', '⏳ 2026-11-21').replace('📅 2026-11-16', '📅 2026-11-23');
		const closed = `${first.replace('- [ ]', '- [x]')} ✅ 2026-11-11`;
		vault.write('Home.md', [next, closed, second].join('\n'));
		requests.length = 0;
		const report = await engine().sync();
		expect(report.errors).toEqual([]);
		expect(requests.filter((r) => r.url.endsWith('/complete'))).toHaveLength(1);
		const task = await client.task(id);
		expect(task.status).toBe('open');
		const line = vault.text('Home.md').split('\n')[0] ?? '';
		expect(line).toContain(`📅 ${task.due?.at.slice(0, 10)}`);
		expect(line).toContain(`⏳ ${task.schedule?.start.slice(0, 10)}`);
		// The closed line links to PeckList's closed copy, which doesn't repeat, and drops its 🔁,
		// so unticking it reopens that copy instead of making a second repeating task.
		const closedId = idIn('Home.md', 1);
		expect(closedId).not.toBe(id);
		expect(vault.text('Home.md').split('\n')[1]).not.toContain('🔁');
		const copy = await client.task(closedId);
		expect(copy.status).toBe('done');
		expect(copy.recurrence).toBeNull();
		requests.length = 0;
		await engine().sync();
		expect(writes()).toEqual([]);
	});

	it('ticks the line when the task is done in PeckList, and reopens', async () => {
		vault.write('Chores.md', '- [ ] Take out the bins #pecklist');
		await engine().sync();
		const id = idIn('Chores.md');
		await client.complete(id, 'done');
		await engine().sync();
		expect(vault.text('Chores.md')).toMatch(/^- \[x\] Take out the bins .* ✅ \d{4}-\d{2}-\d{2}$/u);
		vault.write('Chores.md', vault.text('Chores.md').replace('- [x]', '- [ ]').replace(/ ✅ \d{4}-\d{2}-\d{2}$/u, ''));
		await engine().sync();
		expect((await client.task(id)).status).toBe('open');
	});

	it('trashes the task when its line goes, and unlinks a line whose task is deleted in PeckList', async () => {
		const chore = idIn('Chores.md');
		vault.write('Chores.md', '');
		await engine().sync();
		expect((await client.task(chore)).deletedAt).not.toBeNull();

		const plain = idIn('Home.md', 2);
		await client.deleteTask(plain);
		await engine().sync();
		expect(vault.text('Home.md').split('\n')[2]).toBe('- [ ] Plain one, renamed #errands 🔼 📅 2026-11-20');
	});

	it('swaps the vault tag on linked tasks when it changes, and takes it off when cleared', async () => {
		vault.write('Tagged.md', '- [ ] Vault tag check #task #pecklist #errands');
		await engine('obsidian/Contract').sync();
		const id = idIn('Tagged.md');
		expect((await client.task(id)).tags.sort()).toEqual(['errands', 'obsidian/contract']);
		await engine('contract-2').sync();
		expect((await client.task(id)).tags.sort()).toEqual(['contract-2', 'errands']);
		await engine(null).sync();
		expect((await client.task(id)).tags).toEqual(['errands']);
		expect(vault.text('Tagged.md')).not.toMatch(/contract/iu);
	});

	it('repeating a create with the same id makes no second task', async () => {
		const id = ulid();
		const a = await client.createTask({ id, title: 'Once', listId });
		const b = await client.createTask({ id, title: 'Once', listId });
		expect(b.id).toBe(a.id);
	});

	(cookie ? it : it.skip)('signs in with a code approved in the browser, and signs out', async () => {
		const anonymous = new PeckListClient(url, null, http, { retries: 0 });
		const started = await anonymous.startSignIn('Obsidian contract test');
		expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
		await expect(anonymous.pollSignIn(started.pollToken)).rejects.toMatchObject({ code: 'pending' });
		const approve = await fetch(`${url}/api/v1/cli/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', cookie },
			body: JSON.stringify({ userCode: started.userCode }),
		});
		expect(approve.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, started.interval * 1000));
		const collected = await anonymous.pollSignIn(started.pollToken);
		expect(collected.key.scopes).toEqual(['tasks:read', 'tasks:write']);
		const signedIn = new PeckListClient(url, collected.token, http, { retries: 0 });
		expect((await signedIn.me()).key?.name).toBe('CLI: Obsidian contract test');
		await signedIn.signOut();
		await expect(signedIn.me()).rejects.toMatchObject({ status: 401 });
	});
});
