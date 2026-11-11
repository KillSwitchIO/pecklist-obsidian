import { Notice, Platform, Plugin, TFile, debounce } from 'obsidian';
import { ApiError, PeckListClient, normalizeServerUrl } from './api/client';
import type { ApiList, ApiMe } from './api/types';
import { isPeckListTag } from './core/lists';
import { ObsidianVault, obsidianHttp } from './obsidian/adapters';
import { DEFAULT_SETTINGS, type PeckListSettings } from './settings';
import { SetupError, SyncEngine, type SyncReport, type SyncState, emptyState } from './sync/engine';
import { DeletionsModal } from './ui/deletions-modal';
import { ReviewModal, type ReviewChoice } from './ui/review-modal';
import { PeckListSettingTab } from './ui/settings-tab';
import { SignInModal } from './ui/signin-modal';

const STATE_KEY = 'pecklist-sync-state';
const TASKS_PLUGIN = 'obsidian-tasks-plugin';

export default class PeckListPlugin extends Plugin {
	settings: PeckListSettings = { ...DEFAULT_SETTINGS };
	private account: ApiMe | null = null;
	private statusEl: HTMLElement | null = null;
	private running = false;
	private again = false;
	private timerId: number | null = null;
	private promptedReview = false;
	private warnedTasks = false;
	private readonly vaultPort = new ObsidianVault(this.app);
	private readonly syncSoon = debounce(() => void this.sync('change'), 4000, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new PeckListSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.setStatus('');

		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.sync('manual') });
		this.addCommand({ id: 'review', name: 'Review what syncs', callback: () => void this.openReview(false) });
		this.addCommand({ id: 'sign-in', name: 'Sign in with browser', callback: () => this.openSignIn() });

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

	// --- Syncing ---

	private setStatus(text: string): void {
		if (!this.statusEl) return;
		this.statusEl.setText(text ? `PeckList: ${text}` : '');
	}

	private engine(client: PeckListClient, state: SyncState): SyncEngine {
		return new SyncEngine(this.vaultPort, client, state, {
			defaultListId: this.settings.defaultListId || null,
			exclusions: { folders: this.settings.excludedFolders, notes: this.settings.excludedNotes },
			ignoredTags: this.settings.ignoredTags ?? [],
			addNoteLink: this.settings.addNoteLink,
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
			this.setStatus('syncing...');
			const report = await this.engine(ready.client, ready.state).sync({ allowManyDeletes });
			this.afterSync(report, manual, ready.client, ready.state);
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
		if (manual || !(e instanceof ApiError && e.status === 429)) new Notice(`PeckList: ${message}`, 8000);
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
