import type { EditorView } from '@codemirror/view';
import { MarkdownView, Notice, Platform, Plugin, TFile, debounce } from 'obsidian';
import { ApiError, PeckListClient, normalizeServerUrl } from './api/client';
import type { ApiList, ApiMe, ApiTask } from './api/types';
import { ROOT_TAG, isPeckListTag, listKey, listPartOf, nameFromListPart } from './core/lists';
import { ObsidianVault, obsidianHttp } from './obsidian/adapters';
import { markerDecoration } from './obsidian/marker-decoration';
import { ReadingMarks } from './obsidian/reading-marks';
import { VaultLines } from './obsidian/vault-lines';
import { type Catalog, PeckListTagSuggest } from './ui/tag-suggest';
import { type TaskMenuHooks, showTaskMenu } from './ui/task-menu';
import { DEFAULT_SETTINGS, type PeckListSettings, effectiveVaultTag } from './settings';
import { SetupError, SyncEngine, type SyncReport, type SyncState, emptyState } from './sync/engine';
import { DeletionsModal } from './ui/deletions-modal';
import { TaskManagerModal } from './ui/manager-modal';
import { type OverviewRow, buildOverview } from './sync/overview';
import { scanNote } from './sync/scan';
import { ReviewModal, type ReviewChoice } from './ui/review-modal';
import { PeckListSettingTab } from './ui/settings-tab';
import { SignInModal } from './ui/signin-modal';

const STATE_KEY = 'pecklist-sync-state';
const CATALOG_KEY = 'pecklist-catalog';
const TASKS_PLUGIN = 'obsidian-tasks-plugin';

/** The last sync on this device, for the task manager's status line. */
export interface LastSync {
	at: number | null;
	report: SyncReport | null;
	error: string | null;
}

export default class PeckListPlugin extends Plugin {
	settings: PeckListSettings = { ...DEFAULT_SETTINGS };
	lastSync: LastSync = { at: null, report: null, error: null };
	private readonly syncListeners = new Set<() => void>();
	private account: ApiMe | null = null;
	private statusEl: HTMLElement | null = null;
	private running = false;
	private again = false;
	private timerId: number | null = null;
	private promptedReview = false;
	private warnedTasks = false;
	private readonly vaultPort = new ObsidianVault(this.app);
	readonly lines = new VaultLines(this.app, this.vaultPort);
	private readonly syncSoon = debounce(() => void this.sync('change'), 4000, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new PeckListSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('pecklist-status');
		this.setStatus('');

		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.sync('manual') });
		this.addCommand({ id: 'review', name: 'Review what syncs', callback: () => void this.openReview(false) });
		this.addCommand({ id: 'sign-in', name: 'Sign in with browser', callback: () => this.openSignIn() });
		this.addCommand({ id: 'task-manager', name: 'Open task manager', callback: () => this.openManager() });
		this.addRibbonIcon('bird', 'PeckList tasks', () => this.openManager());
		this.registerEditorExtension(
			markerDecoration({
				open: (id) => this.openTask(id),
				menu: (id, event, line) => showTaskMenu(this.app, event, id, line, this.menuHooks(this.app.workspace.getActiveFile()?.path ?? null)),
				changed: (view, deleted) => void this.afterMenuEdit(view, deleted),
				sent: (tag) => this.isSentTag(tag),
			}),
		);
		const reading = new ReadingMarks(this.lines, {
			sent: (tag) => this.isSentTag(tag),
			open: (id) => this.openTask(id),
			menu: (id, event, path, line) => showTaskMenu(this.app, event, id, line, this.menuHooks(path)),
			changed: (path, deleted) => void this.afterLineEdit(path, deleted),
		});
		this.registerMarkdownPostProcessor((el, ctx) => reading.process(el, ctx));
		this.applyTagMarks();
		this.registerTagSuggest();

		this.app.workspace.onLayoutReady(() => {
			void this.readTasksGlobalFilter();
			this.scheduleTimer();
			window.setTimeout(() => void this.sync('startup'), 3000);
		});

		this.registerEvent(
			this.app.metadataCache.on('changed', (file, _data, cache) => {
				const tagged = cache.tags?.some((t) => isPeckListTag(t.tag.replace(/^#/u, ''))) ?? false;
				if (tagged || this.isLinkedPath(file.path)) this.syncSoon();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && this.isLinkedPath(file.path)) this.syncSoon();
			}),
		);
	}

	onunload(): void {
		this.syncSoon.cancel();
		document.body.removeClass('pecklist-mark-tags');
	}

	// --- Settings and state ---

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<PeckListSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Sync state is per device (Obsidian's local storage for this vault), never in the synced vault. */
	private loadState(): SyncState {
		const server = normalizeServerUrl(this.settings.serverUrl);
		const saved = this.app.loadLocalStorage(STATE_KEY) as SyncState | null;
		if (saved && saved.version === 1 && saved.server === server) return { ...saved, refetch: saved.refetch ?? [] };
		return emptyState(server, null);
	}

	private saveState(state: SyncState): void {
		this.app.saveLocalStorage(STATE_KEY, state);
	}

	resetState(): void {
		this.app.saveLocalStorage(STATE_KEY, null);
		this.promptedReview = false;
		this.setStatus('review what syncs');
		new Notice('PeckList: this device starts over at the next sync.');
	}

	private isLinkedPath(path: string): boolean {
		const state = this.app.loadLocalStorage(STATE_KEY) as SyncState | null;
		return !!state && Object.values(state.snaps).some((s) => s.path === path);
	}

	private token(): string | null {
		if (!this.settings.secretName) return null;
		return this.app.secretStorage.getSecret(this.settings.secretName);
	}

	client(): PeckListClient | null {
		const token = this.token();
		if (!this.settings.serverUrl || !token) return null;
		return new PeckListClient(this.settings.serverUrl, token, obsidianHttp);
	}

	scheduleTimer(): void {
		if (this.timerId !== null) window.clearInterval(this.timerId);
		this.timerId = null;
		if (this.settings.intervalMinutes > 0) {
			this.timerId = this.registerInterval(window.setInterval(() => void this.sync('timer'), this.settings.intervalMinutes * 60_000));
		}
	}

	/** Reads the Tasks plugin's global filter once, so its tag (such as #task) isn't sent as a PeckList tag. */
	private async readTasksGlobalFilter(): Promise<void> {
		if (this.settings.ignoredTags !== null) return;
		let tags: string[] = [];
		try {
			const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/plugins/${TASKS_PLUGIN}/data.json`);
			const filter = (JSON.parse(raw) as { globalFilter?: unknown }).globalFilter;
			if (typeof filter === 'string' && filter.startsWith('#')) tags = [filter.slice(1)];
		} catch {
			tags = [];
		}
		this.settings.ignoredTags = tags;
		await this.saveSettings();
	}

	private tasksPluginEnabled(): boolean {
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		return plugins?.enabledPlugins?.has(TASKS_PLUGIN) ?? true;
	}

	// --- Account ---

	async refreshAccount(): Promise<void> {
		const client = this.client();
		if (!client) {
			this.account = null;
			return;
		}
		try {
			this.account = await client.me();
		} catch {
			this.account = null;
		}
	}

	forgetAccount(): void {
		this.account = null;
	}

	signedInText(): string {
		if (!this.settings.serverUrl) return 'Set the server address first.';
		if (!this.token()) return 'Not signed in on this device.';
		if (!this.account) return 'Checking...';
		return `Signed in as ${this.account.username}${this.account.key ? ` (key "${this.account.key.name}")` : ''}.`;
	}

	private deviceName(): string {
		const device = Platform.isAndroidApp
			? 'Android'
			: Platform.isIosApp
				? 'iPhone or iPad'
				: Platform.isMacOS
					? 'Mac'
					: Platform.isWin
						? 'Windows'
						: 'Linux';
		return `Obsidian ${this.app.vault.getName()} on ${device}`.slice(0, 60);
	}

	openSignIn(after?: () => void): void {
		if (!this.settings.serverUrl) {
			new Notice('PeckList: set the server address in the settings first.');
			return;
		}
		new SignInModal(this.app, this.settings.serverUrl, this.deviceName(), obsidianHttp, async (collected) => {
			if (!this.settings.secretName) this.settings.secretName = DEFAULT_SETTINGS.secretName;
			this.app.secretStorage.setSecret(this.settings.secretName, collected.token);
			await this.saveSettings();
			await this.refreshAccount();
			new Notice(`PeckList: signed in${this.account ? ` as ${this.account.username}` : ''}.`);
			after?.();
			void this.sync('manual');
		}).open();
	}

	async signOut(): Promise<void> {
		const client = this.client();
		if (client) {
			try {
				await client.signOut();
			} catch (e) {
				// A pasted key made in PeckList's settings is revoked there.
				if (!(e instanceof ApiError)) new Notice('PeckList: could not reach the server; revoke the key in PeckList\'s settings.');
			}
		}
		if (this.settings.secretName) this.app.secretStorage.setSecret(this.settings.secretName, '');
		this.account = null;
		new Notice('PeckList: signed out on this device.');
	}

	async loadLists(): Promise<ApiList[] | null> {
		const client = this.client();
		if (!client) return null;
		try {
			return await client.lists();
		} catch {
			return null;
		}
	}

	/** Opens a linked task in PeckList's web app, in its list when this device knows it. */
	private openTask(id: string): void {
		if (!this.settings.serverUrl) return;
		const state = this.app.loadLocalStorage(STATE_KEY) as SyncState | null;
		const listId = state?.snaps[id]?.remote.listId;
		const base = normalizeServerUrl(this.settings.serverUrl);
		const query = `task=${encodeURIComponent(id)}&full=1`;
		window.open(listId ? `${base}/lists/${encodeURIComponent(listId)}?${query}` : `${base}/today?${query}`);
	}

	/**
	 * The bird's menu changed a task line. Saving the note first means the sync reads the new line
	 * right away. A deleted line means the link is gone, so the task is trashed in PeckList (where
	 * it can be restored); that sync is a manual one, so its notice says so.
	 */
	private async afterMenuEdit(view: EditorView, deleted: boolean): Promise<void> {
		let md: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!md && leaf.view instanceof MarkdownView && (leaf.view.editor as unknown as { cm?: EditorView }).cm === view) md = leaf.view;
		});
		if (!md) {
			this.syncSoon();
			return;
		}
		await (md as MarkdownView).save();
		await this.sync(deleted ? 'manual' : 'change');
	}

	/** What the task menu needs, for a line in the note at `path`. */
	menuHooks(path: string | null): TaskMenuHooks {
		return {
			open: (taskId) => this.openTask(taskId),
			catalog: () => this.catalog(),
			toggleDone: (text) => this.tasksToggleDone(text, path),
		};
	}

	/**
	 * A line was changed outside the editor (reading view, a query, the task manager). The open
	 * note is saved first, if the edit went through its editor, so the sync reads the new line.
	 */
	async afterLineEdit(path: string, deleted: boolean): Promise<void> {
		let open: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!open && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) open = leaf.view;
		});
		if (open) await (open as MarkdownView).save();
		await this.sync(deleted ? 'manual' : 'change');
	}

	/** The Tasks plugin's own "toggle done" (it writes a repeating task's next one), if installed. */
	private tasksToggleDone(text: string, path: string | null): string | null {
		const tasks = (this.app as unknown as { plugins?: { plugins?: Record<string, { apiV1?: { executeToggleTaskDoneCommand?: (line: string, path: string) => string } }> } }).plugins?.plugins?.[TASKS_PLUGIN];
		const toggle = tasks?.apiV1?.executeToggleTaskDoneCommand;
		if (!toggle || !path) return null;
		try {
			return toggle(text, path);
		} catch {
			return null;
		}
	}

	/** Whether a tag (without `#`) on a syncing line goes to PeckList: not a list tag, not left out. */
	isSentTag(tag: string): boolean {
		const key = tag.replace(/^#/u, '').toLowerCase();
		if (isPeckListTag(key)) return false;
		if (this.vaultTag()?.toLowerCase() === key) return false;
		return !(this.settings.ignoredTags ?? []).some((t) => t.replace(/^#/u, '').toLowerCase() === key);
	}

	/** The tag marks are drawn by styles.css only while this class is on the body. */
	applyTagMarks(): void {
		document.body.toggleClass('pecklist-mark-tags', this.settings.markTags);
	}

	vaultTag(): string | null {
		return effectiveVaultTag(this.settings, this.app.vault.getName());
	}

	// --- Syncing ---

	/**
	 * The status bar item has a fixed width (styles.css) and even-width digits, so a new time or
	 * state never moves it or the items beside it. A longer message is cut off, with the whole
	 * text in the tooltip.
	 */
	private setStatus(text: string, tooltip?: string): void {
		if (!this.statusEl) return;
		const full = text ? `PeckList: ${text}` : '';
		if (this.statusEl.getText() !== full) this.statusEl.setText(full);
		this.statusEl.setAttribute('aria-label', tooltip ?? full);
	}

	/**
	 * Obsidian asks suggesters in order and its own tag suggester comes first, so ours is moved to
	 * the front (as the Tasks plugin does with its own). It only claims `#` on task lines that sync
	 * or while typing `#pecklist`; everywhere else Obsidian's suggester answers as before. If that
	 * internal list ever changes shape, ours simply stays where Obsidian put it.
	 */
	private registerTagSuggest(): void {
		const suggest = new PeckListTagSuggest(this.app, () => this.catalog(), () => this.vaultTag());
		this.registerEditorSuggest(suggest);
		const list = (this.app.workspace as unknown as { editorSuggest?: { suggests?: unknown[] } }).editorSuggest?.suggests;
		if (Array.isArray(list) && list.includes(suggest)) {
			list.splice(list.indexOf(suggest), 1);
			list.unshift(suggest);
		}
	}

	/** Lists and tags for the tag suggestions: from the server after each sync, kept on the device. */
	catalog(): Catalog {
		return (this.app.loadLocalStorage(CATALOG_KEY) as Catalog | null) ?? { lists: [], tags: [], defaultListName: null };
	}

	private async refreshCatalog(client: PeckListClient): Promise<void> {
		try {
			const [lists, tags] = await Promise.all([client.lists(), client.tags()]);
			const usable = lists.filter((l) => !l.deletedAt && !l.archived && l.role !== 'viewer');
			const chosen = usable.find((l) => l.id === this.settings.defaultListId) ?? usable.find((l) => l.isInbox);
			const catalog: Catalog = {
				lists: usable.filter((l) => l.id !== chosen?.id).map((l) => ({ name: l.name })),
				tags: tags.map((t) => t.name),
				defaultListName: chosen?.name ?? null,
			};
			this.app.saveLocalStorage(CATALOG_KEY, catalog);
		} catch {
			// Suggestions keep the last lists and tags this device saw.
		}
	}

	private engine(client: PeckListClient, state: SyncState): SyncEngine {
		return new SyncEngine(this.vaultPort, client, state, {
			defaultListId: this.settings.defaultListId || null,
			exclusions: { folders: this.settings.excludedFolders, notes: this.settings.excludedNotes },
			ignoredTags: this.settings.ignoredTags ?? [],
			previousVaultTag: effectiveVaultTag({ ...this.settings, vaultTag: null }, this.app.vault.getName()),
			addNoteLink: this.settings.addNoteLink,
			vaultTag: this.vaultTag(),
			save: (s) => this.saveState(s),
		});
	}

	/** Checks the account behind the key; a different account than last time starts over. */
	private async prepare(manual: boolean): Promise<{ client: PeckListClient; state: SyncState } | null> {
		const client = this.client();
		if (!client) {
			this.setStatus('not signed in');
			if (manual) new Notice('PeckList: sign in from the plugin settings first.');
			return null;
		}
		if (!this.tasksPluginEnabled()) {
			this.setStatus('needs the Tasks plugin');
			if (manual || !this.warnedTasks) new Notice('PeckList needs the Tasks plugin. Install and enable it, then sync again.');
			this.warnedTasks = true;
			return null;
		}
		if (!this.account) this.account = await client.me();
		let state = this.loadState();
		if (state.accountId && state.accountId !== this.account.id) state = emptyState(state.server, this.account.id);
		state.accountId = this.account.id;
		return { client, state };
	}

	async sync(reason: 'manual' | 'startup' | 'timer' | 'change', allowManyDeletes = false): Promise<void> {
		if (this.running) {
			this.again = true;
			return;
		}
		const manual = reason === 'manual';
		this.running = true;
		try {
			const ready = await this.prepare(manual);
			if (!ready) return;
			if (!ready.state.firstSyncDone) {
				this.setStatus('review what syncs');
				if (manual || !this.promptedReview) {
					this.promptedReview = true;
					this.running = false;
					await this.openReview(true);
				}
				return;
			}
			// The text stays as it is while syncing, so nothing in the status bar moves.
			if (!this.statusEl?.getText()) this.setStatus('syncing...');
			else this.statusEl.setAttribute('aria-label', 'PeckList: syncing...');
			const report = await this.engine(ready.client, ready.state).sync({ allowManyDeletes });
			this.afterSync(report, manual, ready.client, ready.state);
			void this.refreshCatalog(ready.client);
		} catch (e) {
			this.showError(e, manual);
		} finally {
			this.running = false;
			if (this.again) {
				this.again = false;
				this.syncSoon();
			}
		}
	}

	private afterSync(report: SyncReport, manual: boolean, client: PeckListClient, state: SyncState): void {
		this.lastSync = { at: Date.now(), report, error: null };
		this.notifySynced();
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (report.errors.length > 0) {
			this.setStatus(`${report.errors.length} not synced (${time})`);
			const first = report.errors[0];
			new Notice(`PeckList: ${report.errors.length} ${report.errors.length === 1 ? 'task' : 'tasks'} not synced. ${first ? `"${first.title}": ${first.message}` : ''}`, 10000);
		} else {
			this.setStatus(`synced ${time}`);
		}
		if (manual) {
			const parts: string[] = [];
			if (report.created) parts.push(`${report.created} made`);
			if (report.sent) parts.push(`${report.sent} sent`);
			if (report.received) parts.push(`${report.received} updated from PeckList`);
			if (report.completed) parts.push(`${report.completed} completed`);
			if (report.trashed) parts.push(`${report.trashed} trashed`);
			if (report.unlinked) parts.push(`${report.unlinked} unlinked`);
			new Notice(`PeckList: ${parts.length > 0 ? parts.join(', ') : 'nothing to sync'}.`);
		}
		if (report.held.length > 0) {
			new DeletionsModal(this.app, report.held, async (choice) => {
				if (choice === 'later') return;
				await this.engine(client, state).resolveHeld(
					report.held.map((h) => h.id),
					choice === 'trash',
				);
			}).open();
		}
	}

	private showError(e: unknown, manual: boolean): void {
		let message: string;
		if (e instanceof SetupError) message = e.message;
		else if (e instanceof ApiError && e.status === 401) message = 'the sign-in no longer works. Sign in again from the settings.';
		else if (e instanceof ApiError && e.code === 'scope') message = 'the API key needs the tasks:read and tasks:write permissions.';
		else if (e instanceof ApiError && e.status === 429) message = 'the server asked to slow down; will try again later.';
		else if (e instanceof ApiError) message = e.message;
		else message = `could not reach the server (${e instanceof Error ? e.message : String(e)}).`;
		this.setStatus('not synced');
		this.lastSync = { at: Date.now(), report: null, error: message };
		this.notifySynced();
		if (manual || !(e instanceof ApiError && e.status === 429)) new Notice(`PeckList: ${message}`, 8000);
	}

	// --- The task manager ---

	openManager(): void {
		new TaskManagerModal(this.app, this).open();
	}

	/** Calls `listener` after every sync (or failed sync) until the returned function is called. */
	onSynced(listener: () => void): () => void {
		this.syncListeners.add(listener);
		return () => this.syncListeners.delete(listener);
	}

	private notifySynced(): void {
		for (const listener of this.syncListeners) listener();
	}

	isSignedIn(): boolean {
		return !!this.client();
	}

	/** Runs `work` with a ready engine. Shows the problem and answers null when it can't start. */
	async withEngine<T>(work: (engine: SyncEngine, client: PeckListClient) => Promise<T>): Promise<T | null> {
		try {
			const ready = await this.prepare(true);
			if (!ready) return null;
			return await work(this.engine(ready.client, ready.state), ready.client);
		} catch (e) {
			this.showError(e, true);
			return null;
		}
	}

	/** The task manager's rows: every PeckList line, links whose line is gone, and (optionally) tasks only in PeckList. */
	async overview(withRemote: boolean): Promise<{ rows: OverviewRow[]; lists: ApiList[]; remote: 'loaded' | 'skipped' | 'failed' }> {
		const state = this.loadState();
		const lines = await this.lines.all();
		const seen = new Set(lines.map((l) => l.path));
		for (const snap of Object.values(state.snaps)) {
			if (seen.has(snap.path)) continue;
			seen.add(snap.path);
			const file = this.app.vault.getFileByPath(snap.path);
			if (file) lines.push(...scanNote(snap.path, await this.app.vault.cachedRead(file)));
		}
		let lists: ApiList[] = [];
		let remoteTasks: ApiTask[] | null = null;
		let remote: 'loaded' | 'skipped' | 'failed' = 'skipped';
		const client = this.client();
		if (client) {
			try {
				lists = (await client.lists()).filter((l) => !l.deletedAt);
				if (withRemote) {
					remoteTasks = await this.engine(client, state).openTasks();
					remote = 'loaded';
				}
			} catch {
				remote = withRemote ? 'failed' : 'skipped';
			}
		}
		const catalog = this.catalog();
		const chosen = lists.find((l) => l.id === this.settings.defaultListId) ?? lists.find((l) => l.isInbox);
		const defaultName = chosen?.name ?? catalog.defaultListName ?? 'Default list';
		const rows = buildOverview({
			lines,
			snaps: state.snaps,
			errors: this.lastSync.report?.errors ?? [],
			remoteTasks,
			exclusions: { folders: this.settings.excludedFolders, notes: this.settings.excludedNotes },
			ignoredTags: [...(this.settings.ignoredTags ?? []), ...(this.vaultTag() ? [this.vaultTag() as string] : [])],
			listNameForTag: (tag) => {
				const part = tag && tag !== ROOT_TAG ? listPartOf(tag) : null;
				if (!part) return defaultName;
				return lists.find((l) => listKey(l.name) === listKey(part))?.name ?? nameFromListPart(part);
			},
			listNameForId: (id) => (id === null ? defaultName : (lists.find((l) => l.id === id)?.name ?? (id === chosen?.id ? defaultName : 'Unknown list'))),
		});
		return { rows, lists, remote };
	}

	/** Opens a linked task in PeckList. */
	openInPeckList(id: string): void {
		this.openTask(id);
	}

	async openReview(firstSync: boolean): Promise<void> {
		const ready = await this.prepare(true).catch((e: unknown) => {
			this.showError(e, true);
			return null;
		});
		if (!ready) return;
		const engine = this.engine(ready.client, ready.state);
		let preview;
		try {
			preview = await engine.preview();
		} catch (e) {
			this.showError(e, true);
			return;
		}
		new ReviewModal(this.app, preview, {
			firstSync: firstSync || !ready.state.firstSyncDone,
			excludedFolders: this.settings.excludedFolders,
			excludedNotes: this.settings.excludedNotes,
			onConfirm: async (choice) => {
				await this.applyReview(engine, choice);
				ready.state.firstSyncDone = true;
				this.saveState(ready.state);
				void this.sync('manual');
			},
		}).open();
	}

	private async applyReview(engine: SyncEngine, choice: ReviewChoice): Promise<void> {
		const s = this.settings;
		s.excludedFolders = [...s.excludedFolders.filter((f) => !choice.includeFolders.includes(f)), ...choice.excludeFolders];
		s.excludedNotes = [...s.excludedNotes.filter((n) => !choice.includeNotes.includes(n)), ...choice.excludeNotes];
		await this.saveSettings();
		// The off mark changes a line in place, so line numbers stay valid.
		for (const l of choice.lineOff) await engine.setLineOff(l.path, l.lineNo, true);
		for (const l of choice.lineOn) await engine.setLineOff(l.path, l.lineNo, false);
	}
}
