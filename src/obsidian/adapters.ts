// The engine's ports, backed by Obsidian.

import { type App, type Editor, MarkdownView, TFile, requestUrl } from 'obsidian';
import type { Http } from '../api/client';
import { isPeckListTag } from '../core/lists';
import type { VaultPort } from '../sync/engine';

/** HTTP through Obsidian's requestUrl: no CORS, and it works on mobile. */
export const obsidianHttp: Http = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return { status: response.status, headers: response.headers, text: response.text };
};

export class ObsidianVault implements VaultPort {
	constructor(private readonly app: App) {}

	candidatePaths(): string[] {
		const out: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache || cache.tags?.some((t) => isPeckListTag(t.tag.replace(/^#/u, '')))) out.push(file.path);
		}
		return out;
	}

	allMarkdownPaths(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}

	exists(path: string): boolean {
		return this.app.vault.getFileByPath(path) !== null;
	}

	async read(path: string): Promise<string> {
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.cachedRead(file) : '';
	}

	mtime(path: string): number {
		return this.app.vault.getFileByPath(path)?.stat.mtime ?? 0;
	}

	async edit(path: string, change: (content: string) => string | null): Promise<boolean> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) return false;
		// The open note goes through its editor, so the cursor and folds stay put.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === path && view.getMode() === 'source') {
			const before = view.editor.getValue();
			const after = change(before);
			if (after === null || after === before) return false;
			replaceChangedLines(view.editor, before, after);
			return true;
		}
		let changed = false;
		await this.app.vault.process(file, (data) => {
			const next = change(data);
			if (next === null || next === data) return data;
			changed = true;
			return next;
		});
		return changed;
	}

	noteLink(path: string): string {
		return `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(path)}`;
	}
}

/** Replaces only the block of lines that differ. */
function replaceChangedLines(editor: Editor, before: string, after: string): void {
	const a = before.split('\n');
	const b = after.split('\n');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}
	const from = { line: start, ch: 0 };
	if (endA < start) {
		// Lines only added.
		editor.replaceRange(`${b.slice(start, endB + 1).join('\n')}\n`, from);
		return;
	}
	const to = { line: endA, ch: (a[endA] ?? '').length };
	editor.replaceRange(b.slice(start, endB + 1).join('\n'), from, to);
}
