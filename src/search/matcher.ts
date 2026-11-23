import type { SearchOptions } from "./types";

export type Matcher = {
	regex: RegExp;
	wholeWord: boolean;
};

export type MatcherResult = { ok: true; matcher: Matcher } | { ok: false; error: string };

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

export const escapeRegExp = (text: string): string => text.replace(REGEX_SYNTAX, "\\$&");

const describeRegexError = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);
	const reason = message.slice(message.lastIndexOf(": ") + 1).trim();
	return reason.length > 0 ? reason : message;
};

/**
 * Builds the regular expression for a query. Plain text is escaped. A regex is
 * tried with the `u` flag first so `\p{…}` works, then without it so lenient
 * escapes such as `\-` outside a class are still accepted.
 */
export const buildMatcher = (query: string, options: SearchOptions): MatcherResult => {
	if (query.length === 0) {
		return { ok: false, error: "Empty query" };
	}
	const flags = options.matchCase ? "gm" : "gmi";
	const wholeWord = options.wholeWord;
	if (!options.regex) {
		return { ok: true, matcher: { regex: new RegExp(escapeRegExp(query), `${flags}u`), wholeWord } };
	}
	try {
		return { ok: true, matcher: { regex: new RegExp(query, `${flags}u`), wholeWord } };
	} catch {
		try {
			return { ok: true, matcher: { regex: new RegExp(query, flags), wholeWord } };
		} catch (error) {
			return { ok: false, error: describeRegexError(error) };
		}
	}
};

const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

const charAt = (text: string, index: number): string | undefined => {
	const codePoint = text.codePointAt(index);
	return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
};

const charBefore = (text: string, index: number): string | undefined => {
	if (index <= 0) {
		return undefined;
	}
	const low = text.charCodeAt(index - 1);
	if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) {
			return text.slice(index - 2, index);
		}
	}
	return text[index - 1];
};

/**
 * A match is a whole word when it is not glued to a letter, digit or underscore
 * on either side. Edges of the match that are not word characters themselves
 * (for example the `#` in `#tag`) need no boundary.
 */
export const isWholeWord = (text: string, start: number, end: number): boolean => {
	if (isWordChar(charAt(text, start)) && isWordChar(charBefore(text, start))) {
		return false;
	}
	if (isWordChar(charBefore(text, end)) && isWordChar(charAt(text, end))) {
		return false;
	}
	return true;
};

export const forEachMatch = (
	text: string,
	matcher: Matcher,
	visit: (start: number, end: number) => boolean | void,
): void => {
	const { regex } = matcher;
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (end === start || (matcher.wholeWord && !isWholeWord(text, start, end))) {
			regex.lastIndex = start + 1;
			continue;
		}
		if (visit(start, end) === false) {
			return;
		}
	}
};
