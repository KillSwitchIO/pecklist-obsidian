// When many linked lines vanish at once (a note deleted, a folder moved, a sync tool hiccup),
// the plugin asks before trashing their tasks in PeckList.

import { type App, Modal, Setting } from 'obsidian';
import type { HeldDeletion } from '../sync/engine';

export class DeletionsModal extends Modal {
	constructor(
		app: App,
		private readonly held: HeldDeletion[],
		private readonly onChoice: (choice: 'trash' | 'unlink' | 'later') => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(`${this.held.length} linked lines are gone`);
		contentEl.createEl('p', {
			text: 'These lines were linked to PeckList tasks but are no longer in your notes. Trash their tasks in PeckList, or keep the tasks and only forget the links?',
		});
		const list = contentEl.createEl('ul', { cls: 'pecklist-held-list' });
		for (const h of this.held.slice(0, 50)) list.createEl('li', { text: `${h.title || '(no title)'} (${h.path})` });
		if (this.held.length > 50) list.createEl('li', { text: `and ${this.held.length - 50} more` });
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText('Trash in PeckList')
					.setDestructive()
					.onClick(async () => {
						await this.onChoice('trash');
						this.close();
					}),
			)
			.addButton((b) =>
				b.setButtonText('Keep tasks').onClick(async () => {
					await this.onChoice('unlink');
					this.close();
				}),
			)
			.addButton((b) =>
				b.setButtonText('Decide later').onClick(async () => {
					await this.onChoice('later');
					this.close();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
