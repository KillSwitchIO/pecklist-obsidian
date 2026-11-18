import { describe, expect, it } from 'vitest';
import { findDrawnLine, plainKey } from '../src/core/plain-text';
import { scanNote } from '../src/sync/scan';

const note = [
	'- [ ] Replace the faucet cartridge %%[pecklist:: 01AAA]%% #pecklist/Home-Projects #plumbing ⏫ 📅 2026-11-15',
	'- [ ] Call **Sam** about [[Garden Plan|the garden]] %%[pecklist:: 01BBB]%% #pecklist',
	'- [ ] Read [[Books#Next up]] %%[pecklist:: 01CCC]%% #pecklist',
	'- [ ] Water plants %%[pecklist:: 01DDD]%% #pecklist',
	'- [ ] Water plants %%[pecklist:: 01EEE]%% #pecklist',
	'- [ ] Private %%[pecklist:: off]%% #pecklist',
].join('\n');
const lines = scanNote('Home.md', note);

describe('matching a drawn task to its line', () => {
	it('reduces Markdown and drawn text to the same words', () => {
		expect(plainKey('Call **Sam** about [[Garden Plan|the garden]] %%[pecklist:: X]%% #pecklist')).toBe('call sam about the garden');
		expect(plainKey('Call Sam about the garden  #pecklist')).toBe('call sam about the garden');
	});

	it('finds the line from the text the Tasks plugin draws, tags and all', () => {
		expect(findDrawnLine(lines, 'Replace the faucet cartridge  #pecklist/Home-Projects #plumbing')?.id).toBe('01AAA');
		expect(findDrawnLine(lines, 'Call Sam about the garden #pecklist')?.id).toBe('01BBB');
	});

	it('still finds a line whose link is drawn differently', () => {
		expect(findDrawnLine(lines, 'Read Books > Next up #pecklist')?.id).toBe('01CCC');
	});

	it('finds left-out lines, and gives up on the same text for two different tasks', () => {
		expect(findDrawnLine(lines, 'Private #pecklist')?.off).toBe(true);
		expect(findDrawnLine(lines, 'Water plants #pecklist')).toBeNull();
		expect(findDrawnLine(lines, 'Something else')).toBeNull();
	});
});
