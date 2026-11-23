export type ModalSize = { width: number; height: number };

export type ResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

export const MIN_MODAL_WIDTH = 480;
export const MIN_MODAL_HEIGHT = 360;

export const DEFAULT_RESULTS_SHARE = 0.45;
export const MIN_RESULTS_SHARE = 0.15;
export const MAX_RESULTS_SHARE = 0.85;

/** Keeps `value` within `min` and `max`, preferring `max` when the two cross, so a box still fits a small window. */
const clamp = (value: number, min: number, max: number): number => Math.round(Math.min(max, Math.max(min, value)));

export const clampShare = (share: number): number => Math.min(MAX_RESULTS_SHARE, Math.max(MIN_RESULTS_SHARE, share));

export const clampSize = (size: ModalSize, bounds: ModalSize): ModalSize => ({
	width: clamp(size.width, MIN_MODAL_WIDTH, bounds.width),
	height: clamp(size.height, MIN_MODAL_HEIGHT, bounds.height),
});

/**
 * The size of a centered box after one of its edges was dragged by `dx`, `dy`.
 * The opposite edge moves too, so the size changes twice as much and the
 * dragged edge stays under the pointer.
 */
export const resizeCentered = (
	start: ModalSize,
	edge: ResizeEdge,
	dx: number,
	dy: number,
	bounds: ModalSize,
): ModalSize => {
	const x = edge.includes("e") ? 1 : edge.includes("w") ? -1 : 0;
	const y = edge.includes("s") ? 1 : edge.includes("n") ? -1 : 0;
	return clampSize({ width: start.width + 2 * x * dx, height: start.height + 2 * y * dy }, bounds);
};
