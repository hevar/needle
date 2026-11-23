import type { Range } from "../search/types";

export const parentFolder = (path: string): string => {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
};

export const elidePath = (folder: string, maxSegments = 3): string => {
	const parts = folder.split("/");
	if (parts.length <= maxSegments) {
		return folder;
	}
	return [parts[0], "…", ...parts.slice(-(maxSegments - 1))].join("/");
};

export const formatCount = (count: number, singular: string, pluralForm = `${singular}s`): string =>
	`${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;

/**
 * Appends `text` to `el` with every range wrapped in a `<mark>`. Ranges are in
 * the coordinates of the full line; `offset` is where `text` starts in it.
 */
export const appendHighlighted = (el: HTMLElement, text: string, ranges: Range[], offset = 0): void => {
	let cursor = 0;
	for (const [rangeStart, rangeEnd] of ranges) {
		const start = Math.min(text.length, Math.max(0, rangeStart - offset));
		const end = Math.min(text.length, Math.max(0, rangeEnd - offset));
		if (end <= start || start < cursor) {
			continue;
		}
		if (start > cursor) {
			el.appendText(text.slice(cursor, start));
		}
		el.createEl("mark", { cls: "needle-match", text: text.slice(start, end) });
		cursor = end;
	}
	if (cursor < text.length) {
		el.appendText(text.slice(cursor));
	}
};

export type LineKind = "frontmatter" | "heading" | "code" | "quote" | null;

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^#{1,6}\s/;
const QUOTE = /^\s*>/;

export const frontmatterClose = (lines: readonly string[]): number => {
	if (lines[0]?.trimEnd() !== "---") {
		return -1;
	}
	return lines.findIndex((line, position) => position > 0 && line.trimEnd() === "---");
};

export const classifyLines = (lines: string[]): LineKind[] => {
	const kinds: LineKind[] = new Array<LineKind>(lines.length).fill(null);
	const close = frontmatterClose(lines);
	let index = 0;
	for (; index <= close; index++) {
		kinds[index] = "frontmatter";
	}
	let fence: string | null = null;
	for (; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const marker = FENCE.exec(line)?.[1] ?? null;
		if (fence !== null) {
			kinds[index] = "code";
			if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
				fence = null;
			}
			continue;
		}
		if (marker !== null) {
			fence = marker;
			kinds[index] = "code";
		} else if (HEADING.test(line)) {
			kinds[index] = "heading";
		} else if (QUOTE.test(line)) {
			kinds[index] = "quote";
		}
	}
	return kinds;
};
