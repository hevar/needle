import { SearchEngine } from "./engine";
import type { FromWorker, SearchRequest, ToWorker } from "./types";

type WorkerScope = {
	postMessage: (message: FromWorker) => void;
	addEventListener: (type: "message", listener: (event: MessageEvent<ToWorker>) => void) => void;
};

const scope = self as unknown as WorkerScope;
const engine = new SearchEngine();
let currentId = 0;

// A MessageChannel round trip yields to the event loop without the 4 ms clamp
// of nested timers, so incoming cancel/search messages are seen promptly.
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => {
	waiting.shift()?.();
};
const pause = (): Promise<void> =>
	new Promise((resolve) => {
		waiting.push(resolve);
		channel.port2.postMessage(null);
	});

const run = async (id: number, request: SearchRequest): Promise<void> => {
	try {
		const response = await engine.search(request, {
			now: () => performance.now(),
			pause,
			isCancelled: () => currentId !== id,
			onProgress: (scanned, total) => scope.postMessage({ type: "progress", id, scanned, total }),
		});
		if (response !== null && currentId === id) {
			scope.postMessage({ type: "result", id, response });
		}
	} catch (error) {
		scope.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
	}
};

scope.addEventListener("message", (event) => {
	const message = event.data;
	switch (message.type) {
		case "upsert":
			engine.upsert(message.docs);
			break;
		case "remove":
			engine.remove(message.paths);
			break;
		case "clear":
			engine.clear();
			break;
		case "cancel":
			if (currentId === message.id) {
				currentId = 0;
			}
			break;
		case "search":
			currentId = message.id;
			void run(message.id, message.request);
			break;
	}
});

scope.postMessage({ type: "ready" });
