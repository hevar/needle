export type SearchOptions = {
	matchCase: boolean;
	wholeWord: boolean;
	regex: boolean;
};

export type SortMode = "relevance" | "modified" | "path";

export type SearchRequest = {
	query: string;
	options: SearchOptions;
	folder: string;
	sort: SortMode;
	maxLines: number;
	now: number;
};

export type DocInput = {
	path: string;
	title: string;
	content: string;
	mtime: number;
};

/** A column range within a line, end exclusive. */
export type Range = [start: number, end: number];

export type LineMatch = {
	/** Zero-based line number. */
	line: number;
	text: string;
	offset: number;
	ranges: Range[];
	clippedStart: boolean;
	clippedEnd: boolean;
};

export type FileResult = {
	path: string;
	title: string;
	mtime: number;
	score: number;
	/** Total number of occurrences in the file, including ones not listed in `lines`. */
	matchCount: number;
	lines: LineMatch[];
	partial: boolean;
};

export type SearchResponse = {
	files: FileResult[];
	totalFiles: number;
	totalMatches: number;
	truncated: boolean;
	elapsedMs: number;
};

export type ToWorker =
	| { type: "upsert"; docs: DocInput[] }
	| { type: "remove"; paths: string[] }
	| { type: "clear" }
	| { type: "search"; id: number; request: SearchRequest }
	| { type: "cancel"; id: number };

export type FromWorker =
	| { type: "ready" }
	| { type: "progress"; id: number; scanned: number; total: number }
	| { type: "result"; id: number; response: SearchResponse }
	| { type: "error"; id: number; message: string };
