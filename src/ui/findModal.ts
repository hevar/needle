import {
	DropdownComponent,
	Keymap,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	debounce,
	setIcon,
	type App,
	type PaneType,
	type TFolder,
} from "obsidian";
import type NeedlePlugin from "../main";
import { SearchTimeoutError } from "../search/backends";
import { buildMatcher } from "../search/matcher";
import type { FileResult, LineMatch, SearchOptions, SearchResponse, SortMode } from "../search/types";
import { FolderSuggestModal } from "./folderSuggest";
import { clampSize, type ModalSize } from "./layout";
import { PreviewPane } from "./previewPane";
import { Splitter, addResizeHandles } from "./resize";
import { appendHighlighted, elidePath, formatCount, parentFolder } from "./text";

export type FindModalOptions = {
	query: string;
	folder: string;
	onClosed: () => void;
};

type Row =
	| { kind: "line"; el: HTMLElement; headerEl: HTMLElement | null; file: FileResult; match: LineMatch }
	| { kind: "more"; el: HTMLElement; headerEl: null; file: FileResult; hidden: number };

const SEARCH_DELAY_MS = 120;
const LINES_PER_FILE = 10;
const PAGE_SIZE = 10;
const SLOW_SEARCH_MS = 300;
const SLOW_INDEX_FILES = 200;
const DOWNLOAD_REFRESH_MS = 1500;
const PHONE_SNIPPET_CONTEXT = 12;

const OPTION_KEYS: Record<string, keyof SearchOptions> = {
	KeyC: "matchCase",
	KeyW: "wholeWord",
	KeyR: "regex",
};

const SORT_LABELS: Record<SortMode, string> = {
	relevance: "Relevance",
	modified: "Recently modified",
	path: "Path",
};

const shortcut = (key: string): string => (Platform.isMacOS ? `⌘${key}` : `Ctrl+${key}`);
const ariaShortcut = (key: string): string => (Platform.isMacOS ? `Meta+${key}` : `Control+${key}`);

let instanceCount = 0;

export class FindModal extends Modal {
	private readonly plugin: NeedlePlugin;
	private readonly ids: string;
	private readonly options: SearchOptions;
	private sort: SortMode;
	private folder: string;
	private folderCandidate: string;
	private readonly initialQuery: string;
	private readonly onClosed: () => void;
	private readonly previewEnabled: boolean;

	private response: SearchResponse | null = null;
	private readonly expanded = new Set<string>();
	private rows: Row[] = [];
	private selected = -1;
	private searchSeq = 0;
	private searching = false;
	private renderedQuery = "";
	private previewSeq = 0;
	private previewFrame: number | null = null;
	private previewCache: { path: string; content: string } | null = null;
	private size: ModalSize | null = null;

	private rootEl!: HTMLElement;
	private headingEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private clearEl!: HTMLElement;
	private toggleEls!: Record<keyof SearchOptions, HTMLElement>;
	private vaultChipEl!: HTMLElement;
	private folderChipEl!: HTMLElement;
	private folderLabelEl!: HTMLElement;
	private previewToggleEl: HTMLElement | null = null;
	private resultsEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private preview!: PreviewPane;

	private readonly scheduleSearch = debounce(() => void this.runSearch(), SEARCH_DELAY_MS, true);
	private readonly scheduleRefresh = debounce(() => void this.runSearch(true), DOWNLOAD_REFRESH_MS, false);

	constructor(app: App, plugin: NeedlePlugin, options: FindModalOptions) {
		super(app);
		this.plugin = plugin;
		this.ids = `needle-${++instanceCount}`;
		const { settings } = plugin;
		this.options = { matchCase: settings.matchCase, wholeWord: settings.wholeWord, regex: settings.regex };
		this.sort = settings.sort;
		this.folder = options.folder;
		this.folderCandidate = options.folder || plugin.activeFolder();
		this.initialQuery = options.query;
		this.onClosed = options.onClosed;
		this.previewEnabled = !Platform.isPhone;
	}

	private get showPreview(): boolean {
		return this.previewEnabled && this.plugin.settings.showPreview;
	}

	onOpen(): void {
		this.modalEl.addClass("needle-modal");
		this.plugin.index.acquire();
		this.build();
		if (!Platform.isPhone) {
			this.makeResizable();
		}
		this.registerKeys();
		this.updateScope();
		this.updatePreviewVisibility();

		this.inputEl.value = this.initialQuery;
		this.inputEl.select();
		this.inputEl.focus();

		this.plugin.index.onIndexProgress = (done, total) => {
			if (total < SLOW_INDEX_FILES) {
				return;
			}
			this.setSummary(done < total ? `Indexing notes… ${done.toLocaleString()} of ${total.toLocaleString()}` : "");
		};
		this.plugin.index.onDownloadProgress = (pending) => this.onDownloadProgress(pending);
		if (this.initialQuery.length > 0) {
			void this.runSearch();
		} else {
			this.renderIdle();
			void this.plugin.index.sync();
		}
	}

	onClose(): void {
		this.searchSeq++;
		this.scheduleSearch.cancel();
		this.scheduleRefresh.cancel();
		if (this.previewFrame !== null) {
			activeWindow.cancelAnimationFrame(this.previewFrame);
		}
		this.plugin.index.onIndexProgress = null;
		this.plugin.index.onDownloadProgress = null;
		this.plugin.lastQuery = this.inputEl.value;
		this.plugin.index.release();
		this.preview.destroy();
		this.contentEl.empty();
		this.onClosed();
	}

	focusInput(): void {
		this.inputEl.focus();
		this.inputEl.select();
	}

	private id(kind: string, index: number): string {
		return `${this.ids}-${kind}-${index}`;
	}

	private build(): void {
		this.rootEl = this.contentEl.createDiv({ cls: "needle" });

		const header = this.rootEl.createDiv({ cls: "needle-header" });
		this.headingEl = header.createDiv({ cls: "needle-title", attr: { id: this.id("title", 0) } });
		this.summaryEl = header.createDiv({ cls: "needle-summary", attr: { role: "status", "aria-live": "polite" } });

		const searchRow = this.rootEl.createDiv({ cls: "needle-search-row" });
		const inputContainer = searchRow.createDiv({ cls: "search-input-container needle-input-container" });
		this.inputEl = inputContainer.createEl("input", {
			type: "search",
			cls: "needle-input",
			attr: {
				placeholder: "Find in notes…",
				spellcheck: "false",
				autocomplete: "off",
				enterkeyhint: "search",
				role: "combobox",
				"aria-labelledby": this.id("title", 0),
				"aria-autocomplete": "list",
				"aria-controls": this.id("results", 0),
				"aria-expanded": "false",
			},
		});
		this.inputEl.addEventListener("input", () => {
			this.updateClearButton();
			this.scheduleSearch();
		});
		this.clearEl = inputContainer.createDiv({
			cls: "search-input-clear-button",
			attr: { "aria-label": "Clear search", role: "button" },
		});
		this.clearEl.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.clearEl.addEventListener("click", () => {
			this.inputEl.value = "";
			this.inputEl.focus();
			this.updateClearButton();
			this.searchNow();
		});

		const toggles = searchRow.createDiv({ cls: "needle-toggles" });
		const alt = Platform.isMacOS ? "⌥" : "Alt+";
		this.toggleEls = {
			matchCase: this.createToggle(toggles, "matchCase", "case-sensitive", "Aa", `Match case (${alt}C)`),
			wholeWord: this.createToggle(toggles, "wholeWord", "whole-word", "W", `Whole word (${alt}W)`),
			regex: this.createToggle(toggles, "regex", "regex", ".*", `Regular expression (${alt}R)`),
		};

		const toolbar = this.rootEl.createDiv({ cls: "needle-toolbar" });
		toolbar.createSpan({ cls: "needle-sr-only", text: "Search in", attr: { id: this.id("scope", 0) } });
		const scope = toolbar.createDiv({
			cls: "needle-scope",
			attr: { role: "group", "aria-labelledby": this.id("scope", 0) },
		});
		this.vaultChipEl = scope.createEl("button", {
			cls: "needle-chip",
			attr: { "aria-label": `Search the whole vault (${shortcut("1")})`, "aria-keyshortcuts": ariaShortcut("1") },
		});
		setIcon(this.vaultChipEl.createSpan({ cls: "needle-chip-icon" }), "vault");
		this.vaultChipEl.createSpan({ text: "Vault" });
		this.vaultChipEl.addEventListener("click", () => this.setFolder(""));

		this.folderChipEl = scope.createEl("button", { cls: "needle-chip", attr: { "aria-keyshortcuts": ariaShortcut("2") } });
		setIcon(this.folderChipEl.createSpan({ cls: "needle-chip-icon" }), "folder");
		this.folderLabelEl = this.folderChipEl.createSpan({ cls: "needle-chip-label" });
		this.folderChipEl.addEventListener("click", () => {
			if (this.folder !== "") {
				this.pickFolder();
				return;
			}
			this.searchFolder();
		});

		const pick = scope.createEl("button", {
			cls: "clickable-icon needle-pick-folder",
			attr: { "aria-label": "Choose folder" },
		});
		setIcon(pick, "folder-search");
		pick.addEventListener("click", () => this.pickFolder());

		toolbar.createDiv({ cls: "needle-spacer" });

		const sort = new DropdownComponent(toolbar)
			.addOptions(SORT_LABELS)
			.setValue(this.sort)
			.onChange((value) => {
				this.sort = value as SortMode;
				this.plugin.settings.sort = this.sort;
				void this.plugin.saveSettings();
				this.searchNow();
			});
		sort.selectEl.addClass("needle-sort");
		sort.selectEl.setAttr("aria-label", "Sort results");

		if (this.previewEnabled) {
			const previewToggle = toolbar.createEl("button", {
				cls: "clickable-icon needle-preview-toggle",
				attr: { "aria-label": "Show preview" },
			});
			setIcon(previewToggle, "panel-bottom");
			previewToggle.addEventListener("mousedown", (evt) => evt.preventDefault());
			previewToggle.addEventListener("click", () => {
				this.plugin.settings.showPreview = !this.plugin.settings.showPreview;
				void this.plugin.saveSettings();
				this.updatePreviewVisibility();
			});
			this.previewToggleEl = previewToggle;
		}

		for (const el of scope.querySelectorAll("button")) {
			el.addEventListener("mousedown", (evt) => evt.preventDefault());
		}

		const body = this.rootEl.createDiv({ cls: "needle-body" });
		this.resultsEl = body.createDiv({
			cls: "needle-results",
			attr: { id: this.id("results", 0), role: "listbox", "aria-labelledby": this.id("title", 0) },
		});
		this.resultsEl.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.resultsEl.addEventListener("click", (evt) => this.onResultClick(evt));
		this.resultsEl.addEventListener("dblclick", (evt) => this.onResultDoubleClick(evt));
		this.resultsEl.addEventListener("auxclick", (evt) => {
			if (evt.button === 1) {
				this.onResultClick(evt);
			}
		});

		this.previewEl = body.createDiv({
			cls: "needle-preview",
			attr: { role: "region", "aria-labelledby": this.id("preview", 0) },
		});
		if (this.previewEnabled) {
			body.createSpan({ cls: "needle-sr-only", text: "Results and preview divider", attr: { id: this.id("split", 0) } });
			new Splitter(this.resultsEl, {
				share: this.plugin.settings.resultsShare,
				labelledBy: this.id("split", 0),
				controls: this.id("results", 0),
				onChange: (share) => this.rootEl.setCssProps({ "--needle-results-share": String(share) }),
				onCommit: (share) => {
					this.plugin.settings.resultsShare = share;
					void this.plugin.saveSettings();
					this.preview.reveal();
				},
			});
		}
		this.preview = new PreviewPane(this.app, this.previewEl, {
			headerId: this.id("preview", 0),
			mode: this.plugin.settings.previewMode,
			modeShortcut: shortcut("E"),
			onModeChange: (mode) => {
				this.plugin.settings.previewMode = mode;
				void this.plugin.saveSettings();
			},
			onOpenLine: (file, line, evt) => {
				const match = file.lines.find((candidate) => candidate.line === line) ?? null;
				void this.openAt(file, line, match, Keymap.isModEvent(evt));
			},
		});

		if (!Platform.isMobile) {
			this.buildFooter();
		}
	}

	private makeResizable(): void {
		const bounds = (): ModalSize => ({ width: this.modalEl.win.innerWidth, height: this.modalEl.win.innerHeight });
		const saved = this.plugin.settings.modalSize;
		this.applySize(saved === null ? null : clampSize(saved, bounds()));
		addResizeHandles(this.modalEl, {
			onResize: (size) => this.applySize(size),
			onCommit: () => {
				this.plugin.settings.modalSize = this.size;
				void this.plugin.saveSettings();
				this.preview.reveal();
			},
			onReset: () => {
				this.applySize(null);
				this.plugin.settings.modalSize = null;
				void this.plugin.saveSettings();
				this.preview.reveal();
			},
		});
	}

	private applySize(size: ModalSize | null): void {
		this.size = size;
		this.modalEl.setCssProps({
			"--needle-modal-width": size === null ? "" : `${size.width}px`,
			"--needle-modal-height": size === null ? "" : `${size.height}px`,
		});
	}

	private createToggle(
		parent: HTMLElement,
		key: keyof SearchOptions,
		icon: string,
		fallback: string,
		label: string,
	): HTMLElement {
		const button = parent.createEl("button", {
			cls: "clickable-icon needle-toggle",
			attr: { "aria-label": label, "aria-pressed": String(this.options[key]) },
		});
		setIcon(button, icon);
		if (button.childElementCount === 0) {
			button.setText(fallback);
		}
		button.toggleClass("is-active", this.options[key]);
		button.addEventListener("mousedown", (evt) => evt.preventDefault());
		button.addEventListener("click", () => this.toggleOption(key));
		return button;
	}

	private buildFooter(): void {
		const mod = Platform.isMacOS ? "⌘" : "Ctrl";
		const alt = Platform.isMacOS ? "⌥" : "Alt";
		const footer = this.rootEl.createDiv({ cls: "prompt-instructions needle-footer" });
		const hints: [string, string][] = [
			["↑↓", "to navigate"],
			["↵", "to open"],
			[`${mod} ↵`, "to open in new tab"],
			[`${mod} ${alt} ↵`, "to open to the right"],
			[`${shortcut("1")} ${shortcut("2")}`, "to search vault or folder"],
			["esc", "to close"],
		];
		for (const [command, purpose] of hints) {
			const hint = footer.createDiv({ cls: "prompt-instruction" });
			hint.createSpan({ cls: "prompt-instruction-command", text: command });
			hint.createSpan({ text: purpose });
		}
	}

	private registerKeys(): void {
		const whenTyping =
			(action: (evt: KeyboardEvent) => void) =>
			(evt: KeyboardEvent): boolean => {
				if (!this.isNavigationTarget(evt.target)) {
					return true;
				}
				action(evt);
				return false;
			};
		this.scope.register([], "ArrowDown", whenTyping(() => this.move(1)));
		this.scope.register([], "ArrowUp", whenTyping(() => this.move(-1)));
		this.scope.register([], "PageDown", whenTyping(() => this.move(PAGE_SIZE)));
		this.scope.register([], "PageUp", whenTyping(() => this.move(-PAGE_SIZE)));
		this.scope.register(null, "Enter", whenTyping((evt) => this.activate(evt)));
		this.scope.register(["Mod"], "1", () => {
			this.setFolder("");
			return false;
		});
		this.scope.register(["Mod"], "2", () => {
			if (this.folder === "") {
				this.searchFolder();
			}
			return false;
		});
		this.scope.register(["Mod"], "E", () => {
			if (this.showPreview) {
				this.preview.toggleMode();
			}
			return false;
		});

		this.modalEl.addEventListener("keydown", (evt) => {
			if (!evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) {
				return;
			}
			const key = OPTION_KEYS[evt.code];
			if (key) {
				evt.preventDefault();
				this.toggleOption(key);
			}
		});
	}

	private isNavigationTarget(target: EventTarget | null): boolean {
		return target === this.inputEl || target === activeDocument.body || target === this.modalEl;
	}

	private toggleOption(key: keyof SearchOptions): void {
		const value = !this.options[key];
		this.options[key] = value;
		this.plugin.settings[key] = value;
		void this.plugin.saveSettings();
		const el = this.toggleEls[key];
		el.toggleClass("is-active", value);
		el.setAttr("aria-pressed", String(value));
		this.searchNow();
	}

	private setFolder(folder: string): void {
		this.folder = folder;
		if (folder !== "") {
			this.folderCandidate = folder;
		}
		this.updateScope();
		this.searchNow();
		this.inputEl.focus();
	}

	private searchFolder(): void {
		if (this.folderCandidate === "") {
			this.pickFolder();
			return;
		}
		this.setFolder(this.folderCandidate);
	}

	private pickFolder(): void {
		new FolderSuggestModal(this.app, (folder: TFolder) => {
			this.setFolder(folder.path);
		}).open();
	}

	private updateScope(): void {
		const inFolder = this.folder !== "";
		this.headingEl.setText(inFolder ? "Find in folder" : "Find in vault");
		this.vaultChipEl.toggleClass("is-active", !inFolder);
		this.vaultChipEl.setAttr("aria-pressed", String(!inFolder));
		this.folderChipEl.toggleClass("is-active", inFolder);
		this.folderChipEl.setAttr("aria-pressed", String(inFolder));
		const folder = this.folderCandidate;
		this.folderLabelEl.setText(folder === "" ? "Folder…" : elidePath(folder, 2));
		this.folderChipEl.setAttr(
			"aria-label",
			`${folder === "" ? "Choose folder" : `Search in ${folder}`} (${shortcut("2")})`,
		);
	}

	private updatePreviewVisibility(): void {
		const visible = this.showPreview;
		this.rootEl.toggleClass("has-preview", visible);
		this.previewToggleEl?.toggleClass("is-active", visible);
		this.previewToggleEl?.setAttr("aria-pressed", String(visible));
		if (visible) {
			this.schedulePreview();
		}
	}

	private updateClearButton(): void {
		this.clearEl.toggleClass("needle-hidden", this.inputEl.value.length === 0);
	}

	private setSummary(text: string): void {
		if (this.summaryEl.getText() !== text) {
			this.summaryEl.setText(text);
		}
	}

	private setInvalid(error: string | null): void {
		this.inputEl.toggleClass("is-invalid", error !== null);
		if (error === null) {
			this.inputEl.removeAttribute("aria-invalid");
			return;
		}
		this.inputEl.setAttr("aria-invalid", "true");
	}

	private searchNow(): void {
		this.scheduleSearch.cancel();
		void this.runSearch();
	}

	private async runSearch(refresh = false): Promise<void> {
		const query = this.inputEl.value;
		if (refresh && (this.response === null || query !== this.renderedQuery)) {
			return;
		}
		if (refresh && this.searching) {
			this.scheduleRefresh();
			return;
		}
		const seq = ++this.searchSeq;
		this.updateClearButton();
		if (query.length === 0) {
			this.setInvalid(null);
			this.renderIdle();
			return;
		}
		const built = buildMatcher(query, this.options);
		if (!built.ok) {
			this.setInvalid(built.error);
			this.setSummary("");
			this.renderMessage("Invalid regular expression", built.error);
			return;
		}
		this.setInvalid(null);
		if (!refresh) {
			this.searching = true;
			this.rootEl.addClass("is-searching");
		}
		const startedAt = performance.now();
		try {
			const response = await this.plugin.index.search(
				{
					query,
					options: { ...this.options },
					folder: this.folder,
					sort: this.sort,
					maxLines: this.plugin.settings.maxResults,
					now: Date.now(),
				},
				(scanned, total) => {
					if (!refresh && seq === this.searchSeq && total > 0 && performance.now() - startedAt > SLOW_SEARCH_MS) {
						this.setSummary(`Searching… ${Math.floor((scanned / total) * 100)}%`);
					}
				},
			);
			if (seq !== this.searchSeq || response === null) {
				return;
			}
			if (refresh) {
				this.applyRefresh(response);
				return;
			}
			this.response = response;
			this.renderedQuery = query;
			this.expanded.clear();
			this.renderResults(query);
		} catch (error) {
			if (seq !== this.searchSeq) {
				return;
			}
			this.response = null;
			this.setSummary("");
			if (error instanceof SearchTimeoutError) {
				this.renderMessage(
					"The search took too long",
					"The regular expression is too complex to finish. Simplify it and try again.",
				);
				return;
			}
			this.renderMessage("The search failed", error instanceof Error ? error.message : String(error));
		} finally {
			if (seq === this.searchSeq) {
				this.searching = false;
				this.rootEl.removeClass("is-searching");
			}
		}
	}

	private onDownloadProgress(pending: number): void {
		if (this.response === null) {
			this.setSummary(this.downloadStatus());
			return;
		}
		if (pending > 0) {
			this.scheduleRefresh();
			return;
		}
		this.scheduleRefresh.cancel();
		void this.runSearch(true);
	}

	private applyRefresh(response: SearchResponse): void {
		const previous = this.response;
		const unchanged =
			previous !== null &&
			previous.totalMatches === response.totalMatches &&
			previous.totalFiles === response.totalFiles;
		if (unchanged && this.plugin.index.pendingDownloads > 0) {
			this.setSummary(this.resultSummary(previous));
			return;
		}
		const row = this.rows[this.selected];
		this.response = response;
		this.rerender(
			(file, match) =>
				row !== undefined && file.path === row.file.path && (row.kind === "more" || match.line === row.match.line),
		);
	}

	private rerender(keep: (file: FileResult, match: LineMatch, lineIndex: number) => boolean): void {
		const scrollTop = this.resultsEl.scrollTop;
		this.renderResults(this.inputEl.value, keep);
		this.resultsEl.scrollTop = scrollTop;
		this.rows[this.selected]?.el.scrollIntoView({ block: "nearest" });
	}

	private downloadStatus(): string {
		const pending = this.plugin.index.pendingDownloads;
		return pending > 0 ? `${formatCount(pending, "note")} still downloading` : "";
	}

	private resultSummary(response: SearchResponse): string {
		const found =
			response.files.length === 0
				? "No matches"
				: `${formatCount(response.totalMatches, "match", "matches")} in ${formatCount(response.totalFiles, "note")}`;
		const downloads = this.downloadStatus();
		return downloads === "" ? found : `${found} · ${downloads}`;
	}

	private renderIdle(): void {
		this.response = null;
		this.renderedQuery = "";
		this.setSummary(this.downloadStatus());
		const alt = Platform.isMacOS ? "⌥" : "Alt+";
		this.renderMessage(
			this.folder === "" ? "Search every note in your vault" : `Search the notes in ${this.folder}`,
			`${alt}C match case · ${alt}W whole word · ${alt}R regular expression`,
		);
	}

	private renderMessage(title: string, detail?: string): void {
		this.rows = [];
		this.selected = -1;
		this.rootEl.removeClass("has-results");
		this.resultsEl.empty();
		this.inputEl.setAttr("aria-expanded", "false");
		this.inputEl.removeAttribute("aria-activedescendant");
		const box = this.resultsEl.createDiv({ cls: "needle-empty" });
		box.createDiv({ cls: "needle-empty-title", text: title });
		if (detail) {
			box.createDiv({ cls: "needle-empty-detail", text: detail });
		}
		this.preview.clear();
	}

	private renderResults(query: string, keep?: (file: FileResult, match: LineMatch, lineIndex: number) => boolean): void {
		const response = this.response;
		if (response === null) {
			return;
		}
		this.setSummary(this.resultSummary(response));
		if (response.files.length === 0) {
			this.renderMessage(`No matches for “${query}”`, this.noMatchHint());
			return;
		}

		this.rows = [];
		this.selected = -1;
		this.resultsEl.empty();
		const fragment = createFragment();
		let keepIndex = -1;
		response.files.forEach((file, fileIndex) => {
			const group = fragment.createDiv({ cls: "needle-file", attr: { role: "group" } });
			const headerEl = this.renderFileHeader(group, file, fileIndex);
			const expanded = this.expanded.has(file.path);
			const visible = expanded ? file.lines : file.lines.slice(0, LINES_PER_FILE);
			visible.forEach((match, lineIndex) => {
				if (keepIndex === -1 && keep?.(file, match, lineIndex)) {
					keepIndex = this.rows.length;
				}
				const el = group.createDiv({
					cls: "needle-line",
					attr: { role: "option", id: this.id("row", this.rows.length), "aria-selected": "false" },
				});
				el.dataset.row = String(this.rows.length);
				const numberEl = el.createSpan({ cls: "needle-line-number" });
				numberEl.createSpan({ cls: "needle-sr-only", text: "Line " });
				numberEl.appendText(String(match.line + 1));
				const textEl = el.createSpan({ cls: "needle-line-text" });
				const snippet = this.fitSnippet(match);
				if (snippet.clippedStart) {
					textEl.createSpan({ cls: "needle-ellipsis", text: "…" });
				}
				appendHighlighted(textEl, snippet.text, match.ranges, snippet.offset);
				if (match.clippedEnd) {
					textEl.createSpan({ cls: "needle-ellipsis", text: "…" });
				}
				this.rows.push({ kind: "line", el, headerEl: lineIndex === 0 ? headerEl : null, file, match });
			});
			const hidden = file.lines.length - visible.length;
			if (hidden > 0) {
				const el = group.createDiv({
					cls: "needle-line needle-more",
					attr: { role: "option", id: this.id("row", this.rows.length), "aria-selected": "false" },
				});
				el.dataset.row = String(this.rows.length);
				el.createSpan({ cls: "needle-line-number" });
				el.createSpan({ cls: "needle-line-text", text: `Show ${formatCount(hidden, "more line")}` });
				this.rows.push({ kind: "more", el, headerEl: null, file, hidden });
			}
		});
		if (response.truncated) {
			fragment.createDiv({
				cls: "needle-truncated",
				text: `Listing the first ${this.plugin.settings.maxResults.toLocaleString()} matching lines. Refine the search to see the rest.`,
			});
		}
		this.resultsEl.appendChild(fragment);
		this.resultsEl.scrollTop = 0;
		this.rootEl.addClass("has-results");
		this.inputEl.setAttr("aria-expanded", "true");
		this.select(Math.max(0, keepIndex));
	}

	private fitSnippet(match: LineMatch): { text: string; offset: number; clippedStart: boolean } {
		const firstStart = match.ranges[0]?.[0] ?? match.offset;
		const cut = firstStart - match.offset - PHONE_SNIPPET_CONTEXT;
		if (!Platform.isPhone || cut <= 0) {
			return { text: match.text, offset: match.offset, clippedStart: match.clippedStart };
		}
		const space = match.text.indexOf(" ", cut);
		const start = space !== -1 && space < cut + PHONE_SNIPPET_CONTEXT ? space + 1 : cut;
		return { text: match.text.slice(start), offset: match.offset + start, clippedStart: true };
	}

	private renderFileHeader(group: HTMLElement, file: FileResult, fileIndex: number): HTMLElement {
		const headerId = this.id("file", fileIndex);
		group.setAttr("aria-labelledby", headerId);
		const header = group.createDiv({ cls: "needle-file-header", attr: { id: headerId } });
		header.dataset.file = String(fileIndex);
		setIcon(header.createSpan({ cls: "needle-file-icon", attr: { "aria-hidden": "true" } }), "file-text");
		header.createSpan({ cls: "needle-file-name", text: file.title });
		const folder = parentFolder(file.path);
		if (folder.length > 0) {
			header.createSpan({ cls: "needle-file-folder", text: elidePath(folder), attr: { "aria-label": folder } });
		}
		header.createSpan({
			cls: "needle-file-count",
			text: file.matchCount.toLocaleString(),
			attr: { "aria-label": formatCount(file.matchCount, "match", "matches") },
		});
		return header;
	}

	private noMatchHint(): string {
		if (this.plugin.index.pendingDownloads > 0) {
			return "Some notes are still downloading, so matches in them can still appear.";
		}
		const tips: string[] = [];
		if (this.options.matchCase) {
			tips.push("turn off match case");
		}
		if (this.options.wholeWord) {
			tips.push("turn off whole word");
		}
		if (this.folder !== "") {
			tips.push("search the whole vault");
		}
		if (tips.length === 0) {
			return "Check the spelling or try a shorter search.";
		}
		const text = tips.join(", or ");
		return `Try to ${text}.`;
	}

	private select(index: number): void {
		if (this.rows.length === 0) {
			this.selected = -1;
			this.inputEl.removeAttribute("aria-activedescendant");
			return;
		}
		const next = Math.min(this.rows.length - 1, Math.max(0, index));
		const previous = this.rows[this.selected];
		if (previous) {
			previous.el.removeClass("is-selected");
			previous.el.setAttr("aria-selected", "false");
		}
		const row = this.rows[next];
		if (!row) {
			return;
		}
		this.selected = next;
		row.el.addClass("is-selected");
		row.el.setAttr("aria-selected", "true");
		this.inputEl.setAttr("aria-activedescendant", row.el.id);
		row.el.scrollIntoView({ block: "nearest" });
		row.headerEl?.scrollIntoView({ block: "nearest" });
		this.schedulePreview();
	}

	private move(delta: number): void {
		if (this.rows.length === 0) {
			return;
		}
		const last = this.rows.length - 1;
		let next = this.selected + delta;
		if (Math.abs(delta) === 1) {
			next = next < 0 ? last : next > last ? 0 : next;
		}
		this.select(next);
	}

	private activate(evt: KeyboardEvent | MouseEvent): void {
		const row = this.rows[this.selected];
		if (!row) {
			return;
		}
		if (row.kind === "more") {
			this.expand(row.file);
			return;
		}
		void this.openAt(row.file, row.match.line, row.match, Keymap.isModEvent(evt));
	}

	private expand(file: FileResult): void {
		this.expanded.add(file.path);
		this.rerender((candidate, _match, lineIndex) => candidate.path === file.path && lineIndex === LINES_PER_FILE);
	}

	private rowFromEvent(evt: MouseEvent): { row: Row; index: number } | { header: number } | null {
		const target = evt.target;
		if (!(target instanceof Element)) {
			return null;
		}
		const rowEl = target.closest<HTMLElement>("[data-row]");
		if (rowEl) {
			const index = Number(rowEl.dataset.row);
			const row = this.rows[index];
			return row ? { row, index } : null;
		}
		const headerEl = target.closest<HTMLElement>("[data-file]");
		return headerEl ? { header: Number(headerEl.dataset.file) } : null;
	}

	private firstRowOfFile(fileIndex: number): number {
		const file = this.response?.files[fileIndex];
		return this.rows.findIndex((row) => row.file === file);
	}

	private onResultClick(evt: MouseEvent): void {
		const hit = this.rowFromEvent(evt);
		if (hit === null) {
			return;
		}
		if ("header" in hit) {
			this.select(this.firstRowOfFile(hit.header));
			return;
		}
		this.select(hit.index);
		const pane = Keymap.isModEvent(evt);
		if (hit.row.kind === "more" || pane !== false || !this.showPreview) {
			this.activate(evt);
		}
	}

	private onResultDoubleClick(evt: MouseEvent): void {
		const hit = this.rowFromEvent(evt);
		if (hit === null) {
			return;
		}
		if ("header" in hit) {
			this.select(this.firstRowOfFile(hit.header));
		}
		if (this.rows[this.selected]?.kind === "line") {
			this.activate(evt);
		}
	}

	private schedulePreview(): void {
		if (!this.showPreview || this.previewFrame !== null) {
			return;
		}
		this.previewFrame = activeWindow.requestAnimationFrame(() => {
			this.previewFrame = null;
			void this.updatePreview();
		});
	}

	private async updatePreview(): Promise<void> {
		const row = this.rows[this.selected];
		if (!row) {
			this.preview.clear();
			return;
		}
		const { file } = row;
		const line = row.kind === "line" ? row.match.line : (file.lines[LINES_PER_FILE]?.line ?? 0);
		const seq = ++this.previewSeq;
		let content = this.previewCache?.path === file.path ? this.previewCache.content : null;
		if (content === null) {
			const target = this.app.vault.getFileByPath(file.path);
			if (target === null) {
				this.preview.showMessage("This note no longer exists.");
				return;
			}
			content = await this.app.vault.cachedRead(target);
			if (seq !== this.previewSeq) {
				return;
			}
			this.previewCache = { path: file.path, content };
		}
		this.preview.show(file, content, line);
	}

	private async openAt(
		file: FileResult,
		line: number,
		match: LineMatch | null,
		pane: PaneType | boolean,
	): Promise<void> {
		const target = this.app.vault.getFileByPath(file.path);
		if (target === null) {
			new Notice("This note no longer exists.");
			return;
		}
		this.close();
		const leaf = this.app.workspace.getLeaf(pane);
		await leaf.openFile(target, { active: true, eState: { line } });
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.getMode() !== "source") {
			return;
		}
		const [start, end] = match?.ranges[0] ?? [0, 0];
		const from = { line, ch: start };
		const to = { line, ch: end };
		view.editor.setSelection(from, to);
		view.editor.scrollIntoView({ from, to }, true);
	}
}
