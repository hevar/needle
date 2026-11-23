import {
	DEFAULT_RESULTS_SHARE,
	MAX_RESULTS_SHARE,
	MIN_RESULTS_SHARE,
	RESIZE_EDGES,
	clampShare,
	resizeCentered,
	type ModalSize,
} from "./layout";

/** Space kept free around a resized modal, matching the stylesheet's max size. */
const VIEWPORT_MARGIN = 32;
const KEY_STEP = 0.05;

type DragHandlers = {
	move: (dx: number, dy: number) => void;
	end: () => void;
};

const startDrag = (handle: HTMLElement, evt: PointerEvent, handlers: DragHandlers): void => {
	if (evt.button !== 0) {
		return;
	}
	evt.preventDefault();
	handle.setPointerCapture(evt.pointerId);
	handle.addClass("is-dragging");
	let moved = false;
	const onMove = (move: PointerEvent): void => {
		moved = true;
		handlers.move(move.clientX - evt.clientX, move.clientY - evt.clientY);
	};
	const onEnd = (): void => {
		handle.removeEventListener("pointermove", onMove);
		handle.removeEventListener("lostpointercapture", onEnd);
		handle.removeClass("is-dragging");
		if (moved) {
			handlers.end();
		}
	};
	handle.addEventListener("pointermove", onMove);
	handle.addEventListener("lostpointercapture", onEnd);
};

export type ResizeCallbacks = {
	onResize: (size: ModalSize) => void;
	onCommit: () => void;
	onReset: () => void;
};

export const addResizeHandles = (modalEl: HTMLElement, callbacks: ResizeCallbacks): void => {
	for (const edge of RESIZE_EDGES) {
		const handle = modalEl.createDiv({ cls: `needle-resize-handle mod-${edge}` });
		handle.addEventListener("mousedown", (evt) => evt.preventDefault());
		handle.addEventListener("pointerdown", (evt) => {
			const { width, height } = modalEl.getBoundingClientRect();
			const win = modalEl.win;
			const bounds = { width: win.innerWidth - VIEWPORT_MARGIN, height: win.innerHeight - VIEWPORT_MARGIN };
			startDrag(handle, evt, {
				move: (dx, dy) => callbacks.onResize(resizeCentered({ width, height }, edge, dx, dy, bounds)),
				end: callbacks.onCommit,
			});
		});
		handle.addEventListener("dblclick", callbacks.onReset);
	}
};

export type SplitterOptions = {
	share: number;
	labelledBy: string;
	controls: string;
	onChange: (share: number) => void;
	onCommit: (share: number) => void;
};

/**
 * Horizontal divider placed below `above` that sizes it as a share of their
 * parent. Follows the ARIA window splitter pattern: drag it, or focus it and
 * use the arrow keys, Home and End. Double-click restores the default split.
 */
export class Splitter {
	readonly el: HTMLElement;
	private share: number;

	constructor(
		private readonly above: HTMLElement,
		private readonly options: SplitterOptions,
	) {
		this.el = createDiv({
			cls: "needle-splitter",
			attr: {
				role: "separator",
				tabindex: "0",
				"aria-orientation": "horizontal",
				"aria-labelledby": options.labelledBy,
				"aria-controls": options.controls,
				"aria-valuemin": String(Math.round(MIN_RESULTS_SHARE * 100)),
				"aria-valuemax": String(Math.round(MAX_RESULTS_SHARE * 100)),
			},
		});
		this.el.createDiv({ cls: "needle-splitter-grip" });
		above.after(this.el);
		this.share = clampShare(options.share);
		this.apply(this.share);
		this.el.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.el.addEventListener("pointerdown", (evt) => this.drag(evt));
		this.el.addEventListener("dblclick", () => this.commit(DEFAULT_RESULTS_SHARE));
		this.el.addEventListener("keydown", (evt) => this.onKeyDown(evt));
	}

	private drag(evt: PointerEvent): void {
		const start = this.above.getBoundingClientRect().height;
		const total = this.el.parentElement?.getBoundingClientRect().height ?? 0;
		if (total <= 0) {
			return;
		}
		startDrag(this.el, evt, {
			move: (_dx, dy) => this.apply((start + dy) / total),
			end: () => this.options.onCommit(this.share),
		});
	}

	private onKeyDown(evt: KeyboardEvent): void {
		const targets: Record<string, number> = {
			ArrowUp: this.share - KEY_STEP,
			ArrowDown: this.share + KEY_STEP,
			Home: MIN_RESULTS_SHARE,
			End: MAX_RESULTS_SHARE,
		};
		const target = targets[evt.key];
		if (target === undefined || evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) {
			return;
		}
		evt.preventDefault();
		this.commit(target);
	}

	private commit(share: number): void {
		this.apply(share);
		this.options.onCommit(this.share);
	}

	private apply(share: number): void {
		this.share = clampShare(share);
		this.el.setAttr("aria-valuenow", String(Math.round(this.share * 100)));
		this.options.onChange(this.share);
	}
}
