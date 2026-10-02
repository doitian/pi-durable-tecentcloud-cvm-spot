import { DurableObject } from "cloudflare:workers";
import type {
	AgentToHub,
	AuthReport,
	HubToAgent,
	HubToUi,
	InstancePhase,
	PanelState,
	SessionReport,
	SessionSpec,
	SessionView,
	ThinkingLevel,
	UiToHub,
} from "../../shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { bootstrapScript, encodeUserData } from "./bootstrap.ts";
import {
	attachDisk,
	type Candidate,
	type Category,
	createDisk,
	createSnapshot,
	describeDisk,
	describeTaggedInstances,
	detachDisk,
	type DiskInfo,
	ensureDefaultSubnet,
	ensureSecurityGroup,
	findUbuntuImage,
	type InstanceInfo,
	isGlobalLaunchError,
	keepDiskOnTermination,
	listSpotCandidates,
	runSpotInstance,
	snapshotState,
	terminateInstance,
} from "./cloud.ts";
import type { Env } from "./env.ts";
import { TencentCloud } from "./tencent.ts";

const TAG_KEY = "pi-spot";
const BOOT_TIMEOUT_MS = 20 * 60_000;
const AGENT_LOST_MS = 5 * 60_000;
const DRAIN_TIMEOUT_MS = 3 * 60_000;
const COOLDOWN_MS = 30 * 60_000;
const MIGRATE_AFTER_MS = 10 * 60_000;
const VANISH_GRACE_MS = 90_000;
const DEAD_STATES = new Set(["LAUNCH_FAILED", "SHUTDOWN", "TERMINATING", "STOPPED", "STOPPING"]);
const MAX_ENTRY_BYTES = 1_500_000;
const TRANSCRIPT_LIMIT = 400;

export interface Settings {
	minCpu: number;
	minMemoryGb: number;
	maxHourlyPrice: number | null;
	category: Category;
	zones: string[];
	idleMinutes: number;
	dataDiskGb: number;
	bandwidthMbps: number;
	defaultModel: string;
}

interface InstanceRecord {
	id: string;
	zone: string;
	type: string;
	cpu: number;
	memoryGb: number;
	hourlyPrice: number | null;
	token: string;
	phase: InstancePhase;
	launchedAt: number;
	attachRequestedAt?: number;
	connectedAt?: number;
	disconnectedAt?: number;
	drainStartedAt?: number;
	reclaimAt?: string;
}

interface RetiredInstance {
	id: string;
	token?: string;
	reason: string;
	at: number;
	/** Grace for a reclaimed instance to checkpoint before the Hub takes its disk. */
	terminateAfter: number;
	stopped: boolean;
	detachRequestedAt?: number;
	terminateRequestedAt?: number;
}

interface CloudState {
	disk?: { id: string; zone: string; sizeGb: number; formatted: boolean };
	securityGroupId?: string;
	subnets: Record<string, { vpcId: string; subnetId: string } | "classic">;
	image?: { id: string; resolvedAt: number };
	instance?: InstanceRecord;
	retired: RetiredInstance[];
	cooldown: Record<string, number>;
	noCapacitySince?: number;
	migration?: { fromDiskId: string; toZone: string; snapshotId?: string; newDiskId?: string; startedAt: number };
	orphans: Array<{ kind: "disk" | "snapshot"; id: string; note: string }>;
	lastError?: { message: string; at: number };
	idleSince?: number;
	manualUntil?: number;
}

type SessionRow = {
	id: string;
	spec: string;
	created_at: number;
	last_activity_at: number;
	ready: number;
	busy: number;
	error: string | null;
	cost: number;
	pending_abort: number;
};

type SocketAttachment = { kind: "agent"; instanceId: string } | { kind: "ui"; sessionId: string | null };

export interface CreateSessionInput {
	title?: string;
	repoUrl?: string;
	branch?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	instructions?: string;
	prompt?: string;
}

function parseModel(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash <= 0) throw new Error(`Model must look like provider/modelId, got "${value}"`);
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function envNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(parsed) ? parsed : fallback;
}

export class Hub extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private reconciling: Promise<void> | undefined;
	private reconcileAgain = false;
	private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly activityWrites = new Map<string, number>();
	/** Login flows in progress; they keep the VM from idling out. */
	private readonly activeLogins = new Set<string>();
	/** Set while a reconcile pass runs: the changes `updateCloud` made since the pass loaded its copy. */
	private concurrentCloudChanges: Array<(cloud: CloudState) => void> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
				ready INTEGER NOT NULL DEFAULT 0, busy INTEGER NOT NULL DEFAULT 0, error TEXT, cost REAL NOT NULL DEFAULT 0,
				pending_abort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS inputs (
				request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, when_busy TEXT NOT NULL,
				created_at INTEGER NOT NULL, acked_at INTEGER, error TEXT);
			CREATE TABLE IF NOT EXISTS entries (
				session_id TEXT NOT NULL, entry_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, entry_id));
			CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL,
				message TEXT NOT NULL);
		`);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
	}

	// ---------------------------------------------------------------- storage helpers

	private getJson<T>(key: string, fallback: T): T {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
		return row ? (JSON.parse(row.value) as T) : fallback;
	}

	private putJson(key: string, value: unknown): void {
		this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, JSON.stringify(value));
	}

	private loadCloud(): CloudState {
		return this.getJson<CloudState>("cloud", { subnets: {}, retired: [], cooldown: {}, orphans: [] });
	}

	private saveCloud(cloud: CloudState): void {
		this.putJson("cloud", cloud);
	}

	/**
	 * The only write path outside reconcileOnce. A reconcile pass keeps its own copy across Tencent API calls; changes
	 * made meanwhile are recorded and replayed onto that copy before it is saved, so the pass cannot overwrite them.
	 */
	private updateCloud(change: (cloud: CloudState) => void): void {
		const cloud = this.loadCloud();
		change(cloud);
		this.saveCloud(cloud);
		this.concurrentCloudChanges?.push(change);
	}

	private get localMode(): boolean {
		return this.env.CLOUD_MODE === "local";
	}

	private get namePrefix(): string {
		return this.env.NAME_PREFIX || "pi-spot";
	}

	private defaultSettings(): Settings {
		const env = this.env;
		return {
			minCpu: envNumber(env.MIN_CPU, 2),
			minMemoryGb: envNumber(env.MIN_MEMORY_GB, 4),
			maxHourlyPrice: env.MAX_HOURLY_PRICE ? Number(env.MAX_HOURLY_PRICE) : null,
			category: (env.PREFERRED_CATEGORY as Category) || "general",
			zones: (env.ZONES ?? "")
				.split(",")
				.map((zone) => zone.trim())
				.filter(Boolean),
			idleMinutes: envNumber(env.IDLE_MINUTES, 20),
			dataDiskGb: envNumber(env.DATA_DISK_GB, 100),
			bandwidthMbps: envNumber(env.BANDWIDTH_MBPS, 100),
			defaultModel: env.DEFAULT_MODEL || "anthropic/claude-sonnet-5",
		};
	}

	private settings(): Settings {
		return { ...this.defaultSettings(), ...this.getJson<Partial<Settings>>("settings", {}) };
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		console[level === "info" ? "log" : level](message);
		this.sql.exec("INSERT INTO log (at, level, message) VALUES (?, ?, ?)", Date.now(), level, message.slice(0, 2000));
		this.sql.exec("DELETE FROM log WHERE id <= (SELECT MAX(id) - 300 FROM log)");
		this.scheduleBroadcast();
	}

	private tencent(): TencentCloud {
		if (!this.env.TENCENTCLOUD_SECRET_ID || !this.env.TENCENTCLOUD_SECRET_KEY) {
			throw new Error("TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY are not configured");
		}
		return new TencentCloud(
			{ secretId: this.env.TENCENTCLOUD_SECRET_ID, secretKey: this.env.TENCENTCLOUD_SECRET_KEY },
			this.env.TENCENT_REGION || "ap-singapore",
			this.env.TENCENT_API_ENDPOINT || undefined,
		);
	}

	// ---------------------------------------------------------------- sessions

	private sessionRows(): SessionRow[] {
		return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE archived = 0 ORDER BY created_at DESC").toArray();
	}

	private specs(): SessionSpec[] {
		return this.sessionRows().map((row) => JSON.parse(row.spec) as SessionSpec);
	}

	private pendingInputs(): Array<{ sessionId: string; requestId: string; content: string; whenBusy: "steer" | "followUp" }> {
		return this.sql
			.exec<{ request_id: string; session_id: string; content: string; when_busy: string }>(
				`SELECT i.request_id, i.session_id, i.content, i.when_busy FROM inputs i
				 JOIN sessions s ON s.id = i.session_id WHERE i.acked_at IS NULL AND s.archived = 0 ORDER BY i.created_at`,
			)
			.toArray()
			.map((row) => ({
				sessionId: row.session_id,
				requestId: row.request_id,
				content: row.content,
				whenBusy: row.when_busy === "steer" ? "steer" : "followUp",
			}));
	}

	private hasDemand(now: number, cloud: CloudState): boolean {
		if ((cloud.manualUntil ?? 0) > now || this.activeLogins.size > 0) return true;
		const sessions = this.sql
			.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM sessions WHERE archived = 0 AND (busy = 1 OR (ready = 0 AND error IS NULL))",
			)
			.one().n;
		if (sessions > 0) return true;
		return this.pendingInputs().length > 0;
	}

	private touch(sessionId: string, now = Date.now()): void {
		const last = this.activityWrites.get(sessionId) ?? 0;
		if (now - last < 30_000) return;
		this.activityWrites.set(sessionId, now);
		this.sql.exec("UPDATE sessions SET last_activity_at = ? WHERE id = ?", now, sessionId);
	}

	// ---------------------------------------------------------------- RPC used by the Worker

	async tick(): Promise<void> {
		await this.reconcile();
	}

	/** Remembers the origin the control panel is used from; new VMs download the agent from and connect to it. */
	async notePublicUrl(origin: string): Promise<void> {
		if (this.getJson<string | null>("publicUrl", null) !== origin) this.putJson("publicUrl", origin);
	}

	private publicUrl(): string | undefined {
		return (this.env.PUBLIC_URL || this.getJson<string | null>("publicUrl", null) || undefined)?.replace(/\/+$/, "");
	}

	async panelState(): Promise<PanelState> {
		return this.buildPanelState();
	}

	async getSettings(): Promise<Settings> {
		return this.settings();
	}

	async updateSettings(patch: Partial<Settings>): Promise<Settings> {
		const current = this.getJson<Partial<Settings>>("settings", {});
		const next: Partial<Settings> = { ...current };
		if (patch.minCpu !== undefined) next.minCpu = Math.max(1, Number(patch.minCpu));
		if (patch.minMemoryGb !== undefined) next.minMemoryGb = Math.max(1, Number(patch.minMemoryGb));
		if (patch.maxHourlyPrice !== undefined) {
			next.maxHourlyPrice = patch.maxHourlyPrice === null || String(patch.maxHourlyPrice) === "" ? null : Number(patch.maxHourlyPrice);
		}
		if (patch.category !== undefined) {
			if (!["general", "compute", "memory", "any"].includes(patch.category)) throw new Error("bad category");
			next.category = patch.category;
		}
		if (patch.zones !== undefined) next.zones = patch.zones.map((zone) => zone.trim()).filter(Boolean);
		if (patch.idleMinutes !== undefined) next.idleMinutes = Math.max(1, Number(patch.idleMinutes));
		if (patch.dataDiskGb !== undefined) next.dataDiskGb = Math.max(20, Number(patch.dataDiskGb));
		if (patch.bandwidthMbps !== undefined) next.bandwidthMbps = Math.max(1, Number(patch.bandwidthMbps));
		if (patch.defaultModel !== undefined) {
			parseModel(patch.defaultModel);
			next.defaultModel = patch.defaultModel;
		}
		this.putJson("settings", next);
		this.log("info", "settings updated");
		return this.settings();
	}

	async candidates(): Promise<{ zone: string | null; candidates: Candidate[] }> {
		const cloud = this.loadCloud();
		const settings = this.settings();
		const zones = cloud.disk ? [cloud.disk.zone] : settings.zones;
		const now = Date.now();
		const candidates = await listSpotCandidates(
			this.tencent(),
			settings,
			zones,
			(zone, type) => (cloud.cooldown[`${zone}/${type}`] ?? 0) > now,
		);
		return { zone: cloud.disk?.zone ?? null, candidates: candidates.slice(0, 30) };
	}

	async createSession(input: CreateSessionInput): Promise<SessionView> {
		const now = Date.now();
		const settings = this.settings();
		const spec: SessionSpec = {
			id: crypto.randomUUID(),
			title: input.title?.trim() || input.prompt?.trim().slice(0, 60) || "New session",
			model: parseModel(input.model?.trim() || settings.defaultModel),
			...(input.repoUrl?.trim() ? { repoUrl: input.repoUrl.trim() } : {}),
			...(input.branch?.trim() ? { branch: input.branch.trim() } : {}),
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
		};
		this.sql.exec(
			"INSERT INTO sessions (id, spec, created_at, last_activity_at) VALUES (?, ?, ?, ?)",
			spec.id,
			JSON.stringify(spec),
			now,
			now,
		);
		this.sendToAgent({ t: "session", session: spec });
		if (input.prompt?.trim()) this.queueInput(spec.id, input.prompt.trim(), "followUp");
		this.log("info", `session "${spec.title}" created`);
		await this.ensureAlarm(0);
		return this.buildPanelState().sessions.find((session) => session.id === spec.id)!;
	}

	async sendInput(sessionId: string, content: string, whenBusy: "steer" | "followUp"): Promise<void> {
		if (!content.trim()) throw new Error("empty input");
		const exists = this.sql.exec("SELECT 1 FROM sessions WHERE id = ? AND archived = 0", sessionId).toArray().length;
		if (!exists) throw new Error("unknown session");
		this.queueInput(sessionId, content, whenBusy);
		await this.ensureAlarm(0);
	}

	private queueInput(sessionId: string, content: string, whenBusy: "steer" | "followUp"): void {
		const requestId = crypto.randomUUID();
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO inputs (request_id, session_id, content, when_busy, created_at) VALUES (?, ?, ?, ?, ?)",
			requestId,
			sessionId,
			content,
			whenBusy,
			now,
		);
		this.sql.exec("UPDATE sessions SET last_activity_at = ? WHERE id = ?", now, sessionId);
		this.sendToAgent({ t: "input", input: { sessionId, requestId, content, whenBusy } });
		this.scheduleBroadcast();
	}

	/** Switches the model from the next request on; an offline session picks it up when the VM starts. */
	async setSessionModel(sessionId: string, model: string): Promise<void> {
		const row = this.sql
			.exec<{ spec: string }>("SELECT spec FROM sessions WHERE id = ? AND archived = 0", sessionId)
			.toArray()[0];
		if (!row) throw new Error("unknown session");
		const spec: SessionSpec = { ...(JSON.parse(row.spec) as SessionSpec), model: parseModel(model) };
		this.sql.exec("UPDATE sessions SET spec = ? WHERE id = ?", JSON.stringify(spec), sessionId);
		this.sendToAgent({ t: "session", session: spec });
		this.log("info", `session "${spec.title}" now uses ${model}`);
	}

	async abortSession(sessionId: string): Promise<void> {
		this.sql.exec("DELETE FROM inputs WHERE session_id = ? AND acked_at IS NULL", sessionId);
		if (this.sendToAgent({ t: "abort", sessionId })) {
			this.log("info", `abort sent for session ${sessionId}`);
		} else {
			// The interrupted run would resume on the next VM; the agent aborts it right after opening.
			this.sql.exec("UPDATE sessions SET pending_abort = 1, busy = 0 WHERE id = ?", sessionId);
			this.log("info", `abort queued for session ${sessionId}`);
		}
		await this.ensureAlarm(0);
	}

	async archiveSession(sessionId: string): Promise<void> {
		this.sendToAgent({ t: "abort", sessionId });
		this.sql.exec("UPDATE sessions SET archived = 1, busy = 0 WHERE id = ?", sessionId);
		this.sql.exec("DELETE FROM inputs WHERE session_id = ? AND acked_at IS NULL", sessionId);
		this.log("info", `session ${sessionId} archived (its files stay on the data disk)`);
		await this.ensureAlarm(0);
	}

	async transcript(sessionId: string, limit = TRANSCRIPT_LIMIT): Promise<unknown[]> {
		return this.sql
			.exec<{ data: string }>(
				"SELECT data FROM entries WHERE session_id = ? ORDER BY entry_id DESC LIMIT ?",
				sessionId,
				limit,
			)
			.toArray()
			.reverse()
			.map((row) => JSON.parse(row.data));
	}

	/** Keeps a VM up for one idle period even without work, for example to warm it up. */
	async startInstance(): Promise<void> {
		const until = Date.now() + this.settings().idleMinutes * 60_000;
		this.updateCloud((cloud) => {
			cloud.manualUntil = until;
			cloud.idleSince = undefined;
		});
		this.log("info", "manual start requested");
		await this.ensureAlarm(0);
	}

	/** Drains and terminates the VM now; work in progress resumes on the next VM. */
	async stopInstance(): Promise<void> {
		const now = Date.now();
		const target = this.loadCloud().instance;
		const sent = target !== undefined && target.phase !== "draining" && this.sendToAgent({ t: "shutdown", reason: "manual stop" });
		this.updateCloud((cloud) => {
			cloud.manualUntil = undefined;
			const instance = cloud.instance;
			if (!instance || instance.id !== target?.id || instance.phase === "draining") return;
			if (sent) {
				instance.phase = "draining";
				instance.drainStartedAt = now;
			} else {
				this.retire(cloud, instance, "manual stop", now);
			}
		});
		this.log("info", "manual stop requested");
		await this.ensureAlarm(0);
	}

	// ---------------------------------------------------------------- WebSockets

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected a WebSocket upgrade", { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		if (url.pathname === "/api/agent/ws") {
			const instanceId = url.searchParams.get("instance") ?? "";
			const token = url.searchParams.get("token") ?? "";
			if (!this.agentAllowed(instanceId, token)) return new Response("forbidden", { status: 403 });
			for (const old of this.ctx.getWebSockets(`agent:${instanceId}`)) old.close(4000, "replaced");
			this.ctx.acceptWebSocket(server, ["agent", `agent:${instanceId}`]);
			server.serializeAttachment({ kind: "agent", instanceId } satisfies SocketAttachment);
		} else if (url.pathname === "/api/ui/ws") {
			await this.notePublicUrl(url.origin);
			this.ctx.acceptWebSocket(server, ["ui"]);
			server.serializeAttachment({ kind: "ui", sessionId: null } satisfies SocketAttachment);
			server.send(JSON.stringify({ t: "state", state: this.buildPanelState() } satisfies HubToUi));
		} else {
			return new Response("not found", { status: 404 });
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	private agentAllowed(instanceId: string, token: string): boolean {
		if (this.localMode) return instanceId === "local" && !!this.env.LOCAL_AGENT_TOKEN && token === this.env.LOCAL_AGENT_TOKEN;
		const cloud = this.loadCloud();
		if (cloud.instance?.id === instanceId) return cloud.instance.token === token;
		const retired = cloud.retired.find((r) => r.id === instanceId);
		return retired?.token !== undefined && retired.token === token;
	}

	private currentInstanceId(): string | undefined {
		return this.localMode ? "local" : this.loadCloud().instance?.id;
	}

	private agentSocket(instanceId = this.currentInstanceId()): WebSocket | undefined {
		if (!instanceId) return undefined;
		return this.ctx.getWebSockets(`agent:${instanceId}`).find((ws) => ws.readyState === WebSocket.OPEN);
	}

	private sendToAgent(message: HubToAgent): boolean {
		const ws = this.agentSocket();
		if (!ws) return false;
		ws.send(JSON.stringify(message));
		return true;
	}

	private sendToUis(message: HubToUi, sessionId?: string): void {
		const encoded = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets("ui")) {
			if (sessionId !== undefined) {
				const attachment = ws.deserializeAttachment() as SocketAttachment | null;
				if (attachment?.kind !== "ui" || attachment.sessionId !== sessionId) continue;
			}
			try {
				ws.send(encoded);
			} catch {
				// Closed sockets are cleaned up by webSocketClose.
			}
		}
	}

	private scheduleBroadcast(): void {
		if (this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = undefined;
			if (this.ctx.getWebSockets("ui").length > 0) this.sendToUis({ t: "state", state: this.buildPanelState() });
		}, 250);
	}

	override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null;
		if (!attachment || typeof data !== "string") return;
		try {
			if (attachment.kind === "agent") await this.onAgentMessage(ws, attachment.instanceId, JSON.parse(data) as AgentToHub);
			else this.onUiMessage(ws, JSON.parse(data) as UiToHub);
		} catch (error) {
			this.log("error", `websocket message: ${errorMessage(error)}`);
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null;
		if (attachment?.kind !== "agent") return;
		this.log("warn", `agent ${attachment.instanceId} disconnected (${code} ${reason})`);
		for (const loginId of this.activeLogins) {
			this.sendToUis({ t: "login_done", loginId, ok: false, error: "the agent disconnected" });
		}
		this.activeLogins.clear();
		const now = Date.now();
		this.updateCloud((cloud) => {
			if (cloud.instance?.id === attachment.instanceId) cloud.instance.disconnectedAt ??= now;
		});
		await this.ensureAlarm(15_000);
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws, 1006, "error");
	}

	private onUiMessage(ws: WebSocket, message: UiToHub): void {
		switch (message.t) {
			case "subscribe":
				return this.onSubscribe(ws, message.sessionId);
			case "login": {
				const loginId = crypto.randomUUID();
				if (!this.sendToAgent({ t: "login", loginId, provider: message.provider, type: message.type })) {
					ws.send(JSON.stringify({ t: "login_done", loginId, ok: false, error: "No VM is online. Start it first." } satisfies HubToUi));
					return;
				}
				this.activeLogins.add(loginId);
				this.log("info", `login to ${message.provider} (${message.type}) started`);
				return;
			}
			case "login_reply":
				// The value can be a secret; it is relayed, never stored or logged.
				this.sendToAgent({ t: "login_reply", loginId: message.loginId, promptId: message.promptId, value: message.value });
				return;
			case "login_cancel":
				this.sendToAgent({ t: "login_cancel", loginId: message.loginId });
				return;
			case "logout":
				if (!this.sendToAgent({ t: "logout", provider: message.provider })) this.log("warn", "logout needs a running VM");
				return;
		}
	}

	private onSubscribe(ws: WebSocket, sessionId: string | null): void {
		ws.serializeAttachment({ kind: "ui", sessionId } satisfies SocketAttachment);
		if (!sessionId) return;
		const entries = this.sql
			.exec<{ data: string }>(
				"SELECT data FROM entries WHERE session_id = ? ORDER BY entry_id DESC LIMIT ?",
				sessionId,
				TRANSCRIPT_LIMIT,
			)
			.toArray()
			.reverse()
			.map((row) => JSON.parse(row.data));
		ws.send(JSON.stringify({ t: "transcript", sessionId, entries } satisfies HubToUi));
		this.sendToAgent({ t: "resync", sessionId });
	}

	private async onAgentMessage(ws: WebSocket, instanceId: string, message: AgentToHub): Promise<void> {
		const now = Date.now();
		switch (message.t) {
			case "hello": {
				if (message.protocol !== PROTOCOL_VERSION) {
					this.log("error", `agent ${instanceId} speaks protocol ${message.protocol}, expected ${PROTOCOL_VERSION}`);
					ws.close(4001, "protocol mismatch");
					return;
				}
				this.updateCloud((cloud) => {
					if (cloud.instance?.id !== instanceId) return;
					cloud.instance.connectedAt = now;
					cloud.instance.disconnectedAt = undefined;
					if (cloud.instance.phase !== "draining") cloud.instance.phase = "running";
					if (cloud.disk) cloud.disk.formatted = true;
				});
				const aborts = this.sql
					.exec<{ id: string }>("SELECT id FROM sessions WHERE pending_abort = 1 AND archived = 0")
					.toArray()
					.map((row) => row.id);
				const welcome: HubToAgent = {
					t: "welcome",
					env: this.agentEnv(),
					sessions: this.specs(),
					inputs: this.pendingInputs(),
					aborts,
				};
				ws.send(JSON.stringify(welcome));
				this.log("info", `agent ${instanceId} connected (v${message.agentVersion})`);
				return;
			}
			case "ready":
				for (const report of message.sessions) this.applyReport(report, now);
				this.scheduleBroadcast();
				await this.reconcile();
				return;
			case "status":
				this.applyReport(message.session, now);
				this.scheduleBroadcast();
				if (!message.session.busy) await this.reconcile();
				return;
			case "events":
				this.storeEntries(message.sessionId, message.events);
				this.touch(message.sessionId, now);
				this.sendToUis({ t: "events", sessionId: message.sessionId, events: message.events }, message.sessionId);
				return;
			case "ack":
				this.sql.exec(
					"UPDATE inputs SET acked_at = ?, error = ? WHERE request_id = ?",
					now,
					message.error ?? null,
					message.requestId,
				);
				if (message.error) this.log("warn", `input to ${message.sessionId} failed: ${message.error}`);
				this.scheduleBroadcast();
				return;
			case "aborted":
				this.sql.exec("UPDATE sessions SET pending_abort = 0 WHERE id = ?", message.sessionId);
				return;
			case "reclaim": {
				if (this.loadCloud().instance?.id !== instanceId) return;
				const parsed = Date.parse(message.terminationTime);
				const deadline = Number.isNaN(parsed) ? now + 120_000 : parsed;
				this.updateCloud((cloud) => {
					if (cloud.instance?.id !== instanceId) return;
					cloud.cooldown[`${cloud.instance.zone}/${cloud.instance.type}`] = now + COOLDOWN_MS;
					this.retire(cloud, cloud.instance, "spot reclaim", now, deadline);
				});
				this.log("warn", `spot reclaim notice for ${instanceId} at ${message.terminationTime}; launching a replacement`);
				await this.reconcile();
				return;
			}
			case "stopped": {
				this.updateCloud((cloud) => {
					if (cloud.instance?.id === instanceId) this.retire(cloud, cloud.instance, message.reason, now);
					const retired = cloud.retired.find((r) => r.id === instanceId);
					if (retired) retired.stopped = true;
				});
				this.log("info", `agent ${instanceId} stopped (${message.reason})`);
				await this.reconcile();
				return;
			}
			case "log":
				this.log(message.level, `[${instanceId}] ${message.message}`);
				return;
			case "auth":
				this.putJson("auth", { providers: message.providers, models: message.models, at: now });
				this.scheduleBroadcast();
				return;
			case "login_event":
			case "login_prompt":
			case "login_prompt_closed":
				this.sendToUis(message);
				return;
			case "login_done":
				this.activeLogins.delete(message.loginId);
				this.log(message.ok ? "info" : "warn", `login ${message.ok ? "succeeded" : `failed: ${message.error}`}`);
				this.sendToUis(message);
				return;
			case "ping":
				ws.send(JSON.stringify({ t: "pong" } satisfies HubToAgent));
				return;
		}
	}

	private agentEnv(): Record<string, string> {
		if (!this.env.AGENT_ENV) return {};
		try {
			const parsed = JSON.parse(this.env.AGENT_ENV) as Record<string, unknown>;
			return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
		} catch {
			this.log("error", "AGENT_ENV is not valid JSON");
			return {};
		}
	}

	private applyReport(report: SessionReport, now: number): void {
		this.sql.exec(
			`UPDATE sessions SET ready = ?, busy = ?, error = ?, cost = ?,
			 last_activity_at = CASE WHEN ? = 1 THEN ? ELSE last_activity_at END WHERE id = ?`,
			report.ready ? 1 : 0,
			report.busy ? 1 : 0,
			report.error ?? null,
			report.costUsd ?? 0,
			report.busy ? 1 : 0,
			now,
			report.sessionId,
		);
	}

	private storeEntries(sessionId: string, events: readonly unknown[]): void {
		for (const event of events) {
			const e = event as { type?: string; entry?: unknown; entries?: unknown[] };
			const entries =
				e.type === "entries" ? (e.entries ?? []) : e.entry && /^(message_end|tool_execution_end|entry_appended)$/.test(e.type ?? "") ? [e.entry] : [];
			for (const entry of entries) {
				const id = Number((entry as { id?: unknown }).id);
				if (!Number.isSafeInteger(id)) continue;
				const data = JSON.stringify(entry);
				if (data.length > MAX_ENTRY_BYTES) continue;
				this.sql.exec("INSERT OR REPLACE INTO entries (session_id, entry_id, data) VALUES (?, ?, ?)", sessionId, id, data);
			}
		}
	}

	// ---------------------------------------------------------------- panel state

	private buildPanelState(): PanelState {
		const cloud = this.loadCloud();
		const pending = new Map<string, number>();
		for (const input of this.pendingInputs()) pending.set(input.sessionId, (pending.get(input.sessionId) ?? 0) + 1);
		const sessions: SessionView[] = this.sessionRows().map((row) => {
			const spec = JSON.parse(row.spec) as SessionSpec;
			return {
				id: spec.id,
				title: spec.title,
				...(spec.repoUrl ? { repoUrl: spec.repoUrl } : {}),
				model: spec.model,
				...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
				createdAt: row.created_at,
				lastActivityAt: row.last_activity_at,
				ready: row.ready === 1,
				busy: row.busy === 1,
				pendingInputs: pending.get(spec.id) ?? 0,
				...(row.error ? { error: row.error } : {}),
				costUsd: row.cost,
			};
		});
		const instance = this.localMode
			? {
					id: "local",
					zone: "local",
					type: "local",
					cpu: 0,
					memoryGb: 0,
					phase: "running" as const,
					launchedAt: 0,
					agentConnected: this.agentSocket("local") !== undefined,
				}
			: cloud.instance && {
					id: cloud.instance.id,
					zone: cloud.instance.zone,
					type: cloud.instance.type,
					cpu: cloud.instance.cpu,
					memoryGb: cloud.instance.memoryGb,
					...(cloud.instance.hourlyPrice !== null ? { hourlyPrice: cloud.instance.hourlyPrice } : {}),
					phase: cloud.instance.phase,
					launchedAt: cloud.instance.launchedAt,
					agentConnected: this.agentSocket(cloud.instance.id) !== undefined,
					...(cloud.instance.reclaimAt ? { reclaimAt: cloud.instance.reclaimAt } : {}),
				};
		const log = this.sql
			.exec<{ at: number; level: string; message: string }>("SELECT at, level, message FROM log ORDER BY id DESC LIMIT 60")
			.toArray();
		const auth = this.getJson<(AuthReport & { at: number }) | null>("auth", null);
		return {
			...(instance ? { instance } : {}),
			...(auth ? { auth } : {}),
			sessions,
			...(cloud.disk ? { disk: { id: cloud.disk.id, zone: cloud.disk.zone, sizeGb: cloud.disk.sizeGb } } : {}),
			...(cloud.lastError ? { lastError: cloud.lastError } : {}),
			log,
		};
	}

	// ---------------------------------------------------------------- reconciliation

	override async alarm(): Promise<void> {
		await this.reconcile();
	}

	private async ensureAlarm(delayMs: number): Promise<void> {
		const at = Date.now() + delayMs;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	/** Serialized: concurrent callers share the running pass, which repeats once if asked again meanwhile. */
	private reconcile(): Promise<void> {
		if (this.reconciling) {
			this.reconcileAgain = true;
			return this.reconciling;
		}
		this.reconciling = (async () => {
			try {
				do {
					this.reconcileAgain = false;
					await this.reconcileOnce();
				} while (this.reconcileAgain);
			} finally {
				this.reconciling = undefined;
			}
		})();
		return this.reconciling;
	}

	private retire(cloud: CloudState, instance: InstanceRecord, reason: string, now: number, terminateAfter = now): void {
		if (!cloud.retired.some((r) => r.id === instance.id)) {
			cloud.retired.push({ id: instance.id, token: instance.token, reason, at: now, terminateAfter, stopped: false });
		}
		cloud.instance = undefined;
		cloud.idleSince = undefined;
	}

	private async reconcileOnce(): Promise<void> {
		const now = Date.now();
		const cloud = this.loadCloud();
		const demand = this.hasDemand(now, cloud);
		if (this.localMode) return;
		if (!cloud.instance && cloud.retired.length === 0 && !cloud.migration && !demand) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const settings = this.settings();
		this.concurrentCloudChanges = [];
		try {
			const tc = this.tencent();
			const instances = await describeTaggedInstances(tc, TAG_KEY, this.namePrefix);
			const disk = cloud.disk ? await describeDisk(tc, cloud.disk.id) : undefined;
			if (cloud.disk && !disk) throw new Error(`data disk ${cloud.disk.id} no longer exists; refusing to continue`);
			this.adoptStrays(cloud, instances, disk, now);
			if (cloud.instance) await this.advanceInstance(tc, cloud, cloud.instance, instances, disk, demand, settings, now);
			await this.processRetired(tc, cloud, instances, disk, now);
			if (!cloud.instance && demand) await this.launch(tc, cloud, settings, disk, now);
		} catch (error) {
			cloud.lastError = { message: errorMessage(error), at: now };
			this.log("error", `reconcile: ${errorMessage(error)}`);
		}
		for (const [key, until] of Object.entries(cloud.cooldown)) if (until < now) delete cloud.cooldown[key];
		for (const change of this.concurrentCloudChanges) change(cloud);
		this.concurrentCloudChanges = undefined;
		this.saveCloud(cloud);
		this.scheduleBroadcast();

		const transitioning =
			cloud.migration !== undefined ||
			cloud.retired.length > 0 ||
			(cloud.instance !== undefined && (cloud.instance.phase !== "running" || !this.agentSocket(cloud.instance.id)));
		if (transitioning) await this.ctx.storage.setAlarm(now + 10_000);
		else if (!cloud.instance && demand) await this.ctx.storage.setAlarm(now + (cloud.noCapacitySince ? 60_000 : 15_000));
		else if (cloud.instance) await this.ctx.storage.setAlarm(now + 30_000);
		else await this.ctx.storage.deleteAlarm();
	}

	/** Tagged instances the Hub does not track (or that hold the data disk) are retired and terminated. */
	private adoptStrays(cloud: CloudState, instances: Map<string, InstanceInfo>, disk: DiskInfo | undefined, now: number): void {
		const known = new Set([cloud.instance?.id, ...cloud.retired.map((r) => r.id)]);
		for (const info of instances.values()) {
			if (known.has(info.id) || info.state === "TERMINATING" || info.state === "SHUTDOWN") continue;
			cloud.retired.push({ id: info.id, reason: "untracked instance", at: now, terminateAfter: now, stopped: false });
			this.log("warn", `terminating untracked instance ${info.id}`);
		}
		if (disk?.instanceId && !known.has(disk.instanceId) && !instances.has(disk.instanceId)) {
			cloud.retired.push({ id: disk.instanceId, reason: "holds the data disk", at: now, terminateAfter: now, stopped: false });
			this.log("warn", `instance ${disk.instanceId} holds the data disk; detaching`);
		}
	}

	private async advanceInstance(
		tc: TencentCloud,
		cloud: CloudState,
		instance: InstanceRecord,
		instances: Map<string, InstanceInfo>,
		disk: DiskInfo | undefined,
		demand: boolean,
		settings: Settings,
		now: number,
	): Promise<void> {
		const info = instances.get(instance.id);
		if (!info) {
			// DescribeInstances lags behind RunInstances for a short while.
			if (now - instance.launchedAt > VANISH_GRACE_MS) {
				this.log("warn", `instance ${instance.id} vanished (likely reclaimed)`);
				cloud.cooldown[`${instance.zone}/${instance.type}`] = now + COOLDOWN_MS;
				this.retire(cloud, instance, "vanished", now);
			}
			return;
		}
		if (DEAD_STATES.has(info.state)) {
			this.log("warn", `instance ${instance.id} is ${info.state}; replacing it`);
			cloud.cooldown[`${instance.zone}/${instance.type}`] = now + COOLDOWN_MS;
			this.retire(cloud, instance, `instance ${info.state}`, now);
			return;
		}
		if (instance.phase === "launching" || instance.phase === "booting") {
			if (info.state !== "RUNNING") return;
			instance.phase = "attaching";
		}
		if (instance.phase === "attaching") {
			if (disk?.instanceId === instance.id) {
				if (disk.state === "ATTACHED") {
					if (disk.deleteWithInstance) await keepDiskOnTermination(tc, disk.id);
					instance.phase = "running";
					this.log("info", `data disk attached to ${instance.id}; waiting for the agent`);
				}
			} else if (disk && !disk.instanceId && disk.state === "UNATTACHED") {
				if (!instance.attachRequestedAt || now - instance.attachRequestedAt > 60_000) {
					await attachDisk(tc, disk.id, instance.id);
					instance.attachRequestedAt = now;
					this.log("info", `attaching data disk ${disk.id} to ${instance.id}`);
				}
			}
			if (now - instance.launchedAt > BOOT_TIMEOUT_MS) {
				this.log("error", `instance ${instance.id} did not get its disk in time`);
				this.retire(cloud, instance, "attach timeout", now);
			}
			return;
		}
		if (instance.phase === "running") {
			if (!instance.connectedAt) {
				if (now - instance.launchedAt > BOOT_TIMEOUT_MS) {
					this.log("error", `agent on ${instance.id} never connected; see /var/log/pi-spot-bootstrap.log`);
					this.retire(cloud, instance, "boot timeout", now);
				}
				return;
			}
			if (!this.agentSocket(instance.id)) {
				instance.disconnectedAt ??= now;
				if (now - instance.disconnectedAt > AGENT_LOST_MS) {
					this.log("error", `agent on ${instance.id} lost for 5 minutes; replacing the instance`);
					this.retire(cloud, instance, "agent lost", now);
				}
				return;
			}
			instance.disconnectedAt = undefined;
			if (demand) {
				cloud.idleSince = undefined;
				return;
			}
			cloud.idleSince ??= now;
			if (now - cloud.idleSince >= settings.idleMinutes * 60_000) {
				instance.phase = "draining";
				instance.drainStartedAt = now;
				this.sendToAgent({ t: "shutdown", reason: `idle for ${settings.idleMinutes} minutes` });
				this.log("info", `all sessions idle; shutting down ${instance.id}`);
			}
			return;
		}
		if (instance.phase === "draining" && now - (instance.drainStartedAt ?? now) > DRAIN_TIMEOUT_MS) {
			this.retire(cloud, instance, "drain timeout", now);
		}
	}

	/** Detach the data disk from each retired instance, then terminate it. */
	private async processRetired(
		tc: TencentCloud,
		cloud: CloudState,
		instances: Map<string, InstanceInfo>,
		disk: DiskInfo | undefined,
		now: number,
	): Promise<void> {
		for (const retired of [...cloud.retired]) {
			try {
				await this.processRetiredOne(tc, cloud, retired, instances.get(retired.id), disk, now);
			} catch (error) {
				this.log("warn", `retiring ${retired.id}: ${errorMessage(error)}`);
			}
		}
	}

	private async processRetiredOne(
		tc: TencentCloud,
		cloud: CloudState,
		retired: RetiredInstance,
		info: InstanceInfo | undefined,
		disk: DiskInfo | undefined,
		now: number,
	): Promise<void> {
		const heldDisk = disk?.instanceId === retired.id ? disk : undefined;
		const gone = !info || info.state === "TERMINATING" || info.state === "SHUTDOWN";
		if (gone && !heldDisk) {
			if (now - retired.at > VANISH_GRACE_MS) cloud.retired = cloud.retired.filter((r) => r !== retired);
			return;
		}
		if (!retired.stopped && now < retired.terminateAfter) return;
		if (heldDisk && heldDisk.state === "ATTACHED") {
			if (retired.detachRequestedAt && now - retired.detachRequestedAt < 120_000) return;
			retired.detachRequestedAt = now;
			try {
				await detachDisk(tc, heldDisk.id, retired.id);
				this.log("info", `detaching data disk from ${retired.id}`);
				return;
			} catch (error) {
				this.log("warn", `detach from ${retired.id} failed (${errorMessage(error)}); terminating instead`);
			}
		} else if (heldDisk) {
			return;
		}
		if (gone) return;
		if (!retired.terminateRequestedAt || now - retired.terminateRequestedAt > 300_000) {
			retired.terminateRequestedAt = now;
			await terminateInstance(tc, retired.id);
			this.log("info", `terminating ${retired.id} (${retired.reason})`);
		}
	}

	private async launch(
		tc: TencentCloud,
		cloud: CloudState,
		settings: Settings,
		disk: DiskInfo | undefined,
		now: number,
	): Promise<void> {
		const excluded = (zone: string, type: string) => (cloud.cooldown[`${zone}/${type}`] ?? 0) > now;
		if (cloud.migration) return this.advanceMigration(tc, cloud, disk, now);
		if (!cloud.disk) {
			const anywhere = await listSpotCandidates(tc, settings, settings.zones, excluded);
			if (!anywhere[0]) throw new Error("No spot instance type in the region matches the settings");
			const zone = anywhere[0].zone;
			const id = await createDisk(tc, {
				zone,
				sizeGb: settings.dataDiskGb,
				diskType: this.env.DATA_DISK_TYPE || "CLOUD_BSSD",
				name: `${this.namePrefix}-data`,
				tag: { key: TAG_KEY, value: this.namePrefix },
			});
			cloud.disk = { id, zone, sizeGb: settings.dataDiskGb, formatted: false };
			this.log("info", `created data disk ${id} (${settings.dataDiskGb} GB) in ${zone}`);
		}
		const zone = cloud.disk.zone;
		const candidates = await listSpotCandidates(tc, settings, [zone], excluded);
		if (candidates.length === 0) {
			cloud.noCapacitySince ??= now;
			cloud.lastError = { message: `No spot instance type in ${zone} matches the settings right now`, at: now };
			if (now - cloud.noCapacitySince > MIGRATE_AFTER_MS && this.env.ALLOW_ZONE_MIGRATION !== "false") {
				const elsewhere = (await listSpotCandidates(tc, settings, settings.zones, excluded)).filter((c) => c.zone !== zone);
				if (elsewhere[0]) {
					cloud.migration = { fromDiskId: cloud.disk.id, toZone: elsewhere[0].zone, startedAt: now };
					this.log("warn", `no capacity in ${zone} for ${Math.round((now - cloud.noCapacitySince) / 60_000)} min; moving the data disk to ${elsewhere[0].zone}`);
				}
			}
			return;
		}

		cloud.securityGroupId ??= this.env.SECURITY_GROUP_ID || (await ensureSecurityGroup(tc, `${this.namePrefix}-agent`, this.env.SSH_CIDR));
		let subnet = this.env.VPC_ID && this.env.SUBNET_ID ? { vpcId: this.env.VPC_ID, subnetId: this.env.SUBNET_ID } : cloud.subnets[zone];
		if (!subnet) {
			subnet = (await ensureDefaultSubnet(tc, zone)) ?? "classic";
			cloud.subnets[zone] = subnet;
		}
		if (!cloud.image || now - cloud.image.resolvedAt > 86_400_000) {
			cloud.image = { id: this.env.IMAGE_ID || (await findUbuntuImage(tc)), resolvedAt: now };
		}
		const hubUrl = this.publicUrl();
		if (!hubUrl) throw new Error("Open the control panel once so the Worker learns its URL, or set PUBLIC_URL");

		for (const candidate of candidates.slice(0, 4)) {
			const token = randomHex(32);
			const script = bootstrapScript({
				hubUrl,
				agentToken: token,
				diskId: cloud.disk.id,
				formatIfEmpty: !cloud.disk.formatted,
				nodeMajor: envNumber(this.env.NODE_MAJOR, 24),
				agentSudo: this.env.AGENT_SUDO !== "false",
			});
			try {
				const id = await runSpotInstance(tc, {
					zone,
					instanceType: candidate.instanceType,
					imageId: cloud.image.id,
					...(subnet === "classic" ? {} : { subnet }),
					securityGroupId: cloud.securityGroupId,
					userData: encodeUserData(script),
					name: `${this.namePrefix}-agent`,
					maxPrice: settings.maxHourlyPrice,
					keyIds: (this.env.KEY_IDS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
					bandwidthMbps: settings.bandwidthMbps,
					systemDiskType: this.env.SYSTEM_DISK_TYPE || "CLOUD_BSSD",
					systemDiskGb: envNumber(this.env.SYSTEM_DISK_GB, 50),
					clientToken: crypto.randomUUID(),
					tag: { key: TAG_KEY, value: this.namePrefix },
				});
				cloud.instance = {
					id,
					zone,
					type: candidate.instanceType,
					cpu: candidate.cpu,
					memoryGb: candidate.memoryGb,
					hourlyPrice: candidate.hourlyPrice,
					token,
					phase: "booting",
					launchedAt: now,
				};
				cloud.noCapacitySince = undefined;
				cloud.lastError = undefined;
				const price = candidate.hourlyPrice === null ? "" : ` at ${candidate.hourlyPrice}/h`;
				this.log("info", `launched ${id}: ${candidate.instanceType} (${candidate.cpu} vCPU, ${candidate.memoryGb} GB) in ${zone}${price}`);
				return;
			} catch (error) {
				this.log("warn", `launching ${candidate.instanceType} in ${zone} failed: ${errorMessage(error)}`);
				if (isGlobalLaunchError(error)) {
					cloud.lastError = { message: errorMessage(error), at: now };
					return;
				}
				cloud.cooldown[`${zone}/${candidate.instanceType}`] = now + COOLDOWN_MS;
			}
		}
		cloud.noCapacitySince ??= now;
	}

	/** Moves the data disk to another zone through a snapshot; the old disk and snapshot are kept for manual cleanup. */
	private async advanceMigration(tc: TencentCloud, cloud: CloudState, disk: DiskInfo | undefined, now: number): Promise<void> {
		const migration = cloud.migration!;
		const current = cloud.disk!;
		if (!migration.snapshotId) {
			if (disk?.instanceId) return;
			migration.snapshotId = await createSnapshot(tc, migration.fromDiskId, `${this.namePrefix}-move-${now}`);
			this.log("info", `snapshotting ${migration.fromDiskId} as ${migration.snapshotId}`);
			return;
		}
		if (!migration.newDiskId) {
			if ((await snapshotState(tc, migration.snapshotId)) !== "NORMAL") return;
			migration.newDiskId = await createDisk(tc, {
				zone: migration.toZone,
				sizeGb: current.sizeGb,
				diskType: this.env.DATA_DISK_TYPE || "CLOUD_BSSD",
				name: `${this.namePrefix}-data`,
				tag: { key: TAG_KEY, value: this.namePrefix },
				snapshotId: migration.snapshotId,
			});
			this.log("info", `creating ${migration.newDiskId} in ${migration.toZone} from the snapshot`);
			return;
		}
		const created = await describeDisk(tc, migration.newDiskId);
		if (created?.state !== "UNATTACHED") return;
		cloud.orphans.push(
			{ kind: "disk", id: migration.fromDiskId, note: `old data disk, replaced by ${migration.newDiskId}` },
			{ kind: "snapshot", id: migration.snapshotId, note: "zone migration snapshot" },
		);
		cloud.disk = { id: migration.newDiskId, zone: migration.toZone, sizeGb: current.sizeGb, formatted: true };
		cloud.migration = undefined;
		cloud.noCapacitySince = undefined;
		cloud.cooldown = {};
		this.log("warn", `data disk moved to ${migration.toZone}; delete ${migration.fromDiskId} and ${migration.snapshotId} when satisfied`);
	}
}
