import { Component, MarkdownRenderer, type App } from "obsidian";
import type { FileResult, Range } from "../search/types";
import { activeHit, collectNeedles, findNeedles, splitBlocks, type Needle, type NeedleHit } from "./reading";
import { appendHighlighted, classifyLines, formatCount, frontmatterClose, parentFolder } from "./text";

export type PreviewMode = "source" | "reading";

export type PreviewPaneOptions = {
	headerId: string;
	mode: PreviewMode;
	modeShortcut: string;
	onModeChange: (mode: PreviewMode) => void;
	onOpenLine: (file: FileResult, line: number, evt: MouseEvent) => void;
};

type Mark = { el: HTMLElement; needle: number };

type RenderedBlock = {
	start: number;
	end: number;
	el: HTMLElement;
	needles: Needle[];
	hits: NeedleHit[];
	marks: Mark[];
};

const MAX_RENDERED_LINES = 1500;
const MODES: PreviewMode[] = ["source", "reading"];
const MODE_LABELS: Record<PreviewMode, string> = { source: "Source", reading: "Reading" };
const MODE_TOOLTIPS: Record<PreviewMode, string> = { source: "Show the Markdown source", reading: "Show as in reading view" };
const NOT_HIGHLIGHTED = "svg, style, script, .math, mjx-container";

const highlightNeedles = (root: HTMLElement, needles: readonly Needle[]): Mark[] => {
	const walker = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const parent = node.parentElement;
		if (node.instanceOf(Text) && parent !== null && parent.closest(NOT_HIGHLIGHTED) === null) {
			nodes.push(node);
		}
	}
	const marks: Mark[] = [];
	for (const node of nodes) {
		const text = node.data;
		const found = findNeedles(text, needles);
		if (found.length === 0) {
			continue;
		}
		const fragment = root.doc.createDocumentFragment();
		let cursor = 0;
		for (const { range, needle } of found) {
			if (range[0] > cursor) {
				fragment.append(text.slice(cursor, range[0]));
			}
			const el = root.doc.createElement("mark");
			el.className = "needle-match";
			el.textContent = text.slice(range[0], range[1]);
			fragment.append(el);
			marks.push({ el, needle });
			cursor = range[1];
		}
		if (cursor < text.length) {
			fragment.append(text.slice(cursor));
		}
		node.replaceWith(fragment);
	}
	return marks;
};

/**
 * Read-only view of a note around the selected match, with every match
 * highlighted. Source mode lists the lines with line numbers, inserted as text
 * nodes, never parsed as HTML. Reading mode renders the note with Obsidian's
 * own Markdown renderer, one section at a time so each match can be found.
 */
export class PreviewPane {
	private readonly headerEl: HTMLElement;
	private readonly infoEl: HTMLElement;
	private readonly modeEls = new Map<PreviewMode, HTMLElement>();
	private readonly bodyEl: HTMLElement;
	private mode: PreviewMode;
	private file: FileResult | null = null;
	private content = "";
	private window: [number, number] = [0, 0];
	private lineEls = new Map<number, HTMLElement>();
	private blocks: RenderedBlock[] = [];
	private component: Component | null = null;
	private renderSeq = 0;
	private ready = false;
	private activeLine = -1;
	private activeEls: HTMLElement[] = [];
	private anchorEl: HTMLElement | null = null;

	constructor(
		private readonly app: App,
		containerEl: HTMLElement,
		private readonly options: PreviewPaneOptions,
	) {
		this.mode = options.mode;
		this.headerEl = containerEl.createDiv({ cls: "needle-preview-header needle-hidden" });
		this.infoEl = this.headerEl.createDiv({ cls: "needle-preview-info", attr: { id: options.headerId } });
		const modesEl = this.headerEl.createDiv({
			cls: "needle-preview-modes",
			attr: { role: "group", "aria-label": "Preview mode" },
		});
		for (const mode of MODES) {
			const button = modesEl.createEl("button", {
				cls: "needle-preview-mode",
				text: MODE_LABELS[mode],
				attr: { "aria-label": `${MODE_TOOLTIPS[mode]} (${options.modeShortcut})` },
			});
			button.addEventListener("mousedown", (evt) => evt.preventDefault());
			button.addEventListener("click", () => this.setMode(mode));
			this.modeEls.set(mode, button);
		}
		this.updateModeButtons();

		this.bodyEl = containerEl.createDiv({ cls: "needle-preview-body" });
		this.bodyEl.addEventListener("dblclick", (evt) => {
			const line = this.lineFromEvent(evt);
			if (this.file !== null && line !== null) {
				this.options.onOpenLine(this.file, line, evt);
			}
		});
		this.bodyEl.addEventListener("click", (evt) => {
			const target = evt.targetNode;
			if (target !== null && target.instanceOf(Element) && target.closest("a") !== null) {
				evt.preventDefault();
			}
		});
	}

	show(file: FileResult, content: string, line: number): void {
		const [start, end] = this.window;
		if (this.file !== file || line < start || line >= end) {
			this.render(file, content, line);
		}
		this.setActive(line);
	}

	toggleMode(): void {
		this.setMode(this.mode === "source" ? "reading" : "source");
	}

	showMessage(text: string): void {
		this.reset();
		this.file = null;
		this.headerEl.addClass("needle-hidden");
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "needle-preview-message", text });
	}

	clear(): void {
		this.showMessage("");
	}

	destroy(): void {
		this.reset();
	}

	reveal(): void {
		const anchor = this.anchorEl;
		if (anchor === null || !anchor.isConnected) {
			return;
		}
		const view = this.bodyEl.getBoundingClientRect();
		const rect = anchor.getBoundingClientRect();
		const margin = rect.height > this.bodyEl.clientHeight ? 0 : (this.bodyEl.clientHeight - rect.height) / 2;
		this.bodyEl.scrollTop = Math.max(0, this.bodyEl.scrollTop + rect.top - view.top - margin);
	}

	private setMode(mode: PreviewMode): void {
		if (mode === this.mode) {
			return;
		}
		this.mode = mode;
		this.updateModeButtons();
		this.options.onModeChange(mode);
		const { file, activeLine } = this;
		if (file !== null) {
			this.render(file, this.content, activeLine);
			this.setActive(activeLine);
		}
	}

	private updateModeButtons(): void {
		for (const [mode, el] of this.modeEls) {
			el.toggleClass("is-active", mode === this.mode);
			el.setAttr("aria-pressed", String(mode === this.mode));
		}
	}

	private reset(): void {
		this.renderSeq++;
		this.component?.unload();
		this.component = null;
		this.lineEls.clear();
		this.blocks = [];
		this.ready = false;
		this.activeLine = -1;
		this.activeEls = [];
		this.anchorEl = null;
	}

	private render(file: FileResult, content: string, line: number): void {
		this.reset();
		this.file = file;
		this.content = content;

		this.headerEl.removeClass("needle-hidden");
		this.infoEl.empty();
		this.infoEl.createSpan({ cls: "needle-preview-label", text: "Preview" });
		this.infoEl.createSpan({ cls: "needle-preview-name", text: file.title });
		const folder = parentFolder(file.path);
		if (folder.length > 0) {
			this.infoEl.createSpan({ cls: "needle-preview-folder", text: folder });
		}

		const lines = content.split("\n").map((text) => text.replace(/\r$/, ""));
		const total = lines.length;
		let start = 0;
		let end = total;
		if (total > MAX_RENDERED_LINES) {
			start = Math.min(Math.max(0, line - MAX_RENDERED_LINES / 2), total - MAX_RENDERED_LINES);
			end = start + MAX_RENDERED_LINES;
		}
		this.window = [start, end];

		const ranges = new Map<number, Range[]>();
		for (const match of file.lines) {
			ranges.set(match.line, match.ranges);
		}

		this.bodyEl.empty();
		this.bodyEl.toggleClass("is-reading", this.mode === "reading");
		if (start > 0) {
			this.bodyEl.createDiv({ cls: "needle-preview-gap", text: `${formatCount(start, "line")} above` });
		}
		if (this.mode === "source") {
			this.renderSource(lines, start, end, ranges);
		} else {
			void this.renderReading(file, lines, start, end, ranges);
		}
		if (end < total) {
			this.bodyEl.createDiv({ cls: "needle-preview-gap", text: `${formatCount(total - end, "line")} below` });
		}
	}

	private renderSource(lines: string[], start: number, end: number, ranges: Map<number, Range[]>): void {
		const kinds = classifyLines(lines);
		this.bodyEl.setCssProps({ "--needle-gutter-width": `${String(end).length + 1}ch` });
		const fragment = createFragment();
		for (let index = start; index < end; index++) {
			const text = lines[index] ?? "";
			const lineEl = fragment.createDiv({ cls: "needle-preview-line", attr: { "data-needle-line": String(index) } });
			const kind = kinds[index];
			if (kind) {
				lineEl.addClass(`is-${kind}`);
			}
			lineEl.createSpan({ cls: "needle-preview-number", text: String(index + 1) });
			const textEl = lineEl.createSpan({ cls: "needle-preview-text" });
			const lineRanges = ranges.get(index);
			if (lineRanges) {
				lineEl.addClass("has-match");
				appendHighlighted(textEl, text, lineRanges);
			} else {
				textEl.setText(text);
			}
			this.lineEls.set(index, lineEl);
		}
		this.bodyEl.appendChild(fragment);
		this.ready = true;
	}

	private async renderReading(
		file: FileResult,
		lines: string[],
		start: number,
		end: number,
		ranges: Map<number, Range[]>,
	): Promise<void> {
		const seq = this.renderSeq;
		const target = this.app.vault.getFileByPath(file.path);
		const sections = target === null ? [] : (this.app.metadataCache.getFileCache(target)?.sections ?? []);
		const close = frontmatterClose(lines);
		const component = new Component();
		component.load();
		this.component = component;

		const containerEl = this.bodyEl.createDiv({ cls: "needle-preview-rendered markdown-rendered" });
		const blocks = splitBlocks(
			sections.map((section) => section.position.start.line),
			close,
			start,
			end,
		).map((block): RenderedBlock & { frontmatter: boolean } => ({
			...block,
			...collectNeedles(lines, ranges, block.start, block.end),
			el: containerEl.createDiv({ cls: "needle-preview-block" }),
			marks: [],
		}));

		await Promise.all(
			blocks.map(async (block) => {
				if (block.frontmatter) {
					block.el.addClass("needle-preview-frontmatter");
					for (let index = block.start; index < block.end; index++) {
						if (index !== 0 && index !== close) {
							block.el.createDiv({ text: lines[index] ?? "", attr: { "data-needle-line": String(index) } });
						}
					}
					return;
				}
				const markdown = lines.slice(block.start, block.end).join("\n");
				try {
					await MarkdownRenderer.render(this.app, markdown, block.el, file.path, component);
				} catch {
					block.el.empty();
					block.el.createDiv({ cls: "needle-preview-plain", text: markdown });
				}
			}),
		);
		if (seq !== this.renderSeq) {
			return;
		}
		for (const block of blocks) {
			if (block.needles.length > 0) {
				block.marks = highlightNeedles(block.el, block.needles);
			}
		}
		this.blocks = blocks;
		this.ready = true;
		this.applyActive();
	}

	private setActive(line: number): void {
		if (line === this.activeLine) {
			return;
		}
		this.activeLine = line;
		if (this.ready) {
			this.applyActive();
		}
	}

	private applyActive(): void {
		for (const el of this.activeEls) {
			el.removeClass("is-active");
		}
		this.activeEls = [];
		this.anchorEl = null;
		const line = this.activeLine;
		if (this.mode === "source") {
			const lineEl = this.lineEls.get(line);
			if (lineEl) {
				this.activeEls = [lineEl];
				this.anchorEl = lineEl.querySelector<HTMLElement>("mark") ?? lineEl;
			}
		} else {
			const block = this.blocks.find((candidate) => candidate.start <= line && line < candidate.end);
			if (block) {
				const hit = activeHit(block.hits, line);
				const mark = hit === null ? undefined : block.marks.filter((candidate) => candidate.needle === hit.needle)[hit.nth];
				this.activeEls = mark === undefined ? [block.el] : [block.el, mark.el];
				this.anchorEl = mark?.el ?? block.el;
			}
		}
		for (const el of this.activeEls) {
			el.addClass("is-active");
		}
		this.reveal();
	}

	private lineFromEvent(evt: MouseEvent): number | null {
		const target = evt.targetNode;
		if (target === null || !target.instanceOf(Element)) {
			return null;
		}
		const value = target.closest<HTMLElement>("[data-needle-line]")?.dataset.needleLine;
		if (value !== undefined) {
			return Number(value);
		}
		const block = this.blocks.find((candidate) => candidate.el.contains(target));
		if (block === undefined) {
			return null;
		}
		if (block.start <= this.activeLine && this.activeLine < block.end) {
			return this.activeLine;
		}
		return block.hits[0]?.line ?? block.start;
	}
}
