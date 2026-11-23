import { describe, expect, it } from "vitest";
import { fold, matchNote, mergeRanges, prepareCandidate, tokenize, type NoteMatch } from "../src/search/noteMatcher";

const match = (title: string, folder: string, query: string, aliases: string[] = []): NoteMatch | null =>
	matchNote(prepareCandidate(title, folder, aliases), tokenize(query));

const score = (title: string, folder: string, query: string): number => match(title, folder, query)?.score ?? -1;

describe("fold", () => {
	it("lowercases and strips accents without changing the length", () => {
		expect(fold("Café Ärger")).toBe("cafe arger");
		expect(fold("日本語")).toBe("日本語");
		expect(fold("İstanbul")).toHaveLength("İstanbul".length);
	});
});

describe("tokenize", () => {
	it("splits on spaces and slashes", () => {
		expect(tokenize("  Alpha/plan  notes ")).toEqual(["alpha", "plan", "notes"]);
		expect(tokenize("   ")).toEqual([]);
	});
});

describe("matchNote", () => {
	it("highlights the matched part of the title", () => {
		expect(match("Kubernetes", "", "kube")?.nameRanges).toEqual([[0, 4]]);
	});

	it("ranks the title start above a word start above the middle of a word", () => {
		const start = score("Plan", "", "plan");
		const word = score("Alpha plan", "", "plan");
		const inside = score("Airplane", "", "plan");
		expect(start).toBeGreaterThan(word);
		expect(word).toBeGreaterThan(inside);
	});

	it("ranks an exact title above a longer one", () => {
		expect(score("Kubernetes", "Archive", "kubernetes")).toBeGreaterThan(score("Kubernetes notes", "", "kubernetes"));
	});

	it("treats camel case and punctuation as word starts", () => {
		expect(match("myPlan", "", "plan")?.score).toBe(match("my-plan", "", "plan")?.score);
	});

	it("matches words in any order across title and folder", () => {
		const found = match("Plan", "Projects/Alpha", "alpha plan");
		expect(found?.nameRanges).toEqual([[0, 4]]);
		expect(found?.folderRanges).toEqual([[9, 14]]);
		expect(match("Plan", "Projects/Alpha", "beta plan")).toBeNull();
	});

	it("prefers the title over the folder for the same word", () => {
		const found = match("Alpha notes", "Alpha", "alpha");
		expect(found?.nameRanges).toEqual([[0, 5]]);
		expect(found?.folderRanges).toEqual([]);
	});

	it("falls back to letters in order, preferring word starts", () => {
		expect(match("Design system", "", "dsys")?.nameRanges).toEqual([
			[0, 1],
			[7, 10],
		]);
		expect(score("Design system", "", "dsys")).toBeLessThan(score("Design system", "", "sys"));
		expect(match("Design system", "", "xyz")).toBeNull();
	});

	it("ignores scattered letters and folder matches inside a word", () => {
		expect(match("Old kubernetes notes", "", "de")).toBeNull();
		expect(match("Daily template", "", "de")).toBeNull();
		expect(match("Ärger", "Unicode", "de")).toBeNull();
		expect(match("Ärger", "Unicode", "uni")?.folderRanges).toEqual([[0, 3]]);
	});

	it("ignores accents and case", () => {
		expect(match("Ärger", "Unicode", "arg")?.nameRanges).toEqual([[0, 3]]);
		expect(match("Café notes", "", "CAFE")?.nameRanges).toEqual([[0, 4]]);
	});

	it("matches aliases and reports which name matched", () => {
		const found = match("Product roadmap", "Projects", "q1", ["Roadmap 2027", "Q1 plan"]);
		expect(found?.name).toBe(2);
		expect(found?.nameRanges).toEqual([[0, 2]]);
	});

	it("shows the title when it matches, scoring it like the better alias", () => {
		const found = match("Product roadmap", "", "roadmap", ["Roadmap 2027"]);
		expect(found?.name).toBe(0);
		expect(found?.nameRanges).toEqual([[8, 15]]);
		expect(found?.score).toBeGreaterThan(score("Product roadmap", "", "roadmap"));
	});

	it("returns null for an empty query", () => {
		expect(match("Plan", "", "  ")).toBeNull();
	});
});

describe("mergeRanges", () => {
	it("sorts and merges overlapping ranges", () => {
		expect(
			mergeRanges([
				[5, 8],
				[0, 2],
				[1, 3],
				[8, 9],
			]),
		).toEqual([
			[0, 3],
			[5, 9],
		]);
	});
});
