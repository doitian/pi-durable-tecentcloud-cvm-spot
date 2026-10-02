import type { AgentToHub, HubToAgent } from "../../shared/protocol.ts";

// Cloudflare rejects WebSocket messages over 1 MiB; stay well below.
const MAX_MESSAGE_BYTES = 900_000;

export interface HubClientHandlers {
	onOpen(): void;
	onMessage(message: HubToAgent): void;
	onClose(): void;
}

/** Outbound WebSocket to the Hub, reconnecting with backoff until closed. */
export class HubClient {
	private ws: WebSocket | undefined;
	private backoffMs = 1000;
	private closed = false;
	private pingTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly url: string,
		private readonly handlers: HubClientHandlers,
	) {}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.closed) return;
		const ws = new WebSocket(this.url);
		this.ws = ws;
		ws.addEventListener("open", () => {
			this.backoffMs = 1000;
			this.pingTimer = setInterval(() => this.send({ t: "ping" }), 20_000);
			this.handlers.onOpen();
		});
		ws.addEventListener("message", (event) => {
			try {
				this.handlers.onMessage(JSON.parse(String(event.data)) as HubToAgent);
			} catch (error) {
				console.error("bad hub message", error);
			}
		});
		ws.addEventListener("close", (event) => {
			clearInterval(this.pingTimer);
			if (this.ws !== ws) return;
			this.ws = undefined;
			console.warn(`hub connection closed (${event.code} ${event.reason})`);
			this.handlers.onClose();
			if (this.closed) return;
			setTimeout(() => this.connect(), this.backoffMs);
			this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
		});
		ws.addEventListener("error", () => {
			// A close event follows and schedules the reconnect.
		});
	}

	send(message: AgentToHub): boolean {
		if (!this.connected) return false;
		this.ws!.send(JSON.stringify(message));
		return true;
	}

	/** Sends events in batches that fit the message limit; oversized single events are truncated. */
	sendEvents(sessionId: string, events: readonly unknown[]): boolean {
		let batch: unknown[] = [];
		let size = 0;
		for (const event of events) {
			const encoded = JSON.stringify(event);
			const item = encoded.length > MAX_MESSAGE_BYTES ? truncateEvent(event, encoded.length) : event;
			const itemSize = Math.min(encoded.length, MAX_MESSAGE_BYTES);
			if (batch.length > 0 && size + itemSize > MAX_MESSAGE_BYTES) {
				if (!this.send({ t: "events", sessionId, events: batch })) return false;
				batch = [];
				size = 0;
			}
			batch.push(item);
			size += itemSize;
		}
		return batch.length === 0 || this.send({ t: "events", sessionId, events: batch });
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.pingTimer);
		const ws = this.ws;
		if (!ws) return;
		// Let queued frames drain before closing.
		for (let i = 0; i < 50 && ws.bufferedAmount > 0; i++) await new Promise((r) => setTimeout(r, 100));
		ws.close(1000, "agent stopping");
	}
}

function truncateEvent(event: unknown, size: number): unknown {
	const type = (event as { type?: string }).type ?? "unknown";
	return { type: "oversized", original: type, bytes: size };
}
