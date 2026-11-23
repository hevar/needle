import { buildMatcher, forEachMatch, type Matcher } from "./matcher";
import type { DocInput, FileResult, LineMatch, Range, SearchRequest, SearchResponse } from "./types";

export type SearchHooks = {
	now: () => number;
	pause: () => Promise<void>;
	isCancelled: () => boolean;
	onProgress?: (scanned: number, total: number) => void;
};

type Doc = {
	path: string;
	title: string;
	content: string;
	mtime: number;
	bodyStart: number;
	lineStarts: Uint32Array | null;
};

type Hit = {
	doc: Doc;
	count: number;
	/** Flat list of match offsets: start, end, start, end, … */
	offsets: number[];
	headings: number;
	frontmatter: number;
	score: number;
};

type PendingLine = {
	line: number;
	start: number;
	end: number;
	ranges: Range[];
};

const SLICE_MS = 12;
const DAY_MS = 86_400_000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_EXACT_BOOST = 3;
const TITLE_PARTIAL_BOOST = 1.5;
const HEADING_BOOST = 1;
const EXTRA_HEADING_BOOST = 0.25;
const FRONTMATTER_BOOST = 0.5;
const RECENCY_BOOST = 0.5;
const RECENCY_HALF_LIFE_DAYS = 30;
const SNIPPET_LENGTH = 220;
const SNIPPET_CONTEXT = 40;
const MAX_RANGES_PER_LINE = 50;
const HEADING_AT = /#{1,6}[ \t]/y;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

const isBlank = (code: number): boolean => code === 32 || code === 9;

export const frontmatterEnd = (content: string): number => {
	const firstBreak = content.indexOf("\n");
	if (firstBreak === -1 || content.slice(0, firstBreak).trimEnd() !== "---") {
		return 0;
	}
	let position = firstBreak + 1;
	while (position < content.length) {
		const next = content.indexOf("\n", position);
		const lineEnd = next === -1 ? content.length : next;
		if (content.slice(position, lineEnd).trimEnd() === "---") {
			return next === -1 ? content.length : next + 1;
		}
		if (next === -1) {
			return 0;
		}
		position = next + 1;
	}
	return 0;
};

const computeLineStarts = (content: string): Uint32Array => {
	let count = 1;
	for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
		count++;
	}
	const starts = new Uint32Array(count);
	let line = 1;
	for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
		starts[line++] = index + 1;
	}
	return starts;
};

const isHeadingAt = (content: string, lineStart: number): boolean => {
	HEADING_AT.lastIndex = lineStart;
	return HEADING_AT.test(content);
};

const titleMatch = (title: string, matcher: Matcher): 0 | 1 | 2 => {
	let result: 0 | 1 | 2 = 0;
	forEachMatch(title, matcher, (start, end) => {
		if (start === 0 && end === title.length) {
			result = 2;
			return false;
		}
		result = 1;
	});
	return result;
};

const byPath = (a: Hit, b: Hit): number => collator.compare(a.doc.path, b.doc.path);

const compareHits = (sort: SearchRequest["sort"]): ((a: Hit, b: Hit) => number) => {
	if (sort === "path") {
		return byPath;
	}
	if (sort === "modified") {
		return (a, b) => b.doc.mtime - a.doc.mtime || byPath(a, b);
	}
	return (a, b) => b.score - a.score || b.doc.mtime - a.doc.mtime || byPath(a, b);
};

const toLineMatch = (content: string, pending: PendingLine): LineMatch => {
	const raw = content.slice(pending.start, pending.end);
	const firstStart = pending.ranges[0]?.[0] ?? 0;
	let from = 0;
	while (from < firstStart && isBlank(raw.charCodeAt(from))) {
		from++;
	}
	const indent = from;
	if (firstStart - from > SNIPPET_CONTEXT) {
		from = firstStart - SNIPPET_CONTEXT;
		const space = raw.indexOf(" ", from);
		if (space !== -1 && space < firstStart && space - from < 16) {
			from = space + 1;
		}
		if (isLowSurrogate(raw.charCodeAt(from))) {
			from++;
		}
	}
	let to = Math.min(raw.length, from + SNIPPET_LENGTH);
	if (to < raw.length && isLowSurrogate(raw.charCodeAt(to))) {
		to++;
	}
	return {
		line: pending.line,
		text: raw.slice(from, to),
		offset: from,
		ranges: pending.ranges,
		clippedStart: from > indent,
		clippedEnd: to < raw.length,
	};
};

/**
 * Holds the text of every indexed note and answers queries against it. Pure
 * logic with no Obsidian or DOM dependencies, so it runs in a web worker and,
 * as a fallback, on the main thread.
 */
export class SearchEngine {
	private readonly docs = new Map<string, Doc>();
	private totalLength = 0;

	get size(): number {
		return this.docs.size;
	}

	upsert(inputs: DocInput[]): void {
		for (const input of inputs) {
			const previous = this.docs.get(input.path);
			if (previous) {
				this.totalLength -= previous.content.length;
			}
			this.docs.set(input.path, {
				path: input.path,
				title: input.title,
				content: input.content,
				mtime: input.mtime,
				bodyStart: frontmatterEnd(input.content),
				lineStarts: null,
			});
			this.totalLength += input.content.length;
		}
	}

	remove(paths: string[]): void {
		for (const path of paths) {
			const previous = this.docs.get(path);
			if (previous) {
				this.totalLength -= previous.content.length;
				this.docs.delete(path);
			}
		}
	}

	clear(): void {
		this.docs.clear();
		this.totalLength = 0;
	}

	/** Resolves to `null` when the search was cancelled. */
	async search(request: SearchRequest, hooks: SearchHooks): Promise<SearchResponse | null> {
		const started = hooks.now();
		const built = buildMatcher(request.query, request.options);
		if (!built.ok) {
			throw new Error(built.error);
		}
		const matcher = built.matcher;
		const candidates = this.candidates(request.folder);
		const maxLines = Math.max(1, Math.floor(request.maxLines));
		const offsetCap = maxLines * 4;
		const hits: Hit[] = [];
		let totalMatches = 0;
		let sliceStart = hooks.now();
		hooks.onProgress?.(0, candidates.length);

		for (let index = 0; index < candidates.length; index++) {
			const doc = candidates[index];
			if (doc) {
				const hit = this.scan(doc, matcher, offsetCap);
				if (hit) {
					hits.push(hit);
					totalMatches += hit.count;
				}
			}
			if (hooks.now() - sliceStart >= SLICE_MS) {
				hooks.onProgress?.(index + 1, candidates.length);
				await hooks.pause();
				if (hooks.isCancelled()) {
					return null;
				}
				sliceStart = hooks.now();
			}
		}
		if (hooks.isCancelled()) {
			return null;
		}

		this.score(hits, matcher, request.now);
		hits.sort(compareHits(request.sort));
		const { files, truncated } = this.materialize(hits, maxLines);
		return {
			files,
			totalFiles: hits.length,
			totalMatches,
			truncated,
			elapsedMs: hooks.now() - started,
		};
	}

	private candidates(folder: string): Doc[] {
		const docs = Array.from(this.docs.values());
		if (folder === "") {
			return docs;
		}
		const prefix = `${folder}/`;
		return docs.filter((doc) => doc.path.startsWith(prefix));
	}

	private scan(doc: Doc, matcher: Matcher, offsetCap: number): Hit | null {
		const { content, bodyStart } = doc;
		const offsets: number[] = [];
		let count = 0;
		let headings = 0;
		let frontmatter = 0;
		let lastHeading = -1;
		forEachMatch(content, matcher, (start, end) => {
			count++;
			if (offsets.length >= offsetCap) {
				return;
			}
			offsets.push(start, end);
			if (start < bodyStart) {
				frontmatter++;
				return;
			}
			const lineStart = start === 0 ? 0 : content.lastIndexOf("\n", start - 1) + 1;
			if (lineStart !== lastHeading && isHeadingAt(content, lineStart)) {
				headings++;
				lastHeading = lineStart;
			}
		});
		if (count === 0) {
			return null;
		}
		return { doc, count, offsets, headings, frontmatter, score: 0 };
	}

	/**
	 * Relevance: BM25 term-frequency saturation with document-length
	 * normalisation, plus boosts for a match in the note title, in headings,
	 * in frontmatter, and for recently modified notes.
	 */
	private score(hits: Hit[], matcher: Matcher, now: number): void {
		const averageLength = this.docs.size > 0 ? Math.max(1, this.totalLength / this.docs.size) : 1;
		for (const hit of hits) {
			const length = Math.max(1, hit.doc.content.length);
			const norm = 1 - BM25_B + BM25_B * (length / averageLength);
			let score = (hit.count * (BM25_K1 + 1)) / (hit.count + BM25_K1 * norm);
			const title = titleMatch(hit.doc.title, matcher);
			if (title === 2) {
				score += TITLE_EXACT_BOOST;
			} else if (title === 1) {
				score += TITLE_PARTIAL_BOOST;
			}
			if (hit.headings > 0) {
				score += HEADING_BOOST + EXTRA_HEADING_BOOST * Math.min(hit.headings - 1, 4);
			}
			if (hit.frontmatter > 0) {
				score += FRONTMATTER_BOOST;
			}
			const ageDays = Math.max(0, (now - hit.doc.mtime) / DAY_MS);
			score += RECENCY_BOOST * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
			hit.score = score;
		}
	}

	private materialize(hits: Hit[], maxLines: number): { files: FileResult[]; truncated: boolean } {
		const files: FileResult[] = [];
		let budget = maxLines;
		let truncated = false;
		for (const hit of hits) {
			if (budget <= 0) {
				truncated = true;
				break;
			}
			const { lines, cut } = this.collectLines(hit, budget);
			budget -= lines.length;
			const partial = cut || hit.count * 2 > hit.offsets.length;
			truncated ||= partial;
			files.push({
				path: hit.doc.path,
				title: hit.doc.title,
				mtime: hit.doc.mtime,
				score: hit.score,
				matchCount: hit.count,
				lines,
				partial,
			});
		}
		return { files, truncated };
	}

	private collectLines(hit: Hit, limit: number): { lines: LineMatch[]; cut: boolean } {
		const { doc, offsets } = hit;
		const { content } = doc;
		const starts = (doc.lineStarts ??= computeLineStarts(content));
		const lines: LineMatch[] = [];
		let lineIndex = 0;
		let pending: PendingLine | null = null;

		for (let index = 0; index < offsets.length; index += 2) {
			const start = offsets[index] ?? 0;
			const end = offsets[index + 1] ?? start;
			while (lineIndex + 1 < starts.length && (starts[lineIndex + 1] ?? Infinity) <= start) {
				lineIndex++;
			}
			if (pending === null || pending.line !== lineIndex) {
				if (pending !== null) {
					lines.push(toLineMatch(content, pending));
					if (lines.length >= limit) {
						return { lines, cut: true };
					}
				}
				const lineStart: number = starts[lineIndex] ?? 0;
				let lineEnd: number = lineIndex + 1 < starts.length ? (starts[lineIndex + 1] ?? content.length) - 1 : content.length;
				if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) {
					lineEnd--;
				}
				pending = { line: lineIndex, start: lineStart, end: lineEnd, ranges: [] };
			}
			if (pending.ranges.length < MAX_RANGES_PER_LINE) {
				const from = Math.min(start, pending.end) - pending.start;
				const to = Math.min(end, pending.end) - pending.start;
				pending.ranges.push([from, to]);
			}
		}
		if (pending !== null) {
			lines.push(toLineMatch(content, pending));
		}
		return { lines, cut: false };
	}
}
