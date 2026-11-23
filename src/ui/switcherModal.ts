import {
	Keymap,
	Modal,
	Platform,
	parseFrontMatterAliases,
	setIcon,
	type App,
	type PaneType,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import type NeedlePlugin from "../main";
import { matchNote, prepareCandidate, tokenize, type NoteCandidate, type NoteMatch } from "../search/noteMatcher";
import type { Range } from "../search/types";
import { exclusionTest } from "../search/vaultIndex";
import { appendHighlighted, formatCount, parentFolder } from "./text";

type FileKind = { icon: string; tag: string | null };

const FILE_KINDS = new Map<string, FileKind>([
	["md", { icon: "file-text", tag: null }],
	["canvas", { icon: "layout-dashboard", tag: "Canvas" }],
	["base", { icon: "table", tag: "Base" }],
]);

type Entry = {
	file: TFile;
	kind: FileKind;
	folder: string;
	aliases: string[];
	candidate: NoteCandidate;
	excluded: boolean;
};

type Item = { el: HTMLElement } & ({ kind: "file"; entry: Entry } | { kind: "find"; query: string });

type Ranked = { entry: Entry; match: NoteMatch; score: number };

const MAX_SHOWN = 50;
const MAX_RECENT = 12;
const PAGE_SIZE = 8;
const MAX_PATH_SEGMENTS = 4;
const RECENT_BOOST = 3;
const RECENT_STEP = 0.25;

let instanceCount = 0;

export class SwitcherModal extends Modal {
	private readonly ids = `needle-switcher-${++instanceCount}`;
	private entries: Entry[] = [];
	private recentRank = new Map<string, number>();
	private openLeaves = new Map<string, WorkspaceLeaf>();
	private activeFile: TFile | null = null;
	private items: Item[] = [];
	private selected = -1;

	private inputEl!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private listEl!: HTMLElement;

	constructor(
		app: App,
		private readonly plugin: NeedlePlugin,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("needle-switcher-modal");
		this.collect();
		this.build();
		this.registerKeys();
		this.render();
		this.inputEl.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed();
	}

	focusInput(): void {
		this.inputEl.focus();
		this.inputEl.select();
	}

	private id(kind: string, index = 0): string {
		return `${this.ids}-${kind}-${index}`;
	}

	private collect(): void {
		const { vault, metadataCache, workspace } = this.app;
		const isExcluded = exclusionTest(this.app, this.plugin.settings);
		this.entries = [];
		for (const file of vault.getFiles()) {
			const kind = FILE_KINDS.get(file.extension);
			if (kind === undefined) {
				continue;
			}
			const folder = parentFolder(file.path);
			const aliases =
				file.extension === "md"
					? (parseFrontMatterAliases(metadataCache.getFileCache(file)?.frontmatter) ?? []).filter(
							(alias) => alias.trim().length > 0 && alias !== file.basename,
						)
					: [];
			this.entries.push({
				file,
				kind,
				folder,
				aliases,
				candidate: prepareCandidate(file.basename, folder, aliases),
				excluded: isExcluded(file.path),
			});
		}
		this.activeFile = workspace.getActiveFile();
		this.recentRank = new Map(workspace.getLastOpenFiles().map((path, rank) => [path, rank]));
		this.openLeaves = this.collectOpenLeaves();
	}

	private collectOpenLeaves(): Map<string, WorkspaceLeaf> {
		const { workspace } = this.app;
		const leaves = new Map<string, WorkspaceLeaf>();
		const active = workspace.getMostRecentLeaf();
		workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			if (root === workspace.leftSplit || root === workspace.rightSplit) {
				return;
			}
			const path: unknown = leaf.getViewState().state?.file;
			if (typeof path === "string" && (!leaves.has(path) || leaf === active)) {
				leaves.set(path, leaf);
			}
		});
		return leaves;
	}

	private build(): void {
		const root = this.contentEl.createDiv({ cls: "needle-switcher" });

		const search = root.createDiv({ cls: "needle-switcher-search" });
		setIcon(search.createSpan({ cls: "needle-switcher-search-icon", attr: { "aria-hidden": "true" } }), "search");
		search.createSpan({ cls: "needle-sr-only", text: "Go to note", attr: { id: this.id("label") } });
		this.inputEl = search.createEl("input", {
			type: "text",
			cls: "needle-switcher-input",
			attr: {
				placeholder: "Go to note…",
				spellcheck: "false",
				autocomplete: "off",
				enterkeyhint: "go",
				role: "combobox",
				"aria-labelledby": this.id("label"),
				"aria-autocomplete": "list",
				"aria-controls": this.id("list"),
				"aria-expanded": "true",
			},
		});
		this.inputEl.addEventListener("input", () => this.render());

		this.statusEl = root.createDiv({
			cls: "needle-switcher-status",
			attr: { id: this.id("status"), role: "status", "aria-live": "polite" },
		});

		this.listEl = root.createDiv({
			cls: "needle-switcher-list",
			attr: { id: this.id("list"), role: "listbox", "aria-labelledby": this.id("label") },
		});
		this.listEl.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.listEl.addEventListener("mousemove", (evt) => {
			const index = this.itemIndex(evt);
			if (index !== null && index !== this.selected && (evt.movementX !== 0 || evt.movementY !== 0)) {
				this.select(index, false);
			}
		});
		this.listEl.addEventListener("click", (evt) => this.onItemClick(evt));
		this.listEl.addEventListener("auxclick", (evt) => {
			if (evt.button === 1) {
				this.onItemClick(evt);
			}
		});

		if (!Platform.isMobile) {
			this.buildFooter(root);
		}
	}

	private buildFooter(root: HTMLElement): void {
		const mod = Platform.isMacOS ? "⌘" : "Ctrl";
		const alt = Platform.isMacOS ? "⌥" : "Alt";
		const footer = root.createDiv({ cls: "prompt-instructions needle-switcher-footer" });
		const hints: [string, string][] = [
			["↑↓", "to navigate"],
			["↵", "to open"],
			[`${mod} ↵`, "to open in new tab"],
			[`${mod} ${alt} ↵`, "to open to the right"],
			["esc", "to close"],
		];
		for (const [command, purpose] of hints) {
			const hint = footer.createDiv({ cls: "prompt-instruction" });
			hint.createSpan({ cls: "prompt-instruction-command", text: command });
			hint.createSpan({ text: purpose });
		}
	}

	private registerKeys(): void {
		const key = (action: (evt: KeyboardEvent) => void) => (evt: KeyboardEvent) => {
			if (evt.isComposing) {
				return true;
			}
			action(evt);
			return false;
		};
		this.scope.register([], "ArrowDown", key(() => this.move(1)));
		this.scope.register([], "ArrowUp", key(() => this.move(-1)));
		this.scope.register([], "PageDown", key(() => this.move(PAGE_SIZE)));
		this.scope.register([], "PageUp", key(() => this.move(-PAGE_SIZE)));
		this.scope.register(null, "Enter", key((evt) => this.activate(evt)));
	}

	private render(): void {
		const query = this.inputEl.value;
		const tokens = tokenize(query);
		this.items = [];
		this.selected = -1;
		this.listEl.empty();
		if (tokens.length === 0) {
			this.renderRecent();
		} else {
			this.renderMatches(query, tokens);
		}
		this.listEl.scrollTop = 0;
		this.select(0);
	}

	private renderRecent(): void {
		const byPath = new Map(this.entries.map((entry) => [entry.file.path, entry]));
		let recent = [...this.recentRank.keys()]
			.map((path) => byPath.get(path))
			.filter((entry): entry is Entry => entry !== undefined && entry.file !== this.activeFile);
		let label = "Recently opened";
		if (recent.length === 0) {
			recent = this.entries
				.filter((entry) => entry.file !== this.activeFile && !entry.excluded)
				.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
			label = "Recently modified";
		}
		if (recent.length === 0) {
			this.setStatus("");
			this.renderEmpty("There are no notes in this vault yet.");
			return;
		}
		this.setStatus(label);
		for (const entry of recent.slice(0, MAX_RECENT)) {
			this.renderEntry(entry, null);
		}
	}

	private renderMatches(query: string, tokens: string[]): void {
		const ranked: Ranked[] = [];
		for (const entry of this.entries) {
			const match = matchNote(entry.candidate, tokens);
			if (match !== null) {
				ranked.push({ entry, match, score: match.score + this.recencyBoost(entry) });
			}
		}
		if (ranked.length === 0) {
			this.setStatus("No matches");
			this.renderEmpty(`No note is named “${query.trim()}”.`);
			this.renderFindItem(query.trim());
			return;
		}
		ranked.sort(
			(a, b) =>
				Number(a.entry.excluded) - Number(b.entry.excluded) ||
				b.score - a.score ||
				a.entry.file.basename.length - b.entry.file.basename.length ||
				a.entry.file.path.localeCompare(b.entry.file.path),
		);
		this.setStatus(
			ranked.length > MAX_SHOWN
				? `Best ${MAX_SHOWN} of ${formatCount(ranked.length, "match", "matches")}`
				: formatCount(ranked.length, "match", "matches"),
		);
		for (const { entry, match } of ranked.slice(0, MAX_SHOWN)) {
			this.renderEntry(entry, match);
		}
	}

	private recencyBoost(entry: Entry): number {
		const rank = this.recentRank.get(entry.file.path);
		return rank === undefined ? 0 : Math.max(0, RECENT_BOOST - rank * RECENT_STEP);
	}

	private setStatus(text: string): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("needle-hidden", text === "");
	}

	private renderEmpty(text: string): void {
		this.listEl.createDiv({ cls: "needle-switcher-empty", text });
	}

	private createItem(): HTMLElement {
		const index = this.items.length;
		const el = this.listEl.createDiv({
			cls: "needle-switcher-item",
			attr: { role: "option", id: this.id("item", index), "aria-selected": "false" },
		});
		el.dataset.item = String(index);
		return el;
	}

	private renderEntry(entry: Entry, match: NoteMatch | null): void {
		const el = this.createItem();
		setIcon(el.createSpan({ cls: "needle-switcher-icon", attr: { "aria-hidden": "true" } }), entry.kind.icon);

		const body = el.createDiv({ cls: "needle-switcher-body" });
		const titleEl = body.createDiv({ cls: "needle-switcher-title" });
		const alias = match !== null && match.name > 0 ? entry.aliases[match.name - 1] : undefined;
		appendHighlighted(
			titleEl.createSpan({ cls: "needle-switcher-name" }),
			entry.file.basename,
			alias === undefined ? (match?.nameRanges ?? []) : [],
		);
		if (alias !== undefined && match !== null) {
			const aliasEl = titleEl.createSpan({ cls: "needle-switcher-alias" });
			setIcon(aliasEl.createSpan({ cls: "needle-switcher-alias-icon", attr: { "aria-hidden": "true" } }), "forward");
			aliasEl.createSpan({ cls: "needle-sr-only", text: "alias " });
			appendHighlighted(aliasEl.createSpan({ cls: "needle-switcher-alias-text" }), alias, match.nameRanges);
		}
		this.renderPath(body.createDiv({ cls: "needle-switcher-path" }), entry.folder, match?.folderRanges ?? []);

		const tags: string[] = [];
		if (entry.file === this.activeFile) {
			tags.push("Current");
		} else if (this.openLeaves.has(entry.file.path)) {
			tags.push("Open");
		}
		if (entry.kind.tag !== null) {
			tags.push(entry.kind.tag);
		}
		if (tags.length > 0) {
			const meta = el.createDiv({ cls: "needle-switcher-meta" });
			for (const tag of tags) {
				meta.createSpan({ cls: `needle-switcher-tag mod-${tag.toLowerCase()}`, text: tag });
			}
		}
		this.items.push({ kind: "file", entry, el });
	}

	private renderPath(el: HTMLElement, folder: string, ranges: Range[]): void {
		if (folder === "") {
			el.createSpan({ cls: "needle-switcher-root", text: this.app.vault.getName() });
			return;
		}
		const segments = folder.split("/");
		const starts: number[] = [];
		let offset = 0;
		for (const segment of segments) {
			starts.push(offset);
			offset += segment.length + 1;
		}
		let shown = segments.map((_, index) => index);
		if (segments.length > MAX_PATH_SEGMENTS) {
			shown = [0, -1, ...shown.slice(-(MAX_PATH_SEGMENTS - 2))];
			el.setAttr("aria-label", folder);
		}
		shown.forEach((index, position) => {
			if (position > 0) {
				el.createSpan({ cls: "needle-switcher-separator", text: "/" });
			}
			if (index === -1) {
				el.createSpan({ cls: "needle-switcher-segment", text: "…" });
				return;
			}
			appendHighlighted(el.createSpan({ cls: "needle-switcher-segment" }), segments[index] ?? "", ranges, starts[index]);
		});
	}

	private renderFindItem(query: string): void {
		const el = this.createItem();
		el.addClass("mod-find");
		setIcon(el.createSpan({ cls: "needle-switcher-icon", attr: { "aria-hidden": "true" } }), "text-search");
		const body = el.createDiv({ cls: "needle-switcher-body" });
		const titleEl = body.createDiv({ cls: "needle-switcher-title" });
		titleEl.appendText("Find “");
		titleEl.createSpan({ cls: "needle-switcher-query", text: query });
		titleEl.appendText("” inside notes");
		body.createDiv({ cls: "needle-switcher-path", text: "Search the text of every note instead" });
		this.items.push({ kind: "find", query, el });
	}

	private select(index: number, scroll = true): void {
		const previous = this.items[this.selected];
		if (previous) {
			previous.el.removeClass("is-selected");
			previous.el.setAttr("aria-selected", "false");
		}
		const item = this.items[Math.min(this.items.length - 1, Math.max(0, index))];
		if (!item) {
			this.selected = -1;
			this.inputEl.removeAttribute("aria-activedescendant");
			return;
		}
		this.selected = this.items.indexOf(item);
		item.el.addClass("is-selected");
		item.el.setAttr("aria-selected", "true");
		this.inputEl.setAttr("aria-activedescendant", item.el.id);
		if (scroll) {
			item.el.scrollIntoView({ block: "nearest" });
		}
	}

	private move(delta: number): void {
		if (this.items.length === 0) {
			return;
		}
		const last = this.items.length - 1;
		let next = this.selected + delta;
		if (Math.abs(delta) === 1) {
			next = next < 0 ? last : next > last ? 0 : next;
		}
		this.select(next);
	}

	private itemIndex(evt: MouseEvent): number | null {
		const target = evt.target;
		if (!(target instanceof Element)) {
			return null;
		}
		const value = target.closest<HTMLElement>("[data-item]")?.dataset.item;
		return value === undefined ? null : Number(value);
	}

	private onItemClick(evt: MouseEvent): void {
		const index = this.itemIndex(evt);
		if (index === null) {
			return;
		}
		this.select(index, false);
		this.activate(evt);
	}

	private activate(evt: KeyboardEvent | MouseEvent): void {
		const item = this.items[this.selected];
		if (!item) {
			return;
		}
		this.close();
		if (item.kind === "find") {
			this.plugin.findInVault(item.query);
			return;
		}
		void this.openFile(item.entry.file, Keymap.isModEvent(evt));
	}

	private async openFile(file: TFile, pane: PaneType | boolean): Promise<void> {
		const { workspace } = this.app;
		const leaf = pane === false ? this.openLeaves.get(file.path) : undefined;
		if (leaf !== undefined) {
			await workspace.revealLeaf(leaf);
			workspace.setActiveLeaf(leaf, { focus: true });
			return;
		}
		await workspace.getLeaf(pane).openFile(file, { active: true });
	}
}
