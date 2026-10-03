import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
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
	type Registry,
	type SnapshotEvent,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { PendingInput, SessionReport, SessionSpec } from "../../shared/protocol.ts";
import { Approvals, type Decision } from "./approvals.ts";
import type { AgentConfig } from "./config.ts";
import { prepareWorkspace } from "./git.ts";
import { McpServers } from "./mcp.ts";
import { withSessionId } from "./models.ts";
import { createPiPrompt } from "./pi-prompt.ts";
import { Subagent } from "./subagent.ts";

const ENTRY_CHUNK_BYTES = 600_000;

export interface SessionSink {
	events(sessionId: string, events: readonly unknown[]): void;
	status(report: SessionReport): void;
	ack(sessionId: string, requestId: string, error?: string): void;
	approvalRequest(sessionId: string, approvalId: string, toolName: string, preview: string): void;
	approvalSettled(sessionId: string, approvalId: string): void;
	log(level: "info" | "warn" | "error", message: string): void;
}

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

/**
 * One pi-durable Harness over `<sessions>/<id>/session.sqlite`, working in `<work>/<id>`, with its own registry: pi's
 * tools and prompt, the approval gate and the MCP servers configured for its workspace.
 */
class Session {
	private harness: Harness | undefined;
	private readonly registry: Registry = createRegistry();
	private readonly approvals: Approvals;
	private readonly mcp: McpServers;
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
	private lastReport: string | undefined;
	private closed = false;

	constructor(
		public spec: SessionSpec,
		private readonly config: AgentConfig,
		private readonly models: MutableModels,
		private readonly sink: SessionSink,
		private readonly context: Context,
	) {
		const id = spec.id;
		this.approvals = new Approvals(id, () => this.spec.approvalMode ?? "auto", {
			request: (approvalId, toolName, preview) => sink.approvalRequest(id, approvalId, toolName, preview),
			settled: (approvalId) => sink.approvalSettled(id, approvalId),
			changed: () => this.publishStatus(),
		});
		this.mcp = new McpServers(
			this.cwd,
			config.agentDir,
			(extension) => this.registry.install(extension),
			() => this.publishStatus(),
			(level, message) => sink.log(level, `session ${id}: ${message}`),
		);
		this.registry.install(CodingTools);
		this.registry.install(Subagent);
		this.registry.install(createPiPrompt(config.agentDir, config.workDir));
		this.registry.install(this.approvals.extension);
	}

	get cwd(): string {
		return join(this.config.workDir, this.spec.id);
	}

	get ready(): boolean {
		return this.root !== undefined;
	}

	get busy(): boolean {
		return this.running || this.inbox > 0 || this.compactions.size > 0 || this.queued.length > 0 || this.approvals.count > 0;
	}

	report(): SessionReport {
		const mcp = this.mcp.status();
		return {
			sessionId: this.spec.id,
			ready: this.ready,
			busy: this.busy,
			...(this.error === undefined ? {} : { error: this.error }),
			costUsd: this.costUsd,
			...(this.approvals.count > 0 ? { awaitingApproval: this.approvals.count } : {}),
			...(mcp.length > 0 ? { mcp } : {}),
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
		// Before resuming, so a run interrupted mid-call finds the MCP tool it called.
		await this.mcp.start();
		const dir = join(this.config.sessionsDir, this.spec.id);
		await mkdir(dir, { recursive: true });
		const cwd = this.cwd;
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(dir, "session.sqlite")),
			{
				models: withSessionId(this.models, this.spec.id),
				registry: this.registry,
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

	/** Reports when something the Hub acts on changed. */
	private publishStatus(force = false): void {
		const report = this.report();
		const key = JSON.stringify([report.busy, report.ready, report.awaitingApproval, report.mcp]);
		if (!force && key === this.lastReport) return;
		this.lastReport = key;
		this.sink.status(report);
	}

	reply(approvalId: string, decision: Decision): void {
		this.approvals.reply(approvalId, decision);
	}

	resendApprovals(): void {
		this.approvals.resend();
	}

	async reloadMcp(): Promise<void> {
		await this.mcp.start();
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

	/** Summarizes older context now; it is placed when the conversation is idle or at the next turn boundary. */
	async compact(instructions?: string): Promise<void> {
		if (!this.root) throw new Error("session is not open");
		await this.root.compact(instructions || undefined, this.context);
	}

	/** Starts a fresh context, optionally from a handoff note; older entries stay in storage. */
	async reset(handoff?: string): Promise<void> {
		if (!this.root) throw new Error("session is not open");
		await this.root.reset(handoff || undefined, this.context);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.approvals.freeze();
		await this.opening?.catch(() => undefined);
		await this.attaching;
		await this.stream?.stop().catch(() => undefined);
		await this.harness?.close(this.context);
		await this.mcp.close();
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

	/** Closes an archived session; its files stay on the disk. */
	async remove(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		await session.close();
	}

	/** Deletes sessions for good: closes them, ends their tmux sessions and removes their state and workspaces. */
	async purge(sessionIds: readonly string[]): Promise<void> {
		for (const id of sessionIds) {
			await this.remove(id);
			await new Promise((resolve) => execFile("tmux", ["kill-session", "-t", `pi-${id.slice(0, 8)}`], () => resolve(undefined)));
			for (const path of [join(this.config.sessionsDir, id), join(this.config.workDir, id), join(this.config.workDir, `${id}.cloning`)]) {
				await rm(path, { recursive: true, force: true });
			}
		}
	}

	async compact(sessionId: string, instructions?: string): Promise<void> {
		await this.sessions.get(sessionId)?.compact(instructions);
	}

	async reset(sessionId: string, handoff?: string): Promise<void> {
		await this.sessions.get(sessionId)?.reset(handoff);
	}

	async resync(sessionId: string): Promise<void> {
		await this.sessions.get(sessionId)?.attachStream();
	}

	reply(sessionId: string, approvalId: string, decision: Decision): void {
		this.sessions.get(sessionId)?.reply(approvalId, decision);
	}

	/** After a reconnect: asks again for every call still waiting, in case the Hub lost track. */
	resendApprovals(): void {
		for (const session of this.all) session.resendApprovals();
	}

	async reloadMcp(sessionId: string): Promise<void> {
		await this.sessions.get(sessionId)?.reloadMcp();
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
