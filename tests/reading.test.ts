import { describe, expect, it } from "vitest";
import type { Range } from "../src/search/types";
import { activeHit, collectNeedles, findNeedles, splitBlocks } from "../src/ui/reading";
import { frontmatterClose } from "../src/ui/text";

describe("frontmatterClose", () => {
	it("finds the line that closes the frontmatter", () => {
		expect(frontmatterClose(["---", "tags: [a]", "---", "body"])).toBe(2);
		expect(frontmatterClose(["body", "---"])).toBe(-1);
		expect(frontmatterClose(["---", "tags: [a]"])).toBe(-1);
	});
});

describe("splitBlocks", () => {
	it("keeps the frontmatter apart and cuts at each section start", () => {
		expect(splitBlocks([0, 4, 6, 6], 2, 0, 9)).toEqual([
			{ start: 0, end: 3, frontmatter: true },
			{ start: 3, end: 4, frontmatter: false },
			{ start: 4, end: 6, frontmatter: false },
			{ start: 6, end: 9, frontmatter: false },
		]);
	});

	it("only cuts inside the rendered window", () => {
		expect(splitBlocks([0, 10, 20, 30], -1, 15, 25)).toEqual([
			{ start: 15, end: 20, frontmatter: false },
			{ start: 20, end: 25, frontmatter: false },
		]);
	});
});

describe("collectNeedles", () => {
	it("lists each matched text once and which one every match is", () => {
		const lines = ["Plan the airplane", "plan again"];
		const ranges = new Map<number, Range[]>([
			[0, [[0, 4], [12, 16]]],
			[1, [[0, 4]]],
		]);
		expect(collectNeedles(lines, ranges, 0, 2)).toEqual({
			needles: [
				{ text: "Plan", wholeWord: true },
				{ text: "plan", wholeWord: false },
				{ text: "plan", wholeWord: true },
			],
			hits: [
				{ line: 0, needle: 0 },
				{ line: 0, needle: 1 },
				{ line: 1, needle: 2 },
			],
		});
	});
});

describe("activeHit", () => {
	it("counts earlier matches of the same text", () => {
		const hits = [
			{ line: 1, needle: 0 },
			{ line: 2, needle: 1 },
			{ line: 4, needle: 0 },
		];
		expect(activeHit(hits, 4)).toEqual({ needle: 0, nth: 1 });
		expect(activeHit(hits, 2)).toEqual({ needle: 1, nth: 0 });
		expect(activeHit(hits, 3)).toBeNull();
	});
});

describe("findNeedles", () => {
	it("finds whole-word needles only where they stand alone", () => {
		const found = findNeedles("plan the airplane", [{ text: "plan", wholeWord: true }]);
		expect(found).toEqual([{ range: [0, 4], needle: 0 }]);
	});

	it("prefers the longer needle, then the whole-word one, without overlaps", () => {
		const needles = [
			{ text: "plan", wholeWord: false },
			{ text: "plan", wholeWord: true },
			{ text: "plane", wholeWord: false },
		];
		expect(findNeedles("plan airplane", needles)).toEqual([
			{ range: [0, 4], needle: 1 },
			{ range: [8, 13], needle: 2 },
		]);
	});
});
