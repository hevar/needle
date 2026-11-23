import workerSource from "inline-worker:./search.worker.ts";
import { SearchEngine } from "./engine";
import type { DocInput, FromWorker, SearchRequest, SearchResponse, ToWorker } from "./types";

export type ProgressListener = (scanned: number, total: number) => void;

export type SearchBackend = {
	/** Resolves to false when the backend could not start. */
	readonly ready: Promise<boolean>;
	readonly alive: boolean;
	upsert: (docs: DocInput[]) => void;
	remove: (paths: string[]) => void;
	/** Resolves to `null` when a newer search replaced this one. */
	search: (request: SearchRequest, onProgress?: ProgressListener) => Promise<SearchResponse | null>;
	dispose: () => void;
};

export class SearchTimeoutError extends Error {
	constructor() {
		super("The search took too long and was stopped.");
		this.name = "SearchTimeoutError";
	}
}

const READY_TIMEOUT_MS = 5000;
const STALL_TIMEOUT_MS = 4000;
const WATCHDOG_INTERVAL_MS = 500;

type PendingSearch = {
	id: number;
	resolve: (response: SearchResponse | null) => void;
	reject: (error: Error) => void;
	onProgress?: ProgressListener;
};

/**
 * Runs the engine in a web worker so searching never blocks the editor. A
 * watchdog terminates the worker when a search stops reporting progress, which
 * is what a catastrophically backtracking regular expression looks like.
 */
class WorkerBackend implements SearchBackend {
	readonly ready: Promise<boolean>;
	alive = true;
	private readonly worker: Worker;
	private pending: PendingSearch | null = null;
	private nextId = 1;
	private lastBeat = 0;
	private watchdog: number | null = null;
	private settleReady: (ok: boolean) => void = () => undefined;

	constructor() {
		const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
		try {
			this.worker = new Worker(url, { name: "needle-search" });
		} catch (error) {
			URL.revokeObjectURL(url);
			throw error;
		}
		this.ready = new Promise<boolean>((resolve) => {
			const timer = window.setTimeout(() => this.settleReady(false), READY_TIMEOUT_MS);
			this.settleReady = (ok) => {
				this.settleReady = () => undefined;
				window.clearTimeout(timer);
				URL.revokeObjectURL(url);
				if (!ok) {
					this.dispose();
				}
				resolve(ok);
			};
		});
		this.worker.addEventListener("message", (event: MessageEvent<FromWorker>) => this.handle(event.data));
		this.worker.addEventListener("error", (event) => {
			event.preventDefault();
			this.fail(new Error(event.message || "The search worker stopped unexpectedly."));
		});
	}

	upsert(docs: DocInput[]): void {
		this.post({ type: "upsert", docs });
	}

	remove(paths: string[]): void {
		this.post({ type: "remove", paths });
	}

	search(request: SearchRequest, onProgress?: ProgressListener): Promise<SearchResponse | null> {
		if (!this.alive) {
			return Promise.resolve(null);
		}
		this.pending?.resolve(null);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending = { id, resolve, reject, onProgress };
			this.lastBeat = performance.now();
			this.startWatchdog();
			this.post({ type: "search", id, request });
		});
	}

	dispose(): void {
		if (!this.alive) {
			return;
		}
		this.alive = false;
		this.stopWatchdog();
		this.worker.terminate();
		const pending = this.pending;
		this.pending = null;
		pending?.resolve(null);
		this.settleReady(false);
	}

	private post(message: ToWorker): void {
		if (this.alive) {
			this.worker.postMessage(message);
		}
	}

	private handle(message: FromWorker): void {
		if (message.type === "ready") {
			this.settleReady(true);
			return;
		}
		const pending = this.pending;
		if (pending === null || pending.id !== message.id) {
			return;
		}
		if (message.type === "progress") {
			this.lastBeat = performance.now();
			pending.onProgress?.(message.scanned, message.total);
			return;
		}
		this.pending = null;
		this.stopWatchdog();
		if (message.type === "result") {
			pending.resolve(message.response);
			return;
		}
		pending.reject(new Error(message.message));
	}

	private fail(error: Error): void {
		const pending = this.pending;
		this.pending = null;
		this.dispose();
		pending?.reject(error);
	}

	private startWatchdog(): void {
		if (this.watchdog !== null) {
			return;
		}
		this.watchdog = window.setInterval(() => {
			if (this.pending === null) {
				this.stopWatchdog();
				return;
			}
			if (performance.now() - this.lastBeat > STALL_TIMEOUT_MS) {
				this.fail(new SearchTimeoutError());
			}
		}, WATCHDOG_INTERVAL_MS);
	}

	private stopWatchdog(): void {
		if (this.watchdog !== null) {
			window.clearInterval(this.watchdog);
			this.watchdog = null;
		}
	}
}

/** Fallback for platforms that refuse to start the worker. Time-sliced on the main thread. */
class InlineBackend implements SearchBackend {
	readonly ready = Promise.resolve(true);
	alive = true;
	private readonly engine = new SearchEngine();
	private currentId = 0;

	upsert(docs: DocInput[]): void {
		this.engine.upsert(docs);
	}

	remove(paths: string[]): void {
		this.engine.remove(paths);
	}

	search(request: SearchRequest, onProgress?: ProgressListener): Promise<SearchResponse | null> {
		const id = ++this.currentId;
		return this.engine.search(request, {
			now: () => performance.now(),
			pause: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
			isCancelled: () => !this.alive || this.currentId !== id,
			onProgress,
		});
	}

	dispose(): void {
		this.alive = false;
		this.currentId++;
		this.engine.clear();
	}
}

export const createBackend = async (preferWorker: boolean): Promise<{ backend: SearchBackend; isWorker: boolean }> => {
	if (preferWorker) {
		try {
			const backend = new WorkerBackend();
			if (await backend.ready) {
				return { backend, isWorker: true };
			}
		} catch {
			// Fall through to the main-thread engine.
		}
	}
	return { backend: new InlineBackend(), isWorker: false };
};
