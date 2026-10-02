import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	createRegistry,
	Harness,
	type HarnessSettings,
	type SnapshotEvent,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { PendingInput, SessionReport, SessionSpec } from "../../shared/protocol.ts";
import type { AgentConfig } from "./config.ts";
import { SpotAgent } from "./extension.ts";
import { prepareWorkspace } from "./git.ts";
import { withSessionId } from "./models.ts";

const ENTRY_CHUNK_BYTES = 600_000;

export interface SessionSink {
	events(sessionId: string, events: readonly unknown[]): void;
	status(report: SessionReport): void;
	ack(sessionId: string, requestId: string, error?: string): void;
	log(level: "info" | "warn" | "error", message: string): void;
}

const registry = createRegistry();
registry.install(CodingTools);
registry.install(SpotAgent);

const settings: HarnessSettings = {
	retry: { maxRetries: 6 },
	toolExecution: "parallel",
};

type UsageState = SnapshotEvent["usage"];

function totalCost(usage: UsageState | undefined): number {
	let total = 0;
	for (const bucket of Object.values(usage?.models ?? {})) total += bucket.cost?.total ?? 0;
	for (const bucket of Object.values(usage?.tools ?? {})) total += bucket.cost?.total ?? 0;
	return total;
}

/** One pi-durable Harness over `<sessions>/<id>/session.sqlite`, working in `<work>/<id>`. */
class Session {
	private harness: Harness | undefined;
	private root: Conversation | undefined;
	private stream: AgentEventStream | undefined;
	private opening: Promise<void> | undefined;
	private attaching: Promise<void> = Promise.resolve();
	private queued: PendingInput[] = [];
	private running = false;
	private inbox = 0;
	private compactions = new Set<string>();
	private costUsd = 0;
	private error: string | undefined;
	private lastBusy: boolean | undefined;
	private closed = false;

	constructor(
		public spec: SessionSpec,
		private readonly config: AgentConfig,
		private readonly models: MutableModels,
		private readonly sink: SessionSink,
		private readonly context: Context,
	) {}

	get cwd(): string {
		return join(this.config.workDir, this.spec.id);
	}

	get ready(): boolean {
		return this.root !== undefined;
	}

	get busy(): boolean {
		return this.running || this.inbox > 0 || this.compactions.size > 0 || this.queued.length > 0;
	}

	report(): SessionReport {
		return {
			sessionId: this.spec.id,
			ready: this.ready,
			busy: this.busy,
			...(this.error === undefined ? {} : { error: this.error }),
			costUsd: this.costUsd,
		};
	}

	/** Opens the session once; a failed open is retried by the next call. */
	open(): Promise<void> {
		this.opening ??= this.doOpen().catch((error: unknown) => {
			this.opening = undefined;
			this.error = error instanceof Error ? error.message : String(error);
			this.sink.log("error", `session ${this.spec.id}: ${this.error}`);
			// Unacknowledged inputs would keep the VM running; the next input retries the open.
			for (const input of this.queued.splice(0)) this.sink.ack(this.spec.id, input.requestId, this.error);
			this.publishStatus(true);
		});
		return this.opening;
	}

	private async doOpen(): Promise<void> {
		await prepareWorkspace(this.cwd, this.spec.repoUrl, this.spec.branch);
		const dir = join(this.config.sessionsDir, this.spec.id);
		await mkdir(dir, { recursive: true });
		const cwd = this.cwd;
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(dir, "session.sqlite")),
			{
				models: withSessionId(this.models, this.spec.id),
				registry,
				settings,
				env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd, shellEnv: process.env }),
				onReport: (error) => this.sink.log("warn", `session ${this.spec.id}: ${String(error)}`),
			},
			this.context,
		);
		const root = await harness.root(this.context, { agent: this.agentChange() });
		await this.applySpec(root);
		// Picks up whatever the previous VM left unfinished.
		harness.resume();
		this.harness = harness;
		this.root = root;
		this.error = undefined;
		await this.attachStream();
		for (const input of this.queued.splice(0)) await this.submit(input);
		this.sink.log("info", `session ${this.spec.id} open`);
		this.publishStatus(true);
	}

	private agentChange() {
		return {
			model: this.spec.model,
			thinkingLevel: this.spec.thinkingLevel ?? null,
			instructions: this.spec.instructions ?? null,
			cwd: this.cwd,
		};
	}

	private async applySpec(root: Conversation): Promise<void> {
		const agent = await root.agent(this.context);
		const wanted = this.spec;
		const same =
			agent.model?.provider === wanted.model.provider &&
			agent.model?.modelId === wanted.model.modelId &&
			(wanted.thinkingLevel === undefined || agent.thinkingLevel === wanted.thinkingLevel);
		if (!same) await root.configure(this.agentChange(), this.context);
	}

	async update(spec: SessionSpec): Promise<void> {
		this.spec = spec;
		if (this.root) await this.applySpec(this.root);
		else await this.open();
	}

	/** (Re)starts the event stream; its snapshot brings a reconnected Hub up to date. */
	attachStream(): Promise<void> {
		this.attaching = this.attaching.then(() => this.doAttachStream()).catch((error: unknown) => {
			this.sink.log("warn", `session ${this.spec.id} stream: ${String(error)}`);
		});
		return this.attaching;
	}

	private async doAttachStream(): Promise<void> {
		if (!this.harness || !this.root || this.closed) return;
		await this.stream?.stop().catch(() => undefined);
		const stream = await watchEvents(this.harness, this.root.id, this.context);
		this.stream = stream;
		this.applySnapshot(stream.snapshot);
		this.sendSnapshot(stream.snapshot);
		stream.start(async (events) => {
			for (const event of events) this.apply(event);
			this.sink.events(this.spec.id, events);
			this.publishStatus();
		});
	}

	private sendSnapshot(snapshot: SnapshotEvent): void {
		let chunk: unknown[] = [];
		let size = 0;
		for (const entry of snapshot.entries) {
			const bytes = JSON.stringify(entry).length;
			if (chunk.length > 0 && size + bytes > ENTRY_CHUNK_BYTES) {
				this.sink.events(this.spec.id, [{ type: "entries", entries: chunk }]);
				chunk = [];
				size = 0;
			}
			chunk.push(entry);
			size += bytes;
		}
		if (chunk.length > 0) this.sink.events(this.spec.id, [{ type: "entries", entries: chunk }]);
		this.sink.events(this.spec.id, [{ ...snapshot, entries: [] }]);
	}

	private applySnapshot(snapshot: SnapshotEvent): void {
		this.running = snapshot.run !== undefined;
		this.inbox = snapshot.inbox.length;
		this.compactions = new Set(snapshot.compactions.map((c) => String((c as { taskId?: unknown }).taskId)));
		this.costUsd = totalCost(snapshot.usage);
	}

	private apply(event: AgentEvent): void {
		switch (event.type) {
			case "snapshot":
				this.applySnapshot(event);
				break;
			case "run_start":
				this.running = true;
				break;
			case "run_end":
				this.running = false;
				break;
			case "inbox_update":
				this.inbox = event.items.length;
				break;
			case "compaction_start":
				this.compactions.add(String(event.taskId));
				break;
			case "compaction_end":
				this.compactions.delete(String(event.taskId));
				break;
			case "usage_changed":
				this.costUsd = totalCost(event.usage);
				break;
		}
	}

	private publishStatus(force = false): void {
		const busy = this.busy;
		if (!force && busy === this.lastBusy) return;
		this.lastBusy = busy;
		this.sink.status(this.report());
	}

	async submit(input: PendingInput): Promise<void> {
		if (!this.root) {
			if (!this.queued.some((q) => q.requestId === input.requestId)) this.queued.push(input);
			this.publishStatus();
			void this.open();
			return;
		}
		try {
			// The same requestId returns the existing submission, so Hub redeliveries are harmless.
			await this.root.submit(
				{ type: "input", content: input.content, requestId: input.requestId, whenBusy: input.whenBusy },
				this.context,
			);
			this.sink.ack(this.spec.id, input.requestId);
		} catch (error) {
			this.sink.ack(this.spec.id, input.requestId, error instanceof Error ? error.message : String(error));
		}
	}

	async abort(): Promise<void> {
		this.queued = [];
		await this.opening?.catch(() => undefined);
		await this.root?.abort(this.context);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.opening?.catch(() => undefined);
		await this.attaching;
		await this.stream?.stop().catch(() => undefined);
		await this.harness?.close(this.context);
	}
}

export class SessionManager {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly config: AgentConfig,
		private readonly models: MutableModels,
		private readonly sink: SessionSink,
		private readonly context: Context,
	) {}

	get all(): Session[] {
		return [...this.sessions.values()];
	}

	/**
	 * Starts opening every known session in the background, creating workspaces for new ones. Sessions that are
	 * already open get a fresh event stream, whose snapshot brings a reconnected Hub up to date.
	 */
	sync(specs: readonly SessionSpec[]): void {
		for (const spec of specs) this.upsert(spec, true);
	}

	upsert(spec: SessionSpec, resync = false): void {
		const existing = this.sessions.get(spec.id);
		if (!existing) {
			const session = new Session(spec, this.config, this.models, this.sink, this.context);
			this.sessions.set(spec.id, session);
			void session.open();
			return;
		}
		void existing
			.update(spec)
			.then(() => (resync ? existing.attachStream() : undefined))
			.catch((error: unknown) => this.sink.log("warn", `session ${spec.id}: ${String(error)}`));
	}

	async submit(input: PendingInput): Promise<void> {
		const session = this.sessions.get(input.sessionId);
		if (!session) return this.sink.ack(input.sessionId, input.requestId, "unknown session");
		await session.submit(input);
	}

	async abort(sessionId: string): Promise<void> {
		await this.sessions.get(sessionId)?.abort();
	}

	async resync(sessionId: string): Promise<void> {
		await this.sessions.get(sessionId)?.attachStream();
	}

	reports(): SessionReport[] {
		return this.all.map((session) => session.report());
	}

	async closeAll(timeoutMs = 20_000): Promise<void> {
		await Promise.all(
			this.all.map((session) =>
				Promise.race([session.close(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]).catch(
					(error: unknown) => this.sink.log("warn", `close ${session.spec.id}: ${String(error)}`),
				),
			),
		);
	}
}
