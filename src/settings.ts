// Settings kept in the plugin's data.json. They are the same on every device that shares the
// vault. The API key is not here: it lives in Obsidian's secret storage on each device, and
// only its name is kept here.

export interface PeckListSettings {
	serverUrl: string;
	/** The name of the secret in Obsidian's secret storage that holds the API key. */
	secretName: string;
	/** The list for lines tagged `#pecklist` alone. Empty: the account's inbox. */
	defaultListId: string;
	excludedFolders: string[];
	excludedNotes: string[];
	/** Tags never sent to PeckList, without `#`. Null until read from the Tasks plugin once. */
	ignoredTags: string[] | null;
	/** Minutes between syncs; 0 turns timed syncs off. */
	intervalMinutes: number;
	/** Put a link back to the note in a new task's notes. */
	addNoteLink: boolean;
}

export const DEFAULT_SECRET = 'pecklist-api-key';

export const DEFAULT_SETTINGS: PeckListSettings = {
	serverUrl: '',
	secretName: DEFAULT_SECRET,
	defaultListId: '',
	excludedFolders: ['Templates'],
	excludedNotes: [],
	ignoredTags: null,
	intervalMinutes: 5,
	addNoteLink: true,
};

export function parsePathList(text: string): string[] {
	return text
		.split(/\r?\n/u)
		.map((l) => l.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, ''))
		.filter(Boolean);
}

export function parseTagList(text: string): string[] {
	return text
		.split(/[\s,]+/u)
		.map((t) => t.trim().replace(/^#/u, ''))
		.filter(Boolean);
}
