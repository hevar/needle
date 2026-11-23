import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInput } from "../src/search/types";
import { VaultIndex } from "../src/search/vaultIndex";

const { upserted } = vi.hoisted(() => ({ upserted: [] as DocInput[] }));

vi.mock("obsidian", () => ({ normalizePath: (path: string) => path }));
vi.mock("../src/search/backends", () => ({
	createBackend: () =>
		Promise.resolve({
			isWorker: true,
			backend: {
				ready: Promise.resolve(true),
				alive: true,
				upsert: (docs: DocInput[]) => upserted.push(...docs),
				remove: () => undefined,
				search: () => Promise.resolve(null),
				dispose: () => undefined,
			},
		}),
}));

const SLOW_MS = 150;
const DOWNLOAD_MS = 1000;

const note = (path: string, mtime = 1): TFile =>
	({ path, basename: path.replace(/\.md$/, ""), stat: { mtime, size: 10 } }) as unknown as TFile;

const notes = (count: number): TFile[] => Array.from({ length: count }, (_, index) => note(`${index}.md`));

const indexFor = (files: () => TFile[], cloud: Set<string>, onRead?: (active: number, path: string) => void): VaultIndex => {
	let active = 0;
	const cachedRead = async (file: TFile): Promise<string> => {
		active++;
		onRead?.(active, file.path);
		if (cloud.has(file.path)) {
			await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_MS));
			cloud.delete(file.path);
		}
		active--;
		return `text of ${file.path}`;
	};
	const app = { vault: { getMarkdownFiles: files, cachedRead }, metadataCache: {} } as unknown as App;
	return new VaultIndex(app, () => ({ excludedFolders: "", respectExcludedFiles: false }));
};

const indexedPaths = (): string[] => upserted.map((doc) => doc.path).sort();

describe("VaultIndex", () => {
	beforeEach(() => {
		upserted.length = 0;
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("waits for every note when all of them are on disk", async () => {
		const files = notes(200);
		const index = indexFor(() => files, new Set());
		await index.sync();
		expect(upserted).toHaveLength(200);
		expect(index.pendingNotes).toBe(0);
	});

	it("stops waiting when a read is slow and finishes in the background", async () => {
		const files = notes(6);
		const index = indexFor(() => files, new Set(["2.md", "3.md"]));
		const progress: number[] = [];
		index.onBackgroundProgress = (pending) => progress.push(pending);
		let synced = false;
		void index.sync().then(() => {
			synced = true;
		});
		await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
		expect(synced).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(synced).toBe(true);
		expect(index.pendingNotes).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(DOWNLOAD_MS * 2);
		expect(indexedPaths()).toEqual(files.map((file) => file.path).sort());
		expect(index.pendingNotes).toBe(0);
		expect(progress[progress.length - 1]).toBe(0);
	});

	it("never reads more than two notes at once", async () => {
		const files = notes(12);
		let highest = 0;
		const index = indexFor(() => files, new Set(files.map((file) => file.path)), (active) => {
			highest = Math.max(highest, active);
		});
		void index.sync();
		await vi.advanceTimersByTimeAsync(DOWNLOAD_MS * 8);
		expect(highest).toBe(2);
		expect(upserted).toHaveLength(12);
	});

	it("reads an edited note before the notes still waiting to download", async () => {
		let files = notes(6);
		const order: string[] = [];
		const cloud = new Set(["1.md", "2.md", "3.md", "4.md", "5.md"]);
		const index = indexFor(() => files, cloud, (_, path) => order.push(path));
		void index.sync();
		await vi.advanceTimersByTimeAsync(SLOW_MS);
		expect(order).toEqual(["0.md", "1.md", "2.md"]);
		files = files.map((file) => (file.path === "0.md" ? note("0.md", 2) : file));
		await index.sync();
		await vi.advanceTimersByTimeAsync(DOWNLOAD_MS);
		expect(order.slice(3, 5)).toEqual(["0.md", "3.md"]);
	});

	it("reads the most recently modified notes first", async () => {
		const files = [note("old.md", 1), note("newest.md", 3), note("middle.md", 2)];
		const order: string[] = [];
		const index = indexFor(() => files, new Set(), (_, path) => order.push(path));
		await index.sync();
		expect(order).toEqual(["newest.md", "middle.md", "old.md"]);
	});
});
