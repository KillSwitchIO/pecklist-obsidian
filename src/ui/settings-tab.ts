import {
	type App,
	type DropdownComponent,
	PluginSettingTab,
	SecretComponent,
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionRender,
} from 'obsidian';
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

/** One settings row: its name and description (shown, and searched in Obsidian 1.13+) and its controls. */
interface Row {
	name: string;
	desc: string;
	aliases?: string[];
	render(setting: Setting): void;
}

interface Section {
	heading: string | null;
	rows: Row[];
}

// Obsidian builds the tab from getSettingDefinitions() (1.13 and later, the plugin's minimum),
// which also puts every row in Obsidian's settings search.
export class PeckListSettingTab extends PluginSettingTab {
	/** The rows whose text changes after signing in or out, as last rendered. */
	private accountRow: Setting | null = null;
	private listDropdown: DropdownComponent | null = null;

	constructor(
		app: App,
		private readonly plugin: PeckListPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const toDefinition = (row: Row): SettingDefinitionRender => ({
			name: row.name,
			desc: row.desc,
			aliases: row.aliases,
			render: (setting: Setting) => {
				setting.setName(row.name);
				setting.setDesc(row.desc);
				row.render(setting);
			},
		});
		return this.sections().flatMap((section): SettingDefinitionItem[] =>
			section.heading === null ? section.rows.map(toDefinition) : [{ type: 'group', heading: section.heading, items: section.rows.map(toDefinition) }],
		);
	}

	// Obsidian's Setting has a then() method, so a promise treats it as a thenable: never return a
	// Setting (or a builder call that returns one) from a .then callback or an async function.
	// Promise resolution calls Setting.then, which answers the Setting again, forever, and the
	// window freezes. These helpers return nothing.
	private async showAccount(): Promise<void> {
		await this.plugin.refreshAccount();
		this.accountRow?.setDesc(this.plugin.signedInText());
	}

	private async fillLists(): Promise<void> {
		const d = this.listDropdown;
		const lists = await this.plugin.loadLists();
		if (!lists || !d) return;
		d.selectEl.empty();
		d.addOption('', 'Inbox');
		for (const l of lists.filter((x) => !x.isInbox && !x.archived && x.role !== 'viewer')) d.addOption(l.id, l.name);
		d.setValue(this.plugin.settings.defaultListId);
	}

	/** After signing in or out: the account text and the lists that account has. */
	private refreshAccount(): void {
		void this.showAccount();
		void this.fillLists();
	}

	private sections(): Section[] {
		const settings = this.plugin.settings;
		return [
			{
				heading: null,
				rows: [
					{
						name: 'Server address',
						desc: 'Your PeckList server, for example https://tasks.example.com.',
						aliases: ['url', 'host'],
						render: (s) => {
							s.addText((t) => {
								t.setPlaceholder('https://tasks.example.com').setValue(settings.serverUrl);
								t.onChange(async (value) => {
									settings.serverUrl = value.trim();
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Account',
						desc: this.plugin.signedInText(),
						aliases: ['sign in', 'sign out', 'log in'],
						render: (s) => {
							this.accountRow = s;
							s.addButton((b) => {
								b.setButtonText('Sign in with browser').setCta();
								b.onClick(() => this.plugin.openSignIn(() => this.refreshAccount()));
							});
							s.addButton((b) => {
								b.setButtonText('Sign out');
								b.onClick(async () => {
									await this.plugin.signOut();
									this.refreshAccount();
								});
							});
							void this.showAccount();
						},
					},
					{
						name: 'API key',
						desc: "Or use an API key made in PeckList's account settings, with the tasks permissions. Kept in Obsidian's secret storage on this device, not in the vault.",
						aliases: ['token'],
						render: (s) => {
							s.addComponent((el) => {
								const secret = new SecretComponent(this.app, el);
								secret.setValue(settings.secretName);
								secret.onChange(async (value) => {
									settings.secretName = value ?? '';
									await this.plugin.saveSettings();
									this.plugin.forgetAccount();
								});
								return secret;
							});
						},
					},
					{
						name: 'Default list',
						desc: 'Where lines tagged #pecklist alone go. #pecklist/Work goes to the list Work.',
						render: (s) => {
							s.addDropdown((d) => {
								this.listDropdown = d;
								d.addOption('', 'Inbox');
								if (settings.defaultListId) d.addOption(settings.defaultListId, 'Loading...');
								d.setValue(settings.defaultListId);
								d.onChange(async (value) => {
									settings.defaultListId = value;
									await this.plugin.saveSettings();
								});
								void this.fillLists();
							});
						},
					},
				],
			},
			{
				heading: 'What syncs',
				rows: [
					{
						name: 'Review what syncs',
						desc: 'See every tagged line and leave out folders, notes or lines.',
						render: (s) => {
							s.addButton((b) => {
								b.setButtonText('Review');
								b.onClick(() => void this.plugin.openReview(false));
							});
						},
					},
					{
						name: 'Folders left out',
						desc: 'One folder per line. Lines in these folders never sync, and the plugin never writes there.',
						aliases: ['exclude'],
						render: (s) => {
							s.addTextArea((t) => {
								t.setValue(settings.excludedFolders.join('\n'));
								t.onChange(async (value) => {
									settings.excludedFolders = parsePathList(value);
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Notes left out',
						desc: 'One note path per line.',
						aliases: ['exclude'],
						render: (s) => {
							s.addTextArea((t) => {
								t.setValue(settings.excludedNotes.join('\n'));
								t.onChange(async (value) => {
									settings.excludedNotes = parsePathList(value);
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Tags not sent',
						desc: 'Tags kept in the note but not added to PeckList, such as the Tasks global filter. Separate with spaces.',
						render: (s) => {
							s.addText((t) => {
								t.setValue((settings.ignoredTags ?? []).map((x) => `#${x}`).join(' '));
								t.onChange(async (value) => {
									settings.ignoredTags = parseTagList(value);
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Tag for tasks from this vault',
						desc: `Every task made from this vault gets this tag in PeckList, so you can find them all there. It isn't added to your notes. Changing it, or emptying it for none, updates the tasks already in PeckList. Default: obsidian/${this.app.vault.getName()}.`,
						aliases: ['vault tag'],
						render: (s) => {
							s.addText((text) => {
								text.setPlaceholder('obsidian/vault-name').setValue(this.plugin.vaultTag() ?? '');
								// Saved on leaving the box or Enter, not per key: a change swaps the tag on
								// every task in PeckList, and a sync mid-typing would swap in half a tag.
								text.inputEl.addEventListener('change', () => {
									settings.vaultTag = text.getValue().trim();
									void this.plugin.saveSettings().then(() => this.plugin.sync('change'));
								});
							});
						},
					},
					{
						name: 'Link back to the note',
						desc: "Put a link that opens the note in a new task's notes in PeckList.",
						render: (s) => {
							s.addToggle((t) => {
								t.setValue(settings.addNoteLink);
								t.onChange(async (value) => {
									settings.addNoteLink = value;
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Mark PeckList tags',
						desc: "In notes, show a small bird on list tags and a dotted underline on tags that sync to PeckList. Uses your theme's colors.",
						render: (s) => {
							s.addToggle((t) => {
								t.setValue(settings.markTags);
								t.onChange(async (value) => {
									settings.markTags = value;
									await this.plugin.saveSettings();
									this.plugin.applyTagMarks();
								});
							});
						},
					},
				],
			},
			{
				heading: 'Sync',
				rows: [
					{
						name: 'Sync on a timer',
						desc: 'Notes also sync a few seconds after a tagged line changes, and with the "Sync now" command.',
						aliases: ['interval'],
						render: (s) => {
							s.addDropdown((d) => {
								for (const [value, label] of Object.entries(INTERVALS)) d.addOption(value, label);
								d.setValue(String(settings.intervalMinutes));
								d.onChange(async (value) => {
									settings.intervalMinutes = Number(value);
									await this.plugin.saveSettings();
									this.plugin.scheduleTimer();
								});
							});
						},
					},
					{
						name: 'Start over on this device',
						desc: 'Forgets what this device last synced. Links in notes stay. The next sync asks you to review again.',
						aliases: ['reset'],
						render: (s) => {
							s.addButton((b) => {
								b.setButtonText('Start over').setDestructive();
								b.onClick(() => this.plugin.resetState());
							});
						},
					},
				],
			},
		];
	}
}
