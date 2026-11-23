import { normalizePath, type App, type TFile } from "obsidian";
import { createBackend, type ProgressListener, type SearchBackend } from "./backends";
import type { DocInput, SearchRequest, SearchResponse } from "./types";

const UPSERT_BATCH = 64;
/**
 * Reading a note that only exists in the cloud (iCloud with "Optimize Mac
 * Storage", OneDrive Files On-Demand) downloads it first, which takes about a
 * second and holds one of the few threads Obsidian uses for all file access.
 * Two at a time keeps the rest of Obsidian responsive, and notes on disk load
 * just as fast as with more.
 */
const READ_CONCURRENCY = 2;
/** Notes on disk take a few milliseconds, so a read this slow is most likely a download. */
const SLOW_READ_MS = 150;
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
 * A search waits for those reads until one turns out slow. The remaining notes
 * then load in the background, so a search never waits for downloads. The
 * index is released after a period without use to give the memory back.
 */
export class VaultIndex {
	onIndexProgress: ProgressListener | null = null;
	onBackgroundProgress: ((pending: number) => void) | null = null;
	private backend: SearchBackend | null = null;
	private preferWorker = true;
	private readonly indexed = new Map<string, number>();
	private readonly queue = new Map<string, TFile>();
	private readonly reading = new Set<string>();
	private unsent: DocInput[] = [];
	private readers = 0;
	private inBackground = false;
	private indexDone = 0;
	private indexTotal = 0;
	private stopWaiting: (() => void) | null = null;
	private syncing: Promise<void> | null = null;
	private releaseTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly settings: () => IndexSettings,
	) {}

	get pendingNotes(): number {
		return this.inBackground ? this.queue.size + this.reading.size : 0;
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
		this.clearQueue();
	}

	private async ensureBackend(): Promise<SearchBackend> {
		if (this.backend?.alive) {
			return this.backend;
		}
		this.indexed.clear();
		this.clearQueue();
		const { backend, isWorker } = await createBackend(this.preferWorker);
		this.preferWorker = isWorker;
		this.backend = backend;
		return backend;
	}

	private clearQueue(): void {
		this.queue.clear();
		this.reading.clear();
		this.unsent = [];
		this.inBackground = false;
		this.finishWaiting();
	}

	private finishWaiting(): void {
		this.stopWaiting?.();
		this.stopWaiting = null;
	}

	private async reconcile(): Promise<void> {
		const backend = await this.ensureBackend();
		const files = this.collectFiles();
		const seen = new Set<string>();
		const stale: TFile[] = [];
		for (const file of files) {
			seen.add(file.path);
			const waiting = this.queue.has(file.path) || this.reading.has(file.path);
			if (!waiting && this.indexed.get(file.path) !== file.stat.mtime) {
				stale.push(file);
			}
		}
		for (const path of this.queue.keys()) {
			if (!seen.has(path)) {
				this.queue.delete(path);
			}
		}
		const removed = Array.from(this.indexed.keys()).filter((path) => !seen.has(path));
		if (removed.length > 0) {
			backend.remove(removed);
			for (const path of removed) {
				this.indexed.delete(path);
			}
		}

		if (stale.length > 0) {
			// Sync clients evict what has not been touched for a while, so recent notes are likely on disk.
			stale.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const queued = [...stale, ...this.queue.values()];
			this.queue.clear();
			for (const file of queued) {
				this.queue.set(file.path, file);
			}
			if (!this.inBackground) {
				this.indexDone = 0;
				this.indexTotal = this.queue.size + this.reading.size;
				this.onIndexProgress?.(0, this.indexTotal);
			}
		}
		const idle = Math.min(READ_CONCURRENCY - this.readers, this.queue.size);
		for (let started = 0; started < idle; started++) {
			void this.readQueued();
		}
		if (this.inBackground || this.queue.size + this.reading.size === 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.stopWaiting = resolve;
		});
	}

	private async readQueued(): Promise<void> {
		this.readers++;
		try {
			for (let file = this.nextQueued(); file !== null; file = this.nextQueued()) {
				this.reading.add(file.path);
				const slowTimer = window.setTimeout(() => this.moveToBackground(), SLOW_READ_MS);
				const doc = await this.read(file);
				window.clearTimeout(slowTimer);
				this.reading.delete(file.path);
				if (doc !== null) {
					this.unsent.push(doc);
				}
				this.afterRead();
			}
		} finally {
			this.readers--;
			if (this.readers === 0) {
				this.finishWaiting();
			}
		}
	}

	private nextQueued(): TFile | null {
		if (!this.backend?.alive) {
			return null;
		}
		const next = this.queue.values().next();
		if (next.done) {
			return null;
		}
		this.queue.delete(next.value.path);
		return next.value;
	}

	private afterRead(): void {
		const drained = this.queue.size === 0 && this.reading.size === 0;
		if (this.inBackground || drained || this.unsent.length >= UPSERT_BATCH) {
			this.flush();
		}
		if (this.inBackground) {
			if (drained) {
				this.inBackground = false;
			}
			this.onBackgroundProgress?.(this.pendingNotes);
			return;
		}
		this.indexDone++;
		if (drained || this.indexDone % UPSERT_BATCH === 0) {
			this.onIndexProgress?.(this.indexDone, this.indexTotal);
		}
		if (drained) {
			this.finishWaiting();
		}
	}

	private moveToBackground(): void {
		if (this.inBackground || this.queue.size + this.reading.size === 0) {
			return;
		}
		this.inBackground = true;
		this.flush();
		this.onBackgroundProgress?.(this.pendingNotes);
		this.finishWaiting();
	}

	private flush(): void {
		if (this.unsent.length === 0) {
			return;
		}
		const docs = this.unsent;
		this.unsent = [];
		if (!this.backend?.alive) {
			return;
		}
		this.backend.upsert(docs);
		for (const doc of docs) {
			this.indexed.set(doc.path, doc.mtime);
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
