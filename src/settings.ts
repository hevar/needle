import { PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type { SortMode } from "./search/types";
import { DEFAULT_RESULTS_SHARE, clampShare, type ModalSize } from "./ui/layout";
import type { PreviewMode } from "./ui/previewPane";

export type NeedleSettings = {
	matchCase: boolean;
	wholeWord: boolean;
	regex: boolean;
	sort: SortMode;
	showPreview: boolean;
	previewMode: PreviewMode;
	useSelection: boolean;
	maxResults: number;
	excludedFolders: string;
	respectExcludedFiles: boolean;
	modalSize: ModalSize | null;
	resultsShare: number;
};

export const DEFAULT_SETTINGS: NeedleSettings = {
	matchCase: false,
	wholeWord: false,
	regex: false,
	sort: "relevance",
	showPreview: true,
	previewMode: "source",
	useSelection: true,
	maxResults: 1000,
	excludedFolders: "",
	respectExcludedFiles: true,
	modalSize: null,
	resultsShare: DEFAULT_RESULTS_SHARE,
};

export const MIN_RESULTS = 100;
export const MAX_RESULTS = 10000;

const SORT_MODES: SortMode[] = ["relevance", "modified", "path"];

const sanitizeSize = (stored: unknown): ModalSize | null => {
	if (typeof stored !== "object" || stored === null) {
		return null;
	}
	const { width, height } = stored as Partial<Record<keyof ModalSize, unknown>>;
	if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width + height)) {
		return null;
	}
	return { width: Math.round(width), height: Math.round(height) };
};

export const sanitizeSettings = (stored: unknown): NeedleSettings => {
	const settings = { ...DEFAULT_SETTINGS };
	if (typeof stored !== "object" || stored === null) {
		return settings;
	}
	const data = stored as Partial<Record<keyof NeedleSettings, unknown>>;
	for (const key of ["matchCase", "wholeWord", "regex", "showPreview", "useSelection", "respectExcludedFiles"] as const) {
		const value = data[key];
		if (typeof value === "boolean") {
			settings[key] = value;
		}
	}
	if (typeof data.sort === "string" && SORT_MODES.includes(data.sort as SortMode)) {
		settings.sort = data.sort as SortMode;
	}
	if (data.previewMode === "source" || data.previewMode === "reading") {
		settings.previewMode = data.previewMode;
	}
	if (typeof data.maxResults === "number" && Number.isFinite(data.maxResults)) {
		settings.maxResults = Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.round(data.maxResults)));
	}
	if (typeof data.excludedFolders === "string") {
		settings.excludedFolders = data.excludedFolders;
	}
	settings.modalSize = sanitizeSize(data.modalSize);
	if (typeof data.resultsShare === "number" && Number.isFinite(data.resultsShare)) {
		settings.resultsShare = clampShare(data.resultsShare);
	}
	return settings;
};

export class NeedleSettingTab extends PluginSettingTab {
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				items: [
					{
						name: "Start with selected text",
						desc: "When text is selected in the editor, search for it right away.",
						control: { type: "toggle", key: "useSelection", defaultValue: DEFAULT_SETTINGS.useSelection },
					},
					{
						name: "Show preview",
						desc: "Show the note around the selected match below the results. Hidden on phones.",
						control: { type: "toggle", key: "showPreview", defaultValue: DEFAULT_SETTINGS.showPreview },
					},
					{
						name: "Result limit",
						desc: `Maximum number of matching lines to list, from ${MIN_RESULTS} to ${MAX_RESULTS}. Match counts always cover every note.`,
						control: {
							type: "number",
							key: "maxResults",
							defaultValue: DEFAULT_SETTINGS.maxResults,
							min: MIN_RESULTS,
							max: MAX_RESULTS,
							step: 100,
							validate: (value) =>
								Number.isFinite(value) && value >= MIN_RESULTS && value <= MAX_RESULTS
									? undefined
									: `Enter a number from ${MIN_RESULTS} to ${MAX_RESULTS}.`,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Excluded notes",
				items: [
					{
						name: "Respect excluded files",
						desc: "Skip the files and folders listed under Files and links → Excluded files.",
						control: {
							type: "toggle",
							key: "respectExcludedFiles",
							defaultValue: DEFAULT_SETTINGS.respectExcludedFiles,
						},
					},
					{
						name: "Excluded folders",
						desc: "Folders to leave out of every search, one path per line.",
						control: {
							type: "textarea",
							key: "excludedFolders",
							defaultValue: DEFAULT_SETTINGS.excludedFolders,
							placeholder: "Archive\nTemplates",
							rows: 4,
						},
					},
				],
			},
		];
	}
}
