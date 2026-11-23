import { FileSystemAdapter, Platform, normalizePath, type App, type TFile } from "obsidian";
import { createBackend, type ProgressListener, type SearchBackend } from "./backends";
import type { DocInput, SearchRequest, SearchResponse } from "./types";

const READ_BATCH = 64;
/**
 * Reading a note that only exists in the cloud (iCloud with "Optimize Mac
 * Storage", OneDrive Files On-Demand) downloads it first, which takes about a
 * second and holds one of the few threads Obsidian uses for all file access.
 * Two at a time keeps the rest of Obsidian responsive.
 */
const DOWNLOAD_CONCURRENCY = 2;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IDLE_RELEASE_MS = 15 * 60 * 1000;

export type IndexSettings = {
	excludedFolders: string;
	respectExcludedFiles: boolean;
};

type IgnoreAwareMetadataCache = {
	isUserIgnored?: (path: string) => boolean;
};

export const parseFolderList = (value: string): string[] =>
	value
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
		.filter((line) => line.length > 0)
		.map((line) => normalizePath(line));

const isInFolder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

export const exclusionTest = (app: App, settings: IndexSettings): ((path: string) => boolean) => {
	const folders = parseFolderList(settings.excludedFolders);
	const cache = app.metadataCache as unknown as IgnoreAwareMetadataCache;
	const respectIgnored = settings.respectExcludedFiles && typeof cache.isUserIgnored === "function";
	return (path) => folders.some((folder) => isInFolder(path, folder)) || (respectIgnored && cache.isUserIgnored?.(path) === true);
};

/**
 * Keeps the search backend in step with the vault. Before every search it
 * compares each note's modification time with what was indexed and only reads
 * what changed, so there are no event listeners to keep alive between searches.
 * Notes that have to be downloaded first are fetched in the background, so a
 * search never waits for them. The index is released after a period without
 * use to give the memory back.
 */
export class VaultIndex {
	onIndexProgress: ProgressListener | null = null;
	onDownloadProgress: ((pending: number) => void) | null = null;
	private backend: SearchBackend | null = null;
	private preferWorker = true;
	private readonly indexed = new Map<string, number>();
	private readonly downloadQueue = new Map<string, TFile>();
	private readonly downloading = new Set<string>();
	private downloaders = 0;
	private syncing: Promise<void> | null = null;
	private releaseTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly settings: () => IndexSettings,
	) {}

	get pendingDownloads(): number {
		return this.downloadQueue.size + this.downloading.size;
	}

	async sync(): Promise<void> {
		while (this.syncing !== null) {
			await this.syncing;
		}
		this.syncing = this.reconcile().finally(() => {
			this.syncing = null;
		});
		await this.syncing;
	}

	async search(request: SearchRequest, onProgress?: ProgressListener): Promise<SearchResponse | null> {
		await this.sync();
		const backend = this.backend;
		if (backend === null || !backend.alive) {
			return null;
		}
		return backend.search(request, onProgress);
	}

	acquire(): void {
		if (this.releaseTimer !== null) {
			window.clearTimeout(this.releaseTimer);
			this.releaseTimer = null;
		}
	}

	release(): void {
		this.acquire();
		this.releaseTimer = window.setTimeout(() => {
			this.releaseTimer = null;
			this.dispose();
		}, IDLE_RELEASE_MS);
	}

	dispose(): void {
		this.acquire();
		this.backend?.dispose();
		this.backend = null;
		this.indexed.clear();
		this.downloadQueue.clear();
		this.downloading.clear();
	}

	private async ensureBackend(): Promise<SearchBackend> {
		if (this.backend?.alive) {
			return this.backend;
		}
		this.indexed.clear();
		this.downloadQueue.clear();
		this.downloading.clear();
		const { backend, isWorker } = await createBackend(this.preferWorker);
		this.preferWorker = isWorker;
		this.backend = backend;
		return backend;
	}

	private async reconcile(): Promise<void> {
		const backend = await this.ensureBackend();
		const files = this.collectFiles();
		const seen = new Set<string>();
		const stale: TFile[] = [];
		for (const file of files) {
			seen.add(file.path);
			const waiting = this.downloadQueue.has(file.path) || this.downloading.has(file.path);
			if (!waiting && this.indexed.get(file.path) !== file.stat.mtime) {
				stale.push(file);
			}
		}
		for (const path of this.downloadQueue.keys()) {
			if (!seen.has(path)) {
				this.downloadQueue.delete(path);
			}
		}
		const removed = Array.from(this.indexed.keys()).filter((path) => !seen.has(path));
		if (removed.length > 0) {
			backend.remove(removed);
			for (const path of removed) {
				this.indexed.delete(path);
			}
		}

		const remote = await this.findCloudOnly(stale);
		const local = stale.filter((file) => !remote.has(file.path));
		if (local.length > 0) {
			this.onIndexProgress?.(0, local.length);
		}
		for (let start = 0; start < local.length; start += READ_BATCH) {
			const batch = local.slice(start, start + READ_BATCH);
			const docs = (await Promise.all(batch.map((file) => this.read(file)))).filter(
				(doc): doc is DocInput => doc !== null,
			);
			if (this.backend !== backend || !backend.alive) {
				return;
			}
			backend.upsert(docs);
			for (const doc of docs) {
				this.indexed.set(doc.path, doc.mtime);
			}
			this.onIndexProgress?.(Math.min(start + READ_BATCH, local.length), local.length);
		}

		if (this.backend !== backend || !backend.alive) {
			return;
		}
		if (remote.size > 0) {
			for (const file of stale) {
				if (remote.has(file.path)) {
					this.downloadQueue.set(file.path, file);
				}
			}
			this.onDownloadProgress?.(this.pendingDownloads);
		}
		const idle = Math.min(DOWNLOAD_CONCURRENCY - this.downloaders, this.downloadQueue.size);
		for (let started = 0; started < idle; started++) {
			void this.download(backend);
		}
	}

	private async download(backend: SearchBackend): Promise<void> {
		this.downloaders++;
		try {
			for (const [path, file] of this.downloadQueue) {
				if (this.backend !== backend || !backend.alive) {
					return;
				}
				this.downloadQueue.delete(path);
				this.downloading.add(path);
				const doc = await this.read(file);
				if (this.backend !== backend || !backend.alive) {
					return;
				}
				this.downloading.delete(path);
				if (doc !== null) {
					backend.upsert([doc]);
					this.indexed.set(doc.path, doc.mtime);
				}
				this.onDownloadProgress?.(this.pendingDownloads);
			}
		} finally {
			this.downloaders--;
		}
	}

	/**
	 * Notes evicted by a cloud sync client still report their size, but no
	 * disk blocks back them until they are downloaded again.
	 */
	private async findCloudOnly(files: TFile[]): Promise<Set<string>> {
		const adapter = this.app.vault.adapter;
		if (files.length === 0 || !Platform.isDesktopApp || Platform.isMobile || !(adapter instanceof FileSystemAdapter)) {
			return new Set();
		}
		try {
			const { stat } = require("fs/promises") as typeof import("fs/promises");
			const base = adapter.getBasePath();
			const flags = await Promise.all(
				files.map((file) =>
					stat(`${base}/${file.path}`).then(
						(stats) => stats.blocks === 0 && stats.size > 0,
						() => false,
					),
				),
			);
			return new Set(files.filter((_, index) => flags[index]).map((file) => file.path));
		} catch {
			return new Set();
		}
	}

	private async read(file: TFile): Promise<DocInput | null> {
		const mtime = file.stat.mtime;
		try {
			const content = await this.app.vault.cachedRead(file);
			return { path: file.path, title: file.basename, content, mtime };
		} catch {
			return null;
		}
	}

	private collectFiles(): TFile[] {
		const isExcluded = exclusionTest(this.app, this.settings());
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.stat.size <= MAX_FILE_BYTES && !isExcluded(file.path));
	}
}
