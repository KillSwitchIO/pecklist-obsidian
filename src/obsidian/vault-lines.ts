// A note's PeckList lines by path, for the places that show or edit lines outside the editor:
// the birds in reading view and in Tasks queries, and the task manager. Scans are kept per note
// until the file changes.

import type { App } from 'obsidian';
import type { VaultPort } from '../sync/engine';
import { type ScannedLine, replaceLine, scanNote } from '../sync/scan';

export class VaultLines {
	private readonly cache = new Map<string, { mtime: number; lines: ScannedLine[] }>();

	constructor(
		private readonly app: App,
		private readonly vault: VaultPort,
	) {}

	async lines(path: string): Promise<ScannedLine[]> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return [];
		const hit = this.cache.get(path);
		if (hit && hit.mtime === file.stat.mtime) return hit.lines;
		const lines = scanNote(path, await this.app.vault.cachedRead(file));
		this.cache.set(path, { mtime: file.stat.mtime, lines });
		return lines;
	}

	/** The PeckList lines of every note that may have some. */
	async all(): Promise<ScannedLine[]> {
		const out: ScannedLine[] = [];
		for (const path of this.vault.candidatePaths().sort()) out.push(...(await this.lines(path)));
		return out;
	}

	/**
	 * Replaces a line (null: deletes it) if it still reads `expected`, so an edit made meanwhile is
	 * never overwritten. The open note is edited through its editor, so undo works there.
	 */
	async replace(path: string, lineNo: number, expected: string, next: string | null): Promise<boolean> {
		const ok = await this.vault.edit(path, (content) => replaceLine(content, lineNo, expected, next));
		this.cache.delete(path);
		return ok;
	}

	forget(path?: string): void {
		if (path) this.cache.delete(path);
		else this.cache.clear();
	}
}
