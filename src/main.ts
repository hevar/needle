import { MarkdownView, Plugin, TFolder } from "obsidian";
import { escapeRegExp } from "./search/matcher";
import { VaultIndex } from "./search/vaultIndex";
import { DEFAULT_SETTINGS, NeedleSettingTab, sanitizeSettings, type NeedleSettings } from "./settings";
import { FindModal } from "./ui/findModal";
import { SwitcherModal } from "./ui/switcherModal";

const MAX_SELECTION_LENGTH = 200;

export default class NeedlePlugin extends Plugin {
	settings: NeedleSettings = { ...DEFAULT_SETTINGS };
	index!: VaultIndex;
	lastQuery = "";
	private modal: FindModal | null = null;
	private switcher: SwitcherModal | null = null;

	async onload(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
		this.index = new VaultIndex(this.app, () => this.settings);

		this.addCommand({
			id: "find-in-vault",
			name: "Find in vault",
			callback: () => this.openFinder(""),
		});
		this.addCommand({
			id: "find-in-current-folder",
			name: "Find in current folder",
			callback: () => this.openFinder(this.activeFolder()),
		});
		this.addCommand({
			id: "go-to-note",
			name: "Go to note",
			callback: () => this.openSwitcher(),
		});
		this.addRibbonIcon("text-search", "Find in vault", () => this.openFinder(""));

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!editor.somethingSelected()) {
					return;
				}
				menu.addItem((item) =>
					item
						.setSection("selection")
						.setTitle("Find in vault")
						.setIcon("text-search")
						.onClick(() => this.openFinder("")),
				);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder)) {
					return;
				}
				menu.addItem((item) =>
					item
						.setSection("action")
						.setTitle("Find in folder")
						.setIcon("text-search")
						.onClick(() => this.openFinder(file.isRoot() ? "" : file.path)),
				);
			}),
		);

		this.addSettingTab(new NeedleSettingTab(this.app, this));
	}

	onunload(): void {
		this.modal?.close();
		this.switcher?.close();
		this.index.dispose();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	activeFolder(): string {
		const parent = this.app.workspace.getActiveFile()?.parent;
		return parent && !parent.isRoot() ? parent.path : "";
	}

	findInVault(query: string): void {
		this.openFinder("", query);
	}

	private openFinder(folder: string, query = this.initialQuery()): void {
		if (this.modal !== null) {
			this.modal.focusInput();
			return;
		}
		const modal = new FindModal(this.app, this, {
			query,
			folder,
			onClosed: () => {
				if (this.modal === modal) {
					this.modal = null;
				}
			},
		});
		this.modal = modal;
		modal.open();
	}

	private openSwitcher(): void {
		if (this.switcher !== null) {
			this.switcher.focusInput();
			return;
		}
		const switcher = new SwitcherModal(this.app, this, () => {
			if (this.switcher === switcher) {
				this.switcher = null;
			}
		});
		this.switcher = switcher;
		switcher.open();
	}

	private initialQuery(): string {
		if (!this.settings.useSelection) {
			return this.lastQuery;
		}
		const selection = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection() ?? "";
		if (selection.trim().length === 0 || selection.includes("\n") || selection.length > MAX_SELECTION_LENGTH) {
			return this.lastQuery;
		}
		return this.settings.regex ? escapeRegExp(selection) : selection;
	}
}
