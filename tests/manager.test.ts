import { beforeEach, describe, expect, it } from 'vitest';
import { type EngineOptions, SyncEngine, type SyncState, emptyState } from '../src/sync/engine';
import { buildOverview } from '../src/sync/overview';
import { scanNote } from '../src/sync/scan';
import { Clock, FakeServer, FakeVault, testId } from './fakes';

let clock: Clock;
let server: FakeServer;
let vault: FakeVault;
let state: SyncState;

function engine(options: Partial<EngineOptions> = {}): SyncEngine {
	return new SyncEngine(vault, server.api(), state, {
		defaultListId: null,
		exclusions: { folders: ['Templates'], notes: [] },
		ignoredTags: ['task'],
		addNoteLink: false,
		vaultTag: 'obsidian/Home',
		newId: testId,
		now: () => new Date(clock.ms),
		...options,
	});
}

const lineOf = (path: string, n = 0) => vault.text(path).split('\n')[n] ?? '';
const idOf = (text: string) => /pecklist:: ([0-9A-Z]+)/u.exec(text)?.[1] ?? '';

beforeEach(() => {
	clock = new Clock();
	server = new FakeServer(clock);
	vault = new FakeVault(clock);
	state = emptyState('https://tasks.example.com', 'U1');
	state.firstSyncDone = true;
});

describe('task manager actions', () => {
	it('unlinking takes the link and the PeckList tag off, and the task stays', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard');
		await engine().sync();
		const text = lineOf('Home.md');
		const id = idOf(text);
		expect(await engine().unlinkLine('Home.md', 0, text)).toBe(true);
		expect(lineOf('Home.md')).toBe('- [ ] Mow #yard');
		expect(state.snaps[id]).toBeUndefined();
		const report = await engine().sync();
		expect(report.trashed).toBe(0);
		expect(server.tasks.get(id)?.deletedAt).toBeNull();
	});

	it('leaving out a linked line marks it off and never trashes the task', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await engine().sync();
		const text = lineOf('Home.md');
		const id = idOf(text);
		expect(await engine().leaveOutLine('Home.md', 0, text)).toBe(true);
		expect(lineOf('Home.md')).toBe('- [ ] Mow %%[pecklist:: off]%% #pecklist');
		await engine().sync();
		expect(server.tasks.get(id)?.deletedAt).toBeNull();
	});

	it('re-linking gives the line the other task’s values and keeps the old task', async () => {
		vault.write('Home.md', '- [ ] Old line #pecklist 📅 2026-11-20');
		await engine().sync();
		const text = lineOf('Home.md');
		const oldId = idOf(text);
		server.seed({ id: 'T-OTHER', title: 'Call the plumber', listId: 'L-WORK', tags: ['phone'], priority: 3, due: { at: '2026-11-14', allDay: true, timeZone: 'America/Chicago' } });
		expect(await engine().relinkLine('Home.md', 0, text, 'T-OTHER')).toBe(true);
		expect(lineOf('Home.md')).toBe('- [ ] Call the plumber %%[pecklist:: T-OTHER]%% #pecklist/Work #phone ⏫ 📅 2026-11-14');
		const report = await engine().sync();
		expect(report.trashed).toBe(0);
		expect(server.tasks.get(oldId)?.deletedAt).toBeNull();
		// The snapshot was written with the link, so nothing was pushed back.
		expect(server.writes().filter((c) => c.method === 'updateTask' && c.id === 'T-OTHER' && c.body && 'title' in c.body)).toHaveLength(0);
	});

	it('adds a PeckList task to the end of a note, linked', async () => {
		vault.write('Errands.md', '# Errands\n- [ ] Stamps #pecklist');
		server.seed({ id: 'T-NEW', title: 'Pick up the cake', tags: ['party'] });
		expect(await engine().addToNote('Errands.md', 'T-NEW')).toBe(true);
		expect(vault.text('Errands.md')).toBe('# Errands\n- [ ] Stamps #pecklist\n- [ ] Pick up the cake %%[pecklist:: T-NEW]%% #pecklist #party\n');
		await engine().sync();
		expect(server.tasks.get('T-NEW')?.title).toBe('Pick up the cake');
		expect(server.tasks.get('T-NEW')?.tags).toContain('obsidian/Home');
	});

	it('splitting a copied line makes it a task of its own', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await engine().sync();
		const text = lineOf('Home.md');
		vault.write('Other.md', text);
		expect(await engine().splitLine('Other.md', 0, text)).toBe(true);
		await engine().sync();
		expect(idOf(lineOf('Other.md'))).not.toBe(idOf(text));
	});

	it('lists open PeckList tasks', async () => {
		server.seed({ id: 'T1', title: 'One' });
		server.seed({ id: 'T2', title: 'Two', status: 'done' });
		expect((await engine().openTasks()).map((t) => t.id)).toEqual(['T1']);
	});
});

describe('the overview', () => {
	const names = { listNameForTag: (t: string | null) => (t && t.includes('/') ? t.split('/')[1] ?? '' : 'Inbox'), listNameForId: (id: string | null) => (id === 'L-WORK' ? 'Work' : 'Inbox') };

	it('gives each line, gone link and PeckList-only task a state', async () => {
		vault.write('Home.md', ['- [ ] Synced #pecklist', '- [ ] Will change #pecklist', '- [ ] Gone soon #pecklist'].join('\n'));
		await engine().sync();
		const [synced, change, gone] = vault.text('Home.md').split('\n') as [string, string, string];
		vault.write(
			'Home.md',
			[
				synced,
				change.replace('Will change', 'Changed'),
				'- [ ] Brand new #pecklist/Work',
				'- [x] Done early #pecklist ✅ 2026-11-01',
				'- [ ] Private %%[pecklist:: off]%% #pecklist',
				'- [ ] #pecklist',
				synced,
			].join('\n'),
		);
		vault.write('Templates/Daily.md', '- [ ] Template #pecklist');
		server.seed({ id: 'T-REMOTE', title: 'Only in PeckList', listId: 'L-WORK' });
		const lines = [...scanNote('Home.md', vault.text('Home.md')), ...scanNote('Templates/Daily.md', vault.text('Templates/Daily.md'))];
		const rows = buildOverview({
			lines,
			snaps: state.snaps,
			errors: [],
			remoteTasks: [...server.tasks.values()],
			exclusions: { folders: ['Templates'], notes: [] },
			ignoredTags: ['task'],
			...names,
		});
		const by = (title: string) => rows.filter((r) => r.title === title).map((r) => r.state);
		expect(by('Synced')).toEqual(['synced', 'attention']);
		expect(by('Changed')).toEqual(['changed']);
		expect(by('Brand new')).toEqual(['new']);
		expect(rows.find((r) => r.title === 'Brand new')?.listName).toBe('Work');
		expect(by('Done early')).toEqual(['skipped']);
		expect(by('Private')).toEqual(['off']);
		expect(by('(no text)')).toEqual(['attention']);
		expect(by('Template')).toEqual(['excluded']);
		expect(by('Gone soon')).toEqual(['attention']);
		expect(rows.find((r) => r.title === 'Gone soon')?.kind).toBe('missing');
		expect(rows.find((r) => r.title === 'Only in PeckList')).toMatchObject({ kind: 'remote', state: 'remote', listName: 'Work' });
		// Linked tasks aren't listed again as PeckList-only.
		expect(rows.filter((r) => r.kind === 'remote')).toHaveLength(1);
		void gone;
	});
});
