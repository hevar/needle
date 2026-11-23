import { isWholeWord } from "../search/matcher";
import type { Range } from "../search/types";

export type Block = { start: number; end: number; frontmatter: boolean };

export type Needle = { text: string; wholeWord: boolean };

export type NeedleHit = { line: number; needle: number };

export const splitBlocks = (sectionStarts: readonly number[], frontmatterClose: number, start: number, end: number): Block[] => {
	const blocks: Block[] = [];
	let from = start;
	if (from <= frontmatterClose) {
		const to = Math.min(end, frontmatterClose + 1);
		blocks.push({ start: from, end: to, frontmatter: true });
		from = to;
	}
	const cuts = [...new Set(sectionStarts)].filter((line) => line > from && line < end).sort((a, b) => a - b);
	for (const cut of [...cuts, end]) {
		if (cut > from) {
			blocks.push({ start: from, end: cut, frontmatter: false });
			from = cut;
		}
	}
	return blocks;
};

/**
 * The distinct matched texts in lines `start` to `end`, and which one each
 * match is, in order. A match that stood alone as a word only counts where it
 * stands alone in the rendered note too.
 */
export const collectNeedles = (
	lines: readonly string[],
	ranges: ReadonlyMap<number, Range[]>,
	start: number,
	end: number,
): { needles: Needle[]; hits: NeedleHit[] } => {
	const needles: Needle[] = [];
	const indexes = new Map<string, number>();
	const hits: NeedleHit[] = [];
	for (let line = start; line < end; line++) {
		const text = lines[line] ?? "";
		for (const [from, to] of ranges.get(line) ?? []) {
			const needle = { text: text.slice(from, to), wholeWord: isWholeWord(text, from, to) };
			if (needle.text.length === 0) {
				continue;
			}
			const key = `${needle.wholeWord ? "w" : "p"}${needle.text}`;
			let index = indexes.get(key);
			if (index === undefined) {
				index = needles.push(needle) - 1;
				indexes.set(key, index);
			}
			hits.push({ line, needle: index });
		}
	}
	return { needles, hits };
};

export const activeHit = (hits: readonly NeedleHit[], line: number): { needle: number; nth: number } | null => {
	const index = hits.findIndex((hit) => hit.line === line);
	const hit = hits[index];
	if (hit === undefined) {
		return null;
	}
	const nth = hits.slice(0, index).filter((other) => other.needle === hit.needle).length;
	return { needle: hit.needle, nth };
};

/**
 * Every place a needle appears in `text`, in order and without overlaps. Where
 * two start together the longer one wins, then the whole-word one.
 */
export const findNeedles = (text: string, needles: readonly Needle[]): { range: Range; needle: number }[] => {
	const found: { range: Range; needle: number }[] = [];
	for (const [needle, { text: target, wholeWord }] of needles.entries()) {
		for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + 1)) {
			if (!wholeWord || isWholeWord(text, at, at + target.length)) {
				found.push({ range: [at, at + target.length], needle });
			}
		}
	}
	const wholeWordFirst = (needle: number): number => (needles[needle]?.wholeWord === true ? 0 : 1);
	found.sort(
		(a, b) => a.range[0] - b.range[0] || b.range[1] - a.range[1] || wholeWordFirst(a.needle) - wholeWordFirst(b.needle),
	);
	let cursor = 0;
	return found.filter(({ range: [from, to] }) => {
		if (from < cursor) {
			return false;
		}
		cursor = to;
		return true;
	});
};
