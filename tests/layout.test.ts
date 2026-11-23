import { describe, expect, it } from "vitest";
import {
	MAX_RESULTS_SHARE,
	MIN_MODAL_HEIGHT,
	MIN_MODAL_WIDTH,
	MIN_RESULTS_SHARE,
	clampShare,
	resizeCentered,
} from "../src/ui/layout";

const start = { width: 800, height: 600 };
const bounds = { width: 1400, height: 1000 };

describe("resizeCentered", () => {
	it("grows by twice the drag so the dragged edge follows the pointer", () => {
		expect(resizeCentered(start, "e", 50, 0, bounds)).toEqual({ width: 900, height: 600 });
		expect(resizeCentered(start, "w", -50, 0, bounds)).toEqual({ width: 900, height: 600 });
		expect(resizeCentered(start, "s", 0, 30, bounds)).toEqual({ width: 800, height: 660 });
		expect(resizeCentered(start, "n", 0, -30, bounds)).toEqual({ width: 800, height: 660 });
	});

	it("moves both directions from a corner and ignores the other axis on an edge", () => {
		expect(resizeCentered(start, "se", 10, 20, bounds)).toEqual({ width: 820, height: 640 });
		expect(resizeCentered(start, "nw", 10, 20, bounds)).toEqual({ width: 780, height: 560 });
		expect(resizeCentered(start, "e", 10, 200, bounds)).toEqual({ width: 820, height: 600 });
	});

	it("stays between the minimum size and the window", () => {
		expect(resizeCentered(start, "se", -1000, -1000, bounds)).toEqual({
			width: MIN_MODAL_WIDTH,
			height: MIN_MODAL_HEIGHT,
		});
		expect(resizeCentered(start, "se", 1000, 1000, bounds)).toEqual(bounds);
	});

	it("fits a window smaller than the minimum size", () => {
		expect(resizeCentered(start, "e", 0, 0, { width: 400, height: 300 })).toEqual({ width: 400, height: 300 });
	});
});

describe("clampShare", () => {
	it("keeps both panes visible", () => {
		expect(clampShare(0.5)).toBe(0.5);
		expect(clampShare(0)).toBe(MIN_RESULTS_SHARE);
		expect(clampShare(2)).toBe(MAX_RESULTS_SHARE);
	});
});
