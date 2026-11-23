import type { Range } from "./types";

export type NoteCandidate = {
	names: PreparedText[];
	folder: PreparedText;
};

type PreparedText = { text: string; folded: string };

export type NoteMatch = {
	score: number;
	name: number;
	nameRanges: Range[];
	folderRanges: Range[];
};

const ASCII = /^[\x20-\x7e]*$/;
const MARKS = /\p{M}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const TOKEN_SEPARATOR = /[\s/]+/;

const NAME_SCORES = [5, 8, 10];
const FOLDER_SCORE = 3;
const FUZZY_SCORE = 1;
const EXACT_BONUS = 20;
const PREFIX_BONUS = 4;
const ALIAS_PENALTY = 1;

/**
 * Lowercases and strips accents without changing the string's length, so
 * positions in the folded text are positions in the original: "Café" → "cafe".
 */
export const fold = (text: string): string => {
	if (ASCII.test(text)) {
		return text.toLowerCase();
	}
	let folded = "";
	for (const char of text) {
		const plain = char.normalize("NFD").replace(MARKS, "").toLowerCase();
		if (plain.length === char.length) {
			folded += plain;
			continue;
		}
		const lower = char.toLowerCase();
		folded += lower.length === char.length ? lower : char;
	}
	return folded;
};

const prepare = (text: string): PreparedText => ({ text, folded: fold(text) });

export const prepareCandidate = (title: string, folder: string, aliases: readonly string[] = []): NoteCandidate => ({
	names: [title, ...aliases].map(prepare),
	folder: prepare(folder),
});

export const tokenize = (query: string): string[] => fold(query.trim()).split(TOKEN_SEPARATOR).filter((token) => token.length > 0);

const isWordStart = (text: string, index: number): boolean => {
	if (index === 0) {
		return true;
	}
	const previous = text[index - 1] ?? "";
	const current = text[index] ?? "";
	if (!WORD_CHAR.test(previous)) {
		return true;
	}
	return previous !== previous.toUpperCase() && current !== current.toLowerCase();
};

const findBest = (field: PreparedText, token: string): { index: number; quality: 0 | 1 | 2 } | null => {
	let first = -1;
	for (let index = field.folded.indexOf(token); index !== -1; index = field.folded.indexOf(token, index + 1)) {
		if (index === 0) {
			return { index, quality: 2 };
		}
		if (isWordStart(field.text, index)) {
			return { index, quality: 1 };
		}
		if (first === -1) {
			first = index;
		}
	}
	return first === -1 ? null : { index: first, quality: 0 };
};

/**
 * Finds the token's characters in order, preferring the next character right
 * after the previous one, then the start of a later word, so "dsys" lights up
 * "Design system". Scattered letters do not count: the first one must start a
 * word, and there may be at most one piece per two typed characters.
 */
const fuzzy = (field: PreparedText, token: string): Range[] | null => {
	const ranges: Range[] = [];
	let from = 0;
	for (const char of token) {
		let at = field.folded.startsWith(char, from) ? from : -1;
		for (let index = from; at === -1 && index < field.folded.length; index++) {
			if (field.folded.startsWith(char, index) && isWordStart(field.text, index)) {
				at = index;
			}
		}
		if (at === -1) {
			at = field.folded.indexOf(char, from);
		}
		if (at === -1) {
			return null;
		}
		const end = at + char.length;
		const last = ranges[ranges.length - 1];
		if (last !== undefined && last[1] === at) {
			last[1] = end;
		} else {
			ranges.push([at, end]);
		}
		from = end;
	}
	const first = ranges[0];
	if (first === undefined || !isWordStart(field.text, first[0]) || ranges.length > Math.ceil(token.length / 2)) {
		return null;
	}
	return ranges;
};

export const mergeRanges = (ranges: Range[]): Range[] => {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: Range[] = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last !== undefined && start <= last[1]) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}
	return merged;
};

const matchName = (name: PreparedText, folder: PreparedText, tokens: string[]): Omit<NoteMatch, "name"> | null => {
	let score = 0;
	const nameRanges: Range[] = [];
	const folderRanges: Range[] = [];
	for (const token of tokens) {
		const inName = findBest(name, token);
		if (inName !== null) {
			score += NAME_SCORES[inName.quality] ?? 0;
			nameRanges.push([inName.index, inName.index + token.length]);
			continue;
		}
		const inFolder = findBest(folder, token);
		if (inFolder !== null && inFolder.quality > 0) {
			score += FOLDER_SCORE;
			folderRanges.push([inFolder.index, inFolder.index + token.length]);
			continue;
		}
		const scattered = token.length > 1 ? fuzzy(name, token) : null;
		if (scattered === null) {
			return null;
		}
		score += FUZZY_SCORE / scattered.length;
		nameRanges.push(...scattered);
	}
	const phrase = tokens.join(" ");
	if (name.folded === phrase) {
		score += EXACT_BONUS;
	} else if (name.folded.startsWith(phrase)) {
		score += PREFIX_BONUS;
	}
	return { score, nameRanges: mergeRanges(nameRanges), folderRanges: mergeRanges(folderRanges) };
};

export const matchNote = (candidate: NoteCandidate, tokens: string[]): NoteMatch | null => {
	if (tokens.length === 0) {
		return null;
	}
	let best: NoteMatch | null = null;
	for (const [index, name] of candidate.names.entries()) {
		const found = matchName(name, candidate.folder, tokens);
		if (found === null) {
			continue;
		}
		const score = index === 0 ? found.score : found.score - ALIAS_PENALTY;
		if (best === null) {
			best = { ...found, score, name: index };
		} else if (best.name === 0) {
			best.score = Math.max(best.score, score);
		} else if (score > best.score) {
			best = { ...found, score, name: index };
		}
	}
	return best;
};
