import { type App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type PeckListPlugin from '../main';
import { parsePathList, parseTagList } from '../settings';

const INTERVALS: Record<string, string> = {
	'0': 'Off (sync on changes and by command)',
	'1': 'Every minute',
	'5': 'Every 5 minutes',
	'15': 'Every 15 minutes',
	'30': 'Every 30 minutes',
	'60': 'Every hour',
};

export class PeckListSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: PeckListPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName('Server address')
			.setDesc('Your PeckList server, for example https://tasks.example.com.')
			.addText((t) =>
				t
					.setPlaceholder('https://tasks.example.com')
					.setValue(settings.serverUrl)
					.onChange(async (value) => {
						settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const account = new Setting(containerEl).setName('Account');
		account.setDesc(this.plugin.signedInText());
		account
			.addButton((b) =>
				b
					.setButtonText('Sign in with browser')
					.setCta()
					.onClick(() => this.plugin.openSignIn(() => this.display())),
			)
			.addButton((b) =>
				b.setButtonText('Sign out').onClick(async () => {
					await this.plugin.signOut();
					this.display();
				}),
			);
		void this.plugin.refreshAccount().then(() => account.setDesc(this.plugin.signedInText()));

		new Setting(containerEl)
			.setName('API key')
			.setDesc("Or use an API key made in PeckList's account settings, with the tasks permissions. Kept in Obsidian's secret storage on this device, not in the vault.")
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(settings.secretName).onChange(async (value) => {
					settings.secretName = value;
					await this.plugin.saveSettings();
					this.plugin.forgetAccount();
				}),
			);

		const defaultList = new Setting(containerEl)
			.setName('Default list')
			.setDesc('Where lines tagged #pecklist alone go. #pecklist/Work goes to the list Work.');
		defaultList.addDropdown((d) => {
			d.addOption('', 'Inbox');
			if (settings.defaultListId) d.addOption(settings.defaultListId, 'Loading...');
			d.setValue(settings.defaultListId);
			d.onChange(async (value) => {
				settings.defaultListId = value;
				await this.plugin.saveSettings();
			});
			void this.plugin.loadLists().then((lists) => {
				if (!lists) return;
				d.selectEl.empty();
				d.addOption('', 'Inbox');
				for (const l of lists.filter((x) => !x.isInbox && !x.archived && x.role !== 'viewer')) d.addOption(l.id, l.name);
				d.setValue(settings.defaultListId);
			});
		});

		new Setting(containerEl).setName('What syncs').setHeading();

		new Setting(containerEl)
			.setName('Review what syncs')
			.setDesc('See every tagged line and leave out folders, notes or lines.')
			.addButton((b) => b.setButtonText('Review').onClick(() => void this.plugin.openReview(false)));

		new Setting(containerEl)
			.setName('Folders left out')
			.setDesc('One folder per line. Lines in these folders never sync, and the plugin never writes there.')
			.addTextArea((t) =>
				t.setValue(settings.excludedFolders.join('\n')).onChange(async (value) => {
					settings.excludedFolders = parsePathList(value);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Notes left out')
			.setDesc('One note path per line.')
			.addTextArea((t) =>
				t.setValue(settings.excludedNotes.join('\n')).onChange(async (value) => {
					settings.excludedNotes = parsePathList(value);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Tags not sent')
			.setDesc('Tags kept in the note but not added to PeckList, such as the Tasks global filter. Separate with spaces.')
			.addText((t) =>
				t.setValue((settings.ignoredTags ?? []).map((x) => `#${x}`).join(' ')).onChange(async (value) => {
					settings.ignoredTags = parseTagList(value);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Link back to the note')
			.setDesc('Put a link that opens the note in a new task\'s notes in PeckList.')
			.addToggle((t) =>
				t.setValue(settings.addNoteLink).onChange(async (value) => {
					settings.addNoteLink = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Sync on a timer')
			.setDesc('Notes also sync a few seconds after a tagged line changes, and with the "Sync now" command.')
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(INTERVALS)) d.addOption(value, label);
				d.setValue(String(settings.intervalMinutes));
				d.onChange(async (value) => {
					settings.intervalMinutes = Number(value);
					await this.plugin.saveSettings();
					this.plugin.scheduleTimer();
				});
			});

		new Setting(containerEl)
			.setName('Start over on this device')
			.setDesc('Forgets what this device last synced. Links in notes stay. The next sync asks you to review again.')
			.addButton((b) =>
				b
					.setButtonText('Start over')
					.setWarning()
					.onClick(() => {
						this.plugin.resetState();
						this.display();
					}),
			);
	}
}
