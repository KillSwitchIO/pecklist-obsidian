// Signing in with a code approved in the browser, the same flow as the PeckList command line:
// the plugin asks for a code, the person opens their server's /cli page, signs in there as they
// usually do and types the code, and the plugin collects an API key. The plugin never sees a
// password.

import { type App, Modal, Notice, Setting } from 'obsidian';
import { ApiError, type Http, PeckListClient, normalizeServerUrl } from '../api/client';
import type { CliCollected } from '../api/types';

export class SignInModal extends Modal {
	private stopped = false;
	private timer: number | null = null;

	constructor(
		app: App,
		private readonly serverUrl: string,
		private readonly deviceName: string,
		private readonly http: Http,
		private readonly onSignedIn: (collected: CliCollected) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Sign in to PeckList');
		void this.start();
	}

	onClose(): void {
		this.stopped = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.contentEl.empty();
	}

	private async start(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const status = contentEl.createEl('p', { text: 'Asking the server for a code...' });
		const client = new PeckListClient(this.serverUrl, null, this.http, { retries: 0 });
		let started;
		try {
			started = await client.startSignIn(this.deviceName);
		} catch (e) {
			status.setText(`Could not start signing in: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (this.stopped) return;
		const url = started.approveUrl ?? `${normalizeServerUrl(this.serverUrl)}/cli`;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Open the approval page, sign in to PeckList there if it asks, and enter this code:' });
		contentEl.createDiv({ cls: 'pecklist-signin-code', text: started.userCode });
		contentEl.createEl('p', { cls: 'setting-item-description', text: url });
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `The page will show "${this.deviceName}". Only approve a code you started here yourself.`,
		});
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Open approval page')
					.setCta()
					.onClick(() => window.open(url)),
			)
			.addButton((b) =>
				b.setButtonText('Copy code').onClick(async () => {
					await navigator.clipboard.writeText(started.userCode);
					new Notice('Code copied');
				}),
			);
		const waiting = contentEl.createEl('p', { cls: 'setting-item-description', text: 'Waiting for approval...' });

		let interval = Math.max(2, started.interval);
		const deadline = Date.now() + started.expiresIn * 1000;
		const poll = async (): Promise<void> => {
			if (this.stopped) return;
			if (Date.now() > deadline) {
				waiting.setText('The code ran out. Close this and sign in again.');
				return;
			}
			try {
				const collected = await client.pollSignIn(started.pollToken);
				if (this.stopped) return;
				await this.onSignedIn(collected);
				this.close();
				return;
			} catch (e) {
				if (e instanceof ApiError && e.code === 'pending') {
					// Not approved yet.
				} else if (e instanceof ApiError && e.code === 'slow_down') {
					interval += 5;
				} else if (e instanceof ApiError && e.code === 'denied') {
					waiting.setText('The sign-in was denied.');
					return;
				} else if (e instanceof ApiError && e.code === 'expired') {
					waiting.setText('The code ran out or was already used. Close this and sign in again.');
					return;
				} else {
					waiting.setText(`Still waiting (last check failed: ${e instanceof Error ? e.message : String(e)})`);
				}
			}
			this.timer = window.setTimeout(() => void poll(), interval * 1000);
		};
		this.timer = window.setTimeout(() => void poll(), interval * 1000);
	}
}
