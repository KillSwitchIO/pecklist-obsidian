import { beforeEach, describe, expect, it } from 'vitest';
import { type EngineOptions, SyncEngine, type SyncState, emptyState } from '../src/sync/engine';
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
		addNoteLink: true,
		newId: testId,
		now: () => new Date(clock.ms),
		...options,
	});
}

async function sync(options: Partial<EngineOptions> = {}, allowManyDeletes = false) {
	return engine(options).sync({ allowManyDeletes });
}

function idIn(path: string, lineNo = 0): string {
	const m = /pecklist:: ([0-9A-Z]+)/u.exec(vault.text(path).split('\n')[lineNo] ?? '');
	if (!m?.[1]) throw new Error(`no id on line ${lineNo} of ${path}:\n${vault.text(path)}`);
	return m[1];
}

beforeEach(() => {
	clock = new Clock();
	server = new FakeServer(clock);
	vault = new FakeVault(clock);
	state = emptyState('https://tasks.example.com', 'U1');
	state.firstSyncDone = true;
});

describe('new lines', () => {
	it('makes a task for each open tagged line and links the line', async () => {
		vault.write(
			'Home.md',
			[
				'- [ ] Mow the lawn #task #pecklist #yard ⏫ 🔁 every week on Saturday ⏳ 2026-11-14 📅 2026-11-15',
				'- [ ] Not tagged #task',
				'- [x] Already done #pecklist ✅ 2026-11-01',
				'```',
				'- [ ] In a code block #pecklist',
				'```',
				'- [ ] Write report #pecklist/Work',
			].join('\n'),
		);
		vault.write('Templates/Daily.md', '- [ ] Template task #pecklist');

		const report = await sync();
		expect(report.created).toBe(2);
		expect(report.skippedClosed).toBe(1);

		const mowId = idIn('Home.md', 0);
		expect(vault.text('Home.md').split('\n')[0]).toBe(
			`- [ ] Mow the lawn %%[pecklist:: ${mowId}]%% #task #pecklist #yard ⏫ 🔁 every week on Saturday ⏳ 2026-11-14 📅 2026-11-15`,
		);
		const mow = server.tasks.get(mowId);
		expect(mow).toMatchObject({
			title: 'Mow the lawn',
			listId: 'L-INBOX',
			priority: 3,
			tags: ['yard'],
			recurrence: 'FREQ=WEEKLY;BYDAY=SA',
			due: { at: '2026-11-15' },
			schedule: { start: '2026-11-14' },
		});
		expect(mow?.notes).toBe('From Obsidian: obsidian://open?vault=Test&file=Home.md');
		expect(server.tasks.get(idIn('Home.md', 6))?.listId).toBe('L-WORK');
		expect(vault.text('Templates/Daily.md')).toBe('- [ ] Template task #pecklist');
		expect(vault.text('Home.md')).toContain('- [ ] In a code block #pecklist');
	});

	it('does nothing on a second run', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 📅 2026-11-15\n- [ ] Rake #pecklist #yard 🔽');
		await sync();
		const before = vault.text('Home.md');
		server.calls = [];
		const report = await sync();
		expect(server.writes()).toEqual([]);
		expect(vault.text('Home.md')).toBe(before);
		expect(report).toMatchObject({ created: 0, sent: 0, received: 0 });
	});

	it('makes a list for a list tag that has none yet', async () => {
		vault.write('Home.md', '- [ ] Paint the shed #pecklist/Home-Projects');
		await sync();
		const list = server.lists.find((l) => l.name === 'Home Projects');
		expect(list).toBeDefined();
		expect(server.tasks.get(idIn('Home.md'))?.listId).toBe(list?.id);
	});

	it('uses the default list from the settings', async () => {
		vault.write('Home.md', '- [ ] Email Sam #pecklist');
		await sync({ defaultListId: 'L-WORK' });
		expect(server.tasks.get(idIn('Home.md'))?.listId).toBe('L-WORK');
	});

	it('skips lines marked off', async () => {
		vault.write('Home.md', '- [ ] Private %%[pecklist:: off]%% #pecklist');
		await sync();
		expect(server.tasks.size).toBe(0);
	});
});

describe('changes in the note', () => {
	it('sends only the fields that changed', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace('Mow', 'Mow the lawn').replace('2026-11-15', '2026-11-16').replace('#yard', '#garden'));
		server.calls = [];
		const report = await sync();
		expect(report.sent).toBe(1);
		const patch = server.calls.find((c) => c.method === 'updateTask');
		expect(patch?.body).toEqual({ title: 'Mow the lawn', addTags: ['garden'], removeTags: ['yard'], due: { at: '2026-11-16', allDay: true, timeZone: 'America/Chicago' } });
		expect(server.tasks.get(id)).toMatchObject({ title: 'Mow the lawn', tags: ['garden'] });
	});

	it('keeps a time of day set in PeckList when the date moves in the note', async () => {
		vault.write('Home.md', '- [ ] Dentist #pecklist 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		server.edit(id, { due: { at: '2026-11-15T09:30', allDay: false, timeZone: 'America/Chicago' } });
		await sync();
		vault.write('Home.md', vault.text('Home.md').replace('2026-11-15', '2026-11-17'));
		await sync();
		expect(server.tasks.get(id)?.due).toEqual({ at: '2026-11-17T09:30', allDay: false, timeZone: 'America/Chicago' });
	});

	it('completes and reopens', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace('[ ]', '[x]') + ' ✅ 2026-11-11');
		await sync();
		expect(server.tasks.get(id)?.status).toBe('done');
		vault.write('Home.md', vault.text('Home.md').replace('[x]', '[ ]').replace(' ✅ 2026-11-11', ''));
		await sync();
		expect(server.tasks.get(id)?.status).toBe('open');
	});

	it('moves the task when the list tag changes', async () => {
		vault.write('Home.md', '- [ ] Report #pecklist');
		await sync();
		vault.write('Home.md', vault.text('Home.md').replace('#pecklist', '#pecklist/work'));
		await sync();
		expect(server.tasks.get(idIn('Home.md'))?.listId).toBe('L-WORK');
	});

	it('trashes the task when the line is deleted', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist\n- [ ] Rake #pecklist');
		await sync();
		const rake = idIn('Home.md', 1);
		vault.write('Home.md', vault.text('Home.md').split('\n')[0] ?? '');
		const report = await sync();
		expect(report.trashed).toBe(1);
		expect(server.tasks.get(rake)?.deletedAt).not.toBeNull();
	});

	it('trashes the task and unlinks the line when the tag comes off', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard');
		await sync();
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace(' #pecklist', ''));
		await sync();
		expect(server.tasks.get(id)?.deletedAt).not.toBeNull();
		expect(vault.text('Home.md')).toBe('- [ ] Mow #yard');
	});

	it('follows a line moved to another note', async () => {
		vault.write('A.md', '- [ ] Mow #pecklist');
		await sync();
		const line = vault.text('A.md');
		vault.files.delete('A.md');
		vault.write('B.md', `# B\n${line}`);
		server.calls = [];
		await sync();
		expect(server.writes()).toEqual([]);
		expect(state.snaps[idIn('B.md', 1)]?.path).toBe('B.md');
	});

	it('holds back many deletions at once until confirmed', async () => {
		vault.write('Big.md', Array.from({ length: 8 }, (_, i) => `- [ ] Task ${i} #pecklist`).join('\n'));
		await sync();
		vault.files.delete('Big.md');
		const report = await sync();
		expect(report.held).toHaveLength(8);
		expect(report.trashed).toBe(0);
		expect([...server.tasks.values()].every((t) => t.deletedAt === null)).toBe(true);
		await engine().resolveHeld(report.held.map((h) => h.id), true);
		expect([...server.tasks.values()].every((t) => t.deletedAt !== null)).toBe(true);
	});

	it('only forgets links for a note moved into a left-out folder', async () => {
		vault.write('A.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('A.md');
		state.snaps[id] = { ...(state.snaps[id] as NonNullable<SyncState['snaps'][string]>), path: 'Templates/A.md' };
		vault.write('Templates/A.md', vault.text('A.md'));
		vault.files.delete('A.md');
		const report = await sync();
		expect(report.unlinked).toBe(1);
		expect(server.tasks.get(id)?.deletedAt).toBeNull();
		expect(state.snaps[id]).toBeUndefined();
	});
});

describe('changes in PeckList', () => {
	it('rewrites the line', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard 🔼 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		server.edit(id, { title: 'Mow the lawn', priority: 3, due: { at: '2026-11-20', allDay: true, timeZone: 'America/Chicago' }, tags: ['yard', 'weekend'], listId: 'L-WORK' });
		const report = await sync();
		expect(report.received).toBe(1);
		expect(vault.text('Home.md')).toBe(`- [ ] Mow the lawn %%[pecklist:: ${id}]%% #pecklist/Work #yard #weekend ⏫ 📅 2026-11-20`);
	});

	it('ticks the line when the task is done in PeckList', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('Home.md');
		server.edit(id, { status: 'done', completedAt: '2026-11-11T15:00:00.000Z' });
		await sync();
		expect(vault.text('Home.md')).toMatch(/^- \[x\] Mow %%\[pecklist:: [0-9A-Z]+\]%% #pecklist ✅ 2026-11-1[01]$/u);
	});

	it('keeps the line as plain text when the task is deleted', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard');
		await sync();
		await server.api().deleteTask(idIn('Home.md'));
		await sync();
		expect(vault.text('Home.md')).toBe('- [ ] Mow #yard');
	});

	it('keeps the line as plain text when the list stops being shared', async () => {
		vault.write('Home.md', '- [ ] Shared chore #pecklist');
		await sync();
		server.revoke(idIn('Home.md'));
		await sync();
		expect(vault.text('Home.md')).toBe('- [ ] Shared chore');
	});

	it('writes a PeckList tag with a space as a valid tag, without looping', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('Home.md');
		server.edit(id, { tags: ['home stuff'] });
		await sync();
		expect(vault.text('Home.md')).toContain('#home-stuff');
		server.calls = [];
		await sync();
		expect(server.writes()).toEqual([]);
	});

	it('leaves a repeat with no Tasks text alone', async () => {
		vault.write('Home.md', '- [ ] Pills #pecklist 🔁 every day 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		server.edit(id, { recurrence: 'FREQ=DAILY;COUNT=10' });
		await sync();
		expect(vault.text('Home.md')).toContain('🔁 every day');
		server.calls = [];
		await sync();
		expect(server.writes()).toEqual([]);
	});
});

describe('both sides', () => {
	it('the newer change wins a field changed on both sides', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace('Mow', 'Mow (note)'));
		server.edit(id, { title: 'Mow (app)' });
		await sync();
		expect(server.tasks.get(id)?.title).toBe('Mow (app)');
		expect(vault.text('Home.md')).toContain('Mow (app)');
	});

	it('different fields changed on each side both survive', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		vault.write('Home.md', vault.text('Home.md').replace('Mow', 'Mow the lawn'));
		server.edit(id, { priority: 2 });
		await sync();
		expect(server.tasks.get(id)).toMatchObject({ title: 'Mow the lawn', priority: 2 });
		expect(vault.text('Home.md')).toBe(`- [ ] Mow the lawn %%[pecklist:: ${id}]%% #pecklist 🔼 📅 2026-11-15`);
	});
});

describe('repeats', () => {
	it('completes once when the Tasks plugin writes the next line, and links the closed line to the closed copy', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 🔁 every week 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		// What the Tasks plugin does on a tick: a new open line above, the old one closed.
		vault.write(
			'Home.md',
			[
				`- [ ] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-22`,
				`- [x] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-15 ✅ 2026-11-15`,
			].join('\n'),
		);
		server.calls = [];
		await sync();
		expect(server.calls.filter((c) => c.method === 'complete')).toHaveLength(1);
		expect(server.tasks.get(id)?.due?.at).toBe('2026-11-22');
		const copyId = idIn('Home.md', 1);
		expect(copyId).not.toBe(id);
		expect(server.tasks.get(copyId)).toMatchObject({ status: 'done', recurrence: null, deletedAt: null });
		expect(vault.text('Home.md')).toBe(
			[
				`- [ ] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-22`,
				`- [x] Mow %%[pecklist:: ${copyId}]%% #pecklist 📅 2026-11-15 ✅ 2026-11-15`,
			].join('\n'),
		);
		server.calls = [];
		await sync();
		expect(server.writes()).toEqual([]);
	});

	it('unticking the closed line reopens the closed copy, without a second repeating task', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 🔁 every week 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		vault.write(
			'Home.md',
			[
				`- [ ] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-22`,
				`- [x] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-15 ✅ 2026-11-15`,
			].join('\n'),
		);
		await sync();
		const copyId = idIn('Home.md', 1);
		const lines = vault.text('Home.md').split('\n');
		vault.write('Home.md', [lines[0], (lines[1] ?? '').replace('- [x]', '- [ ]').replace(' ✅ 2026-11-15', '')].join('\n'));
		server.calls = [];
		await sync();
		expect(server.calls.filter((c) => c.method === 'createTask')).toEqual([]);
		expect(server.tasks.get(copyId)).toMatchObject({ status: 'open', recurrence: null });
		expect(server.tasks.get(id)).toMatchObject({ status: 'open', recurrence: 'FREQ=WEEKLY' });
		expect([...server.tasks.values()].filter((t) => t.recurrence)).toHaveLength(1);
	});

	it('moves the line on when the repeating task is done in PeckList', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 🔁 every week 📅 2026-11-15');
		await sync();
		const id = idIn('Home.md');
		await server.api().complete(id, 'done');
		await sync();
		expect(vault.text('Home.md')).toBe(`- [ ] Mow %%[pecklist:: ${id}]%% #pecklist 🔁 every week 📅 2026-11-22`);
	});
});

describe('a second device', () => {
	it('adopts linked lines without writing anything', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard 📅 2026-11-15');
		await sync();
		state = emptyState('https://tasks.example.com', 'U1');
		state.firstSyncDone = true;
		server.calls = [];
		const before = vault.text('Home.md');
		await sync();
		expect(server.writes()).toEqual([]);
		expect(vault.text('Home.md')).toBe(before);
	});

	it('finishes a create another device started', async () => {
		vault.write('Home.md', '- [ ] Mow %%[pecklist:: 01JC8R5K2Z4N6PX0M3WQ7HB9TA]%% #pecklist');
		await sync();
		expect(server.tasks.get('01JC8R5K2Z4N6PX0M3WQ7HB9TA')?.title).toBe('Mow');
	});

	it('gives a line a fresh id when its id is taken', async () => {
		server.taken.add('01JC8R5K2Z4N6PX0M3WQ7HB9TA');
		vault.write('Home.md', '- [ ] Mow %%[pecklist:: 01JC8R5K2Z4N6PX0M3WQ7HB9TA]%% #pecklist');
		await sync();
		const id = idIn('Home.md');
		expect(id).not.toBe('01JC8R5K2Z4N6PX0M3WQ7HB9TA');
		expect(server.tasks.get(id)?.title).toBe('Mow');
	});

	it('treats a copied line as a new task', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const line = vault.text('Home.md');
		vault.write('Home.md', `${line}\n${line}`);
		await sync();
		await sync();
		const ids = vault.text('Home.md').split('\n').map((_, i) => idIn('Home.md', i));
		expect(new Set(ids).size).toBe(2);
		expect(server.tasks.size).toBe(2);
	});
});

describe('the vault tag', () => {
	it('goes on every new task, never into the note, and never loops', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist #yard');
		await sync({ vaultTag: 'obsidian/Test' });
		const id = idIn('Home.md');
		expect(server.tasks.get(id)?.tags).toEqual(['yard', 'obsidian/Test']);
		expect(vault.text('Home.md')).not.toContain('obsidian');
		vault.write('Home.md', vault.text('Home.md').replace('#yard', '#garden'));
		await sync({ vaultTag: 'obsidian/Test' });
		expect(server.tasks.get(id)?.tags).toEqual(['obsidian/Test', 'garden']);
		server.calls = [];
		await sync({ vaultTag: 'obsidian/Test' });
		expect(server.writes()).toEqual([]);
	});

	it('is added once to tasks linked before it existed, and stays off if taken off in PeckList', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist');
		await sync();
		const id = idIn('Home.md');
		await sync({ vaultTag: 'obsidian/Test' });
		expect(server.tasks.get(id)?.tags).toEqual(['obsidian/Test']);
		server.edit(id, { tags: [] });
		await sync({ vaultTag: 'obsidian/Test' });
		expect(server.tasks.get(id)?.tags).toEqual([]);
		expect(vault.text('Home.md')).toBe(`- [ ] Mow %%[pecklist:: ${id}]%% #pecklist`);
	});
});

describe('preview', () => {
	it('counts what the first sync will do', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist\n- [x] Done #pecklist\n- [ ] Paint #pecklist/Garage\n- [ ] Off %%[pecklist:: off]%% #pecklist');
		vault.write('Templates/T.md', '- [ ] Template #pecklist');
		const preview = await engine().preview();
		expect(preview.defaultListName).toBe('Inbox');
		expect(preview.newLists).toEqual(['Garage']);
		const home = preview.notes.find((n) => n.path === 'Home.md');
		expect(home?.lines.map((l) => l.state)).toEqual(['new', 'closed', 'new', 'off']);
		expect(preview.notes.find((n) => n.path === 'Templates/T.md')?.excluded).toBe('folder');
		expect(server.writes()).toEqual([]);
	});

	it('marks and unmarks a line off', async () => {
		vault.write('Home.md', '- [ ] Mow #pecklist 📅 2026-11-15');
		await engine().setLineOff('Home.md', 0, true);
		expect(vault.text('Home.md')).toBe('- [ ] Mow %%[pecklist:: off]%% #pecklist 📅 2026-11-15');
		await engine().setLineOff('Home.md', 0, false);
		expect(vault.text('Home.md')).toBe('- [ ] Mow #pecklist 📅 2026-11-15');
	});
});
