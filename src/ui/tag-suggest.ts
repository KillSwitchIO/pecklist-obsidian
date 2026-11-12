// Suggestions while typing a tag on a task line, like the Tasks plugin's own pop-up:
// - `#pecklist...` suggests the PeckList lists (as `#pecklist/List`) and list tags already used
//   in the vault;
// - any other `#tag` on a line that has a PeckList tag suggests tags from the vault and from
//   PeckList together.

import {
	type App,
	type Editor,
	type EditorPosition,
	EditorSuggest,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type TFile,
	getAllTags,
} from 'obsidian';
import { ROOT_TAG, isPeckListTag, listKey, listPartOf, tagForList } from '../core/lists';
import { obsidianTag } from '../sync/values';

export interface Catalog {
	/** PeckList lists the account can add to. */
	lists: { name: string }[];
	/** PeckList tag names. */
	tags: string[];
	defaultListName: string | null;
}

interface Suggestion {
	tag: string;
	note: string;
}

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s/u;
const TYPING_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u;
const ANY_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;

export class PeckListTagSuggest extends EditorSuggest<Suggestion> {
	private mode: 'list' | 'tag' = 'tag';

	constructor(
		app: App,
		private readonly catalog: () => Catalog,
		private readonly hiddenTag: () => string | null,
	) {
		super(app);
		this.limit = 50;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		if (!TASK_LINE.test(line)) return null;
		const before = line.slice(0, cursor.ch);
		const m = TYPING_TAG.exec(before);
		if (!m) return null;
		const query = m[1] ?? '';
		const lower = query.toLowerCase();
		if (lower.length > 0 && (lower.startsWith(ROOT_TAG) || ROOT_TAG.startsWith(lower))) {
			this.mode = 'list';
		} else {
			const tags = [...line.matchAll(ANY_TAG)].map((t) => t[1] ?? '');
			if (!tags.some((t) => isPeckListTag(t))) return null;
			this.mode = 'tag';
		}
		return { start: { line: cursor.line, ch: cursor.ch - query.length - 1 }, end: cursor, query };
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		return this.mode === 'list' ? this.listSuggestions(context.query) : this.tagSuggestions(context.query);
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass('pecklist-suggest');
		el.createDiv({ cls: 'pecklist-suggest-tag', text: `#${value.tag}` });
		if (value.note) el.createDiv({ cls: 'pecklist-suggest-note', text: value.note });
	}

	selectSuggestion(value: Suggestion): void {
		const context = this.context;
		if (!context) return;
		const rest = context.editor.getLine(context.end.line).slice(context.end.ch);
		const space = rest.startsWith(' ') ? '' : ' ';
		context.editor.replaceRange(`#${value.tag}${space}`, context.start, context.end);
		context.editor.setCursor({ line: context.end.line, ch: context.start.ch + value.tag.length + 1 + 1 });
	}

	private vaultTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const t of getAllTags(cache) ?? []) tags.add(t.replace(/^#/u, ''));
		}
		return [...tags];
	}

	private listSuggestions(query: string): Suggestion[] {
		const catalog = this.catalog();
		const q = query.toLowerCase();
		const out: Suggestion[] = [];
		const seen = new Set<string>();
		const add = (tag: string, note: string): void => {
			const key = listKey(tag);
			if (seen.has(key)) return;
			seen.add(key);
			if (tag.toLowerCase().startsWith(q) || listKey(tag).includes(listKey(query))) out.push({ tag, note });
		};
		add(ROOT_TAG, catalog.defaultListName ? `Default list: ${catalog.defaultListName}` : 'Default list');
		for (const list of [...catalog.lists].sort((a, b) => a.name.localeCompare(b.name))) add(tagForList(list.name), `PeckList list: ${list.name}`);
		for (const tag of this.vaultTags().filter((t) => isPeckListTag(t) && listPartOf(t)).sort()) add(tag, 'Used in this vault, new list');
		return out;
	}

	private tagSuggestions(query: string): Suggestion[] {
		const q = query.toLowerCase();
		const hidden = this.hiddenTag()?.toLowerCase() ?? null;
		const where = new Map<string, { tag: string; vault: boolean; pecklist: boolean }>();
		for (const tag of this.vaultTags()) {
			if (isPeckListTag(tag)) continue;
			const key = tag.toLowerCase();
			where.set(key, { tag, vault: true, pecklist: where.get(key)?.pecklist ?? false });
		}
		for (const name of this.catalog().tags) {
			const tag = obsidianTag(name);
			if (!tag || isPeckListTag(tag) || tag.toLowerCase() === hidden) continue;
			const key = tag.toLowerCase();
			const found = where.get(key);
			if (found) found.pecklist = true;
			else where.set(key, { tag, vault: false, pecklist: true });
		}
		return [...where.values()]
			.filter((t) => t.tag.toLowerCase().includes(q))
			.sort((a, b) => Number(!a.tag.toLowerCase().startsWith(q)) - Number(!b.tag.toLowerCase().startsWith(q)) || a.tag.localeCompare(b.tag))
			.map((t) => ({ tag: t.tag, note: t.vault && t.pecklist ? 'Vault and PeckList' : t.pecklist ? 'PeckList' : 'Vault' }));
	}
}
