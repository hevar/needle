import { describe, expect, it } from "vitest";
import { SearchEngine, frontmatterEnd, type SearchHooks } from "../src/search/engine";
import type { DocInput, SearchRequest, SearchResponse } from "../src/search/types";

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86_400_000;

const doc = (path: string, content: string, ageDays = 365): DocInput => ({
	path,
	title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
	content,
	mtime: NOW - ageDays * DAY,
});

const hooks: SearchHooks = {
	now: () => 0,
	pause: () => Promise.resolve(),
	isCancelled: () => false,
};

const request = (query: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
	query,
	options: { matchCase: false, wholeWord: false, regex: false },
	folder: "",
	sort: "relevance",
	maxLines: 1000,
	now: NOW,
	...extra,
});

const search = async (docs: DocInput[], query: string, extra: Partial<SearchRequest> = {}): Promise<SearchResponse> => {
	const engine = new SearchEngine();
	engine.upsert(docs);
	const response = await engine.search(request(query, extra), hooks);
	if (response === null) {
		throw new Error("search was cancelled");
	}
	return response;
};

const filler = (words: number): string => Array.from({ length: words }, (_, index) => `word${index}`).join(" ");

describe("SearchEngine", () => {
	it("returns matching lines with columns and line numbers", async () => {
		const response = await search([doc("a.md", "first line\nsecond needle line\nneedle and needle")], "needle");
		expect(response.totalFiles).toBe(1);
		expect(response.totalMatches).toBe(3);
		const [file] = response.files;
		expect(file?.lines.map((line) => line.line)).toEqual([1, 2]);
		expect(file?.lines[0]?.ranges).toEqual([[7, 13]]);
		expect(file?.lines[1]?.ranges).toEqual([
			[0, 6],
			[11, 17],
		]);
	});

	it("handles CRLF line endings", async () => {
		const response = await search([doc("a.md", "one\r\ntwo needle\r\nthree")], "needle");
		const line = response.files[0]?.lines[0];
		expect(line?.line).toBe(1);
		expect(line?.text).toBe("two needle");
	});

	it("ranks a title match above body-only matches", async () => {
		const response = await search(
			[doc("notes/Other.md", "kubernetes kubernetes kubernetes"), doc("notes/Kubernetes.md", "intro to kubernetes")],
			"kubernetes",
		);
		expect(response.files.map((file) => file.title)).toEqual(["Kubernetes", "Other"]);
	});

	it("ranks a heading match above a passing mention", async () => {
		const body = filler(40);
		const response = await search(
			[doc("b.md", `${body}\nwe used caching once\n${body}`), doc("a.md", `${body}\n## Caching\n${body}`)],
			"caching",
		);
		expect(response.files.map((file) => file.path)).toEqual(["a.md", "b.md"]);
	});

	it("prefers more frequent matches in notes of similar length", async () => {
		const response = await search(
			[doc("one.md", `alpha ${filler(50)}`), doc("three.md", `alpha alpha alpha ${filler(48)}`)],
			"alpha",
		);
		expect(response.files[0]?.path).toBe("three.md");
	});

	it("uses recency as a gentle boost", async () => {
		const content = `topic ${filler(20)}`;
		const response = await search([doc("old.md", content, 400), doc("new.md", content, 1)], "topic");
		expect(response.files.map((file) => file.path)).toEqual(["new.md", "old.md"]);
	});

	it("sorts by path and by modification time when asked", async () => {
		const docs = [doc("b/Note 10.md", "x", 5), doc("a/Note 2.md", "x", 1), doc("b/Note 9.md", "x", 3)];
		const byPath = await search(docs, "x", { sort: "path" });
		expect(byPath.files.map((file) => file.path)).toEqual(["a/Note 2.md", "b/Note 9.md", "b/Note 10.md"]);
		const byTime = await search(docs, "x", { sort: "modified" });
		expect(byTime.files.map((file) => file.path)).toEqual(["a/Note 2.md", "b/Note 9.md", "b/Note 10.md"]);
	});

	it("limits the search to a folder", async () => {
		const response = await search(
			[doc("Projects/a.md", "x"), doc("Projects/Sub/b.md", "x"), doc("ProjectsOld/c.md", "x"), doc("d.md", "x")],
			"x",
			{ folder: "Projects" },
		);
		expect(response.files.map((file) => file.path).sort()).toEqual(["Projects/Sub/b.md", "Projects/a.md"]);
	});

	it("caps listed lines but keeps exact totals", async () => {
		const many = Array.from({ length: 30 }, () => "hit").join("\n");
		const response = await search([doc("a.md", many), doc("b.md", many)], "hit", { maxLines: 40 });
		expect(response.totalMatches).toBe(60);
		expect(response.totalFiles).toBe(2);
		expect(response.files.reduce((sum, file) => sum + file.lines.length, 0)).toBe(40);
		expect(response.truncated).toBe(true);
		expect(response.files.some((file) => file.partial)).toBe(true);
	});

	it("clips long lines around the first match", async () => {
		const line = `${"lorem ".repeat(100)}needle${" ipsum".repeat(100)}`;
		const response = await search([doc("a.md", line)], "needle");
		const match = response.files[0]?.lines[0];
		expect(match?.clippedStart).toBe(true);
		expect(match?.clippedEnd).toBe(true);
		expect(match?.text.length).toBeLessThanOrEqual(221);
		const [start, end] = match?.ranges[0] ?? [0, 0];
		const offset = match?.offset ?? 0;
		expect(match?.text.slice(start - offset, end - offset)).toBe("needle");
	});

	it("starts the snippet near a match that sits far into a medium-length line", async () => {
		const line = `${"word ".repeat(30)}needle tail`;
		const response = await search([doc("a.md", line)], "needle");
		const match = response.files[0]?.lines[0];
		expect(match?.clippedStart).toBe(true);
		expect(match?.clippedEnd).toBe(false);
		expect(match?.text.indexOf("needle")).toBeLessThanOrEqual(40);
	});

	it("drops leading indentation from snippets", async () => {
		const response = await search([doc("a.md", "\t\t- nested needle")], "needle");
		const match = response.files[0]?.lines[0];
		expect(match?.text).toBe("- nested needle");
		expect(match?.clippedStart).toBe(false);
	});

	it("applies updates and removals", async () => {
		const engine = new SearchEngine();
		engine.upsert([doc("a.md", "old text"), doc("b.md", "old text")]);
		engine.upsert([doc("a.md", "new text")]);
		engine.remove(["b.md"]);
		expect((await engine.search(request("old"), hooks))?.totalFiles).toBe(0);
		expect((await engine.search(request("new"), hooks))?.totalFiles).toBe(1);
	});

	it("stops when cancelled", async () => {
		const engine = new SearchEngine();
		engine.upsert(Array.from({ length: 50 }, (_, index) => doc(`n${index}.md`, "text")));
		let clock = 0;
		const response = await engine.search(request("text"), {
			now: () => (clock += 100),
			pause: () => Promise.resolve(),
			isCancelled: () => true,
		});
		expect(response).toBeNull();
	});

	it("rejects an invalid regular expression", async () => {
		const engine = new SearchEngine();
		await expect(
			engine.search(request("(", { options: { matchCase: false, wholeWord: false, regex: true } }), hooks),
		).rejects.toThrow();
	});
});

describe("frontmatterEnd", () => {
	it("finds the end of a frontmatter block", () => {
		const content = "---\ntags: [a]\n---\nbody";
		expect(content.slice(frontmatterEnd(content))).toBe("body");
	});

	it("returns 0 without frontmatter or when it is not closed", () => {
		expect(frontmatterEnd("body\n---\n")).toBe(0);
		expect(frontmatterEnd("---\ntags: [a]\nbody")).toBe(0);
	});
});
