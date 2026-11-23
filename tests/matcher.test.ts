import { describe, expect, it } from "vitest";
import { buildMatcher, escapeRegExp, forEachMatch, type Matcher } from "../src/search/matcher";
import type { SearchOptions } from "../src/search/types";

const plain: SearchOptions = { matchCase: false, wholeWord: false, regex: false };

const matcherFor = (query: string, options: Partial<SearchOptions> = {}): Matcher => {
	const result = buildMatcher(query, { ...plain, ...options });
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result.matcher;
};

const matches = (text: string, matcher: Matcher): string[] => {
	const found: string[] = [];
	forEachMatch(text, matcher, (start, end) => {
		found.push(text.slice(start, end));
	});
	return found;
};

describe("buildMatcher", () => {
	it("treats plain text literally", () => {
		expect(matches("a.b axb (x) [y]", matcherFor("a.b"))).toEqual(["a.b"]);
		expect(matches("call fn(x) here", matcherFor("fn(x)"))).toEqual(["fn(x)"]);
		expect(matches("price $5 and $50", matcherFor("$5"))).toEqual(["$5", "$5"]);
	});

	it("ignores case unless match case is on", () => {
		expect(matches("Const const CONST", matcherFor("const"))).toHaveLength(3);
		expect(matches("Const const CONST", matcherFor("const", { matchCase: true }))).toEqual(["const"]);
	});

	it("folds case for non-ASCII letters", () => {
		expect(matches("Ärger ärger", matcherFor("ärger"))).toHaveLength(2);
	});

	it("reports invalid regular expressions instead of throwing", () => {
		const result = buildMatcher("(unclosed", { ...plain, regex: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.length).toBeGreaterThan(0);
		}
	});

	it("accepts Unicode property escapes and lenient escapes", () => {
		expect(matches("café 42", matcherFor("\\p{L}+", { regex: true }))).toEqual(["café"]);
		expect(matches("a-b", matcherFor("a\\-b", { regex: true }))).toEqual(["a-b"]);
	});

	it("anchors ^ and $ to lines", () => {
		const text = "todo first\nnot todo\ntodo again";
		expect(matches(text, matcherFor("^todo", { regex: true }))).toHaveLength(2);
	});

	it("skips empty matches without looping forever", () => {
		expect(matches("abc", matcherFor("x*", { regex: true }))).toEqual([]);
		expect(matches("aa b", matcherFor("a*", { regex: true }))).toEqual(["aa"]);
	});
});

describe("whole word", () => {
	it("requires word boundaries around word characters", () => {
		const matcher = matcherFor("cat", { wholeWord: true });
		expect(matches("cat concat cats cat_ (cat) cat.", matcher)).toEqual(["cat", "cat", "cat"]);
	});

	it("treats non-ASCII letters as word characters", () => {
		const matcher = matcherFor("bar", { wholeWord: true });
		expect(matches("bär barß bar", matcher)).toEqual(["bar"]);
		expect(matches("日本語 本", matcherFor("本", { wholeWord: true }))).toEqual(["本"]);
	});

	it("does not demand a boundary next to punctuation in the query", () => {
		expect(matches("x #tag #tags", matcherFor("#tag", { wholeWord: true }))).toEqual(["#tag"]);
	});

	it("retries after a rejected overlapping match", () => {
		expect(matches("baaa aa", matcherFor("a+", { regex: true, wholeWord: true }))).toEqual(["aa"]);
	});
});

describe("escapeRegExp", () => {
	it("escapes every syntax character", () => {
		const special = ".*+?^${}()|[]\\";
		expect(new RegExp(escapeRegExp(special), "u").test(special)).toBe(true);
	});
});
