import { DurableObject } from "cloudflare:workers";
import type {
	AgentToHub,
	ApprovalMode,
	ApprovalView,
	ArchivedSessionView,
	AuthReport,
	HubToAgent,
	HubToTerm,
	HubToUi,
	InstancePhase,
	McpServerStatus,
	PanelState,
	SavedCredentials,
	SessionReport,
	SessionSpec,
	SessionView,
	TermToHub,
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
	deleteSnapshots,
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
	terminateDisk,
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
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TRANSCRIPT_LIMIT = 400;
/** A decision the session's run never picked up while the session sat idle this long is dropped. */
const STALE_DECISION_MS = 10 * 60_000;

export interface Settings {
	minCpu: number;
	minMemoryGb: number;
	maxHourlyPrice: number | null;
	category: Category;
	zones: string[];
	idleMinutes: number;
	dataDiskGb: number;
	/** Idle minutes before the data disk is snapshotted and deleted; null keeps it. */
	archiveAfterMinutes: number | null;
	bandwidthMbps: number;
	defaultModel: string;
	/** For new sessions that do not pick one; pi-durable itself defaults to "off". */
	defaultThinkingLevel: ThinkingLevel | null;
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
	/** Latest complete snapshot of the data disk; the disk is restored from it when no disk exists. */
	archive?: { snapshotId: string; sizeGb: number; at: number };
	/** Snapshot being taken of an idle disk. */
	archiving?: { snapshotId: string; startedAt: number };
	staleSnapshots?: string[];
	/** Since when the disk has had no instance and no work. */
	diskIdleSince?: number;
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
	awaiting: number;
	mcp: string | null;
};

type ApprovalRow = {
	id: string;
	session_id: string;
	tool_name: string;
	preview: string;
	requested_at: number;
	decision: "approve" | "deny" | null;
	reason: string | null;
	decided_at: number | null;
};

type SocketAttachment =
	| { kind: "agent"; instanceId: string }
	| { kind: "ui"; sessionId: string | null }
	| { kind: "term"; termId: string };

function clampDimension(value: string | null, fallback: number, min: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= min && parsed <= 1000 ? parsed : fallback;
}

export interface CreateSessionInput {
	title?: string;
	repoUrl?: string;
	branch?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	instructions?: string;
	prompt?: string;
}

function parseModel(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash <= 0) throw new Error(`Model must look like provider/modelId, got "${value}"`);
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function parseApprovalMode(value: string | undefined): ApprovalMode {
	if (value === undefined || value === "" || value === "auto") return "auto";
	if (value === "ask") return "ask";
	throw new Error(`Unknown approval mode "${value}"`);
}

function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
	if (value === null || value === undefined || value === "") return null;
	if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error(`Unknown thinking level "${value}"`);
	return value as ThinkingLevel;
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
				pending_abort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
				awaiting INTEGER NOT NULL DEFAULT 0, mcp TEXT);
			CREATE TABLE IF NOT EXISTS inputs (
				request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, when_busy TEXT NOT NULL,
				created_at INTEGER NOT NULL, acked_at INTEGER, error TEXT);
			CREATE TABLE IF NOT EXISTS entries (
				session_id TEXT NOT NULL, entry_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, entry_id));
			CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL,
				message TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS purges (session_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS approvals (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, preview TEXT NOT NULL,
				requested_at INTEGER NOT NULL, decision TEXT, reason TEXT, decided_at INTEGER);
		`);
		const columns = new Set(
			this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('sessions')").toArray().map((column) => column.name),
		);
		if (!columns.has("awaiting")) this.sql.exec("ALTER TABLE sessions ADD COLUMN awaiting INTEGER NOT NULL DEFAULT 0");
		if (!columns.has("mcp")) this.sql.exec("ALTER TABLE sessions ADD COLUMN mcp TEXT");
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
			dataDiskGb: envNumber(env.DATA_DISK_GB, 30),
			archiveAfterMinutes: env.ARCHIVE_AFTER_MINUTES === "" ? null : envNumber(env.ARCHIVE_AFTER_MINUTES, 30),
			bandwidthMbps: envNumber(env.BANDWIDTH_MBPS, 100),
			defaultModel: env.DEFAULT_MODEL || "anthropic/claude-sonnet-5",
			defaultThinkingLevel: parseThinkingLevel(env.DEFAULT_THINKING_LEVEL ?? "medium"),
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

	/** A session whose run only waits for the user's approval is no reason to keep, or start, a VM. */
	private hasDemand(now: number, cloud: CloudState): boolean {
		if ((cloud.manualUntil ?? 0) > now || this.activeLogins.size > 0) return true;
		const sessions = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM sessions
				 WHERE archived = 0 AND ((busy = 1 AND awaiting = 0) OR (ready = 0 AND error IS NULL))`,
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
		if (patch.archiveAfterMinutes !== undefined) {
			next.archiveAfterMinutes =
				patch.archiveAfterMinutes === null || String(patch.archiveAfterMinutes) === "" ? null : Math.max(0, Number(patch.archiveAfterMinutes));
		}
		if (patch.bandwidthMbps !== undefined) next.bandwidthMbps = Math.max(1, Number(patch.bandwidthMbps));
		if (patch.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = parseThinkingLevel(patch.defaultThinkingLevel);
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
			...((input.thinkingLevel || settings.defaultThinkingLevel)
				? { thinkingLevel: parseThinkingLevel(input.thinkingLevel || settings.defaultThinkingLevel)! }
				: {}),
			...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
			...(parseApprovalMode(input.approvalMode) === "ask" ? { approvalMode: "ask" as const } : {}),
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

	/**
	 * Switches the model, thinking level or approval mode from the next request on; an offline session picks it up when
	 * the VM starts. Switching to "auto" approves the calls already waiting.
	 */
	async updateSessionAgent(
		sessionId: string,
		change: { model?: string; thinkingLevel?: string; approvalMode?: string },
	): Promise<void> {
		const row = this.sql
			.exec<{ spec: string }>("SELECT spec FROM sessions WHERE id = ? AND archived = 0", sessionId)
			.toArray()[0];
		if (!row) throw new Error("unknown session");
		const spec: SessionSpec = JSON.parse(row.spec) as SessionSpec;
		if (change.model) spec.model = parseModel(change.model);
		if (change.thinkingLevel) spec.thinkingLevel = parseThinkingLevel(change.thinkingLevel)!;
		if (change.approvalMode !== undefined) {
			if (parseApprovalMode(change.approvalMode) === "ask") spec.approvalMode = "ask";
			else delete spec.approvalMode;
		}
		this.sql.exec("UPDATE sessions SET spec = ? WHERE id = ?", JSON.stringify(spec), sessionId);
		this.sendToAgent({ t: "session", session: spec });
		if (spec.approvalMode !== "ask") {
			for (const approval of this.approvalRows(sessionId)) if (!approval.decision) this.decide(approval, true);
		}
		this.log(
			"info",
			`session "${spec.title}" now uses ${spec.model.provider}/${spec.model.modelId}, thinking ${spec.thinkingLevel ?? "off"}, approvals ${spec.approvalMode ?? "auto"}`,
		);
		await this.ensureAlarm(0);
	}

	private approvalRows(sessionId?: string): ApprovalRow[] {
		return sessionId === undefined
			? this.sql.exec<ApprovalRow>("SELECT * FROM approvals ORDER BY requested_at").toArray()
			: this.sql.exec<ApprovalRow>("SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at", sessionId).toArray();
	}

	/** Records the answer and passes it on; without an agent online, the next VM gets it when the call asks again. */
	private decide(approval: ApprovalRow, approve: boolean, reason?: string): void {
		const now = Date.now();
		this.sql.exec(
			"UPDATE approvals SET decision = ?, reason = ?, decided_at = ? WHERE id = ?",
			approve ? "approve" : "deny",
			reason ?? null,
			now,
			approval.id,
		);
		// The run continues, so the session counts as working again until the agent reports otherwise.
		this.sql.exec("UPDATE sessions SET awaiting = MAX(awaiting - 1, 0), last_activity_at = ? WHERE id = ?", now, approval.session_id);
		this.sendToAgent({
			t: "approval_reply",
			sessionId: approval.session_id,
			approvalId: approval.id,
			approve,
			...(reason ? { reason } : {}),
		});
		this.log("info", `${approve ? "approved" : "denied"} ${approval.tool_name} in session ${approval.session_id}`);
		this.scheduleBroadcast();
	}

	async answerApproval(sessionId: string, approvalId: string, approve: boolean, reason?: string): Promise<void> {
		const approval = this.approvalRows(sessionId).find((row) => row.id === approvalId);
		if (!approval) throw new Error("This call no longer waits for approval.");
		if (approval.decision) return;
		this.decide(approval, approve, reason?.trim() || undefined);
		await this.ensureAlarm(0);
	}

	private dropApprovals(sessionId: string): void {
		this.sql.exec("DELETE FROM approvals WHERE session_id = ?", sessionId);
		this.sql.exec("UPDATE sessions SET awaiting = 0 WHERE id = ?", sessionId);
	}

	/** Reconnects the session's MCP servers, rereading `mcp.json`. */
	async reloadMcp(sessionId: string): Promise<void> {
		if (!this.sendToAgent({ t: "mcp_reload", sessionId })) throw new Error("No VM is online. Start it first.");
	}

	/** Summarizes the session's older context now instead of waiting for automatic compaction. */
	async compactSession(sessionId: string, instructions?: string): Promise<void> {
		if (!this.sendToAgent({ t: "compact", sessionId, ...(instructions?.trim() ? { instructions: instructions.trim() } : {}) })) {
			throw new Error("No VM is online. Start it first.");
		}
	}

	/** Starts a fresh context for the session, optionally from a handoff note; its history stays stored. */
	async resetSession(sessionId: string, handoff?: string): Promise<void> {
		if (!this.sendToAgent({ t: "reset", sessionId, ...(handoff?.trim() ? { handoff: handoff.trim() } : {}) })) {
			throw new Error("No VM is online. Start it first.");
		}
		this.log("info", `new context requested for session ${sessionId}`);
	}

	async abortSession(sessionId: string): Promise<void> {
		this.sql.exec("DELETE FROM inputs WHERE session_id = ? AND acked_at IS NULL", sessionId);
		this.dropApprovals(sessionId);
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
		this.sendToAgent({ t: "close_session", sessionId });
		this.sql.exec("UPDATE sessions SET archived = 1, busy = 0 WHERE id = ?", sessionId);
		this.sql.exec("DELETE FROM inputs WHERE session_id = ? AND acked_at IS NULL", sessionId);
		this.dropApprovals(sessionId);
		this.log("info", `session ${sessionId} archived (its files stay on the data disk)`);
		await this.ensureAlarm(0);
	}

	async archivedSessions(): Promise<ArchivedSessionView[]> {
		return this.sql
			.exec<SessionRow>("SELECT * FROM sessions WHERE archived = 1 ORDER BY last_activity_at DESC")
			.toArray()
			.map((row) => {
				const spec = JSON.parse(row.spec) as SessionSpec;
				return {
					id: spec.id,
					title: spec.title,
					...(spec.repoUrl ? { repoUrl: spec.repoUrl } : {}),
					model: spec.model,
					createdAt: row.created_at,
					lastActivityAt: row.last_activity_at,
					costUsd: row.cost,
				};
			});
	}

	private archivedIds(ids: readonly string[]): string[] {
		const wanted = new Set(ids);
		return this.sql
			.exec<{ id: string }>("SELECT id FROM sessions WHERE archived = 1")
			.toArray()
			.map((row) => row.id)
			.filter((id) => wanted.has(id));
	}

	/** Brings archived sessions back; an online agent reopens them at once, otherwise the next VM does. */
	async unarchiveSessions(ids: readonly string[]): Promise<number> {
		const resumed = this.archivedIds(ids);
		for (const id of resumed) {
			this.sql.exec("UPDATE sessions SET archived = 0, pending_abort = 0, last_activity_at = ? WHERE id = ?", Date.now(), id);
			const row = this.sql.exec<{ spec: string }>("SELECT spec FROM sessions WHERE id = ?", id).one();
			this.sendToAgent({ t: "session", session: JSON.parse(row.spec) as SessionSpec });
		}
		if (resumed.length > 0) this.log("info", `${resumed.length} archived session(s) resumed`);
		this.scheduleBroadcast();
		return resumed.length;
	}

	/**
	 * Forgets archived sessions and deletes their files from the data disk: pi-durable state, workspace (uncommitted
	 * changes included) and tmux session. With no agent online the file deletion waits for the next VM.
	 */
	async deleteSessions(ids: readonly string[]): Promise<number> {
		const deleted = this.archivedIds(ids);
		if (deleted.length === 0) return 0;
		const now = Date.now();
		for (const id of deleted) {
			this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
			this.sql.exec("DELETE FROM inputs WHERE session_id = ?", id);
			this.sql.exec("DELETE FROM entries WHERE session_id = ?", id);
			this.sql.exec("DELETE FROM approvals WHERE session_id = ?", id);
			this.sql.exec("INSERT OR REPLACE INTO purges (session_id, requested_at) VALUES (?, ?)", id, now);
		}
		const sent = this.sendToAgent({ t: "purge", sessionIds: deleted });
		this.log("info", `${deleted.length} session(s) deleted${sent ? "" : "; their files are removed when the next VM starts"}`);
		this.scheduleBroadcast();
		return deleted.length;
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

	/**
	 * Deletes the data disk and its snapshots; the next start creates a fresh one at the configured size. Everything on
	 * the disk goes: session state, workspaces and pi's user files. Sessions are archived because they cannot continue.
	 * Saved logins stay; the Hub keeps them.
	 */
	async deleteDataDisk(): Promise<void> {
		const cloud = this.loadCloud();
		if (cloud.instance || cloud.retired.length > 0) throw new Error("Stop the VM and wait until it is gone first.");
		const tc = this.tencent();
		if (cloud.disk) {
			const disk = await describeDisk(tc, cloud.disk.id);
			if (disk?.instanceId) throw new Error(`The data disk is still attached to ${disk.instanceId}.`);
			if (disk) await terminateDisk(tc, cloud.disk.id);
		}
		const snapshots = [cloud.archive?.snapshotId, cloud.archiving?.snapshotId, ...(cloud.staleSnapshots ?? [])].filter(
			(id): id is string => id !== undefined,
		);
		await deleteSnapshots(tc, snapshots);
		this.updateCloud((current) => {
			current.disk = undefined;
			current.archive = undefined;
			current.archiving = undefined;
			current.staleSnapshots = [];
			current.diskIdleSince = undefined;
			current.migration = undefined;
		});
		this.sql.exec("UPDATE sessions SET archived = 1, awaiting = 0 WHERE archived = 0");
		this.sql.exec("DELETE FROM inputs WHERE acked_at IS NULL");
		this.sql.exec("DELETE FROM approvals");
		this.sql.exec("DELETE FROM purges");
		this.log("warn", `data disk ${cloud.disk?.id ?? "(none)"} and ${snapshots.length} snapshot(s) deleted; sessions archived`);
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
		} else if (url.pathname === "/api/term/ws") {
			// The Worker checked the admin token. Bytes are relayed, never stored or logged.
			const termId = crypto.randomUUID();
			const sessionId = url.searchParams.get("session") || null;
			this.ctx.acceptWebSocket(server, ["term", `term:${termId}`]);
			server.serializeAttachment({ kind: "term", termId } satisfies SocketAttachment);
			const opened = this.sendToAgent({
				t: "term_open",
				termId,
				sessionId,
				cols: clampDimension(url.searchParams.get("cols"), 80, 10),
				rows: clampDimension(url.searchParams.get("rows"), 24, 5),
			});
			if (!opened) {
				server.send(JSON.stringify({ t: "error", message: "No VM is online. Start it first." } satisfies HubToTerm));
				server.close(4002, "no agent");
			}
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
			else if (attachment.kind === "term") this.onTermMessage(attachment.termId, JSON.parse(data) as TermToHub);
			else this.onUiMessage(ws, JSON.parse(data) as UiToHub);
		} catch (error) {
			this.log("error", `websocket message: ${errorMessage(error)}`);
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = ws.deserializeAttachment() as SocketAttachment | null;
		if (attachment?.kind === "term") {
			// Detaches the tmux client; the tmux session keeps running on the VM.
			this.sendToAgent({ t: "term_close", termId: attachment.termId });
			return;
		}
		if (attachment?.kind !== "agent") return;
		this.log("warn", `agent ${attachment.instanceId} disconnected (${code} ${reason})`);
		if (attachment.instanceId === this.currentInstanceId()) {
			for (const terminal of this.ctx.getWebSockets("term")) {
				this.sendToTerm(terminal, { t: "error", message: "The agent disconnected." });
				terminal.close(4003, "agent disconnected");
			}
		}
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

	private onTermMessage(termId: string, message: TermToHub): void {
		if (message.t === "input") this.sendToAgent({ t: "term_input", termId, data: message.data });
		else if (message.t === "resize") {
			this.sendToAgent({
				t: "term_resize",
				termId,
				cols: clampDimension(String(message.cols), 80, 10),
				rows: clampDimension(String(message.rows), 24, 5),
			});
		}
	}

	private sendToTerm(ws: WebSocket | undefined, message: HubToTerm): void {
		try {
			ws?.send(JSON.stringify(message));
		} catch {
			// The browser went away; its close handler detaches the shell.
		}
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
				const purges = this.sql
					.exec<{ session_id: string }>("SELECT session_id FROM purges")
					.toArray()
					.map((row) => row.session_id);
				const welcome: HubToAgent = {
					t: "welcome",
					env: this.agentEnv(),
					sessions: this.specs(),
					inputs: this.pendingInputs(),
					aborts,
					purges,
					credentials: this.getJson<SavedCredentials | null>("credentials", null),
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
			case "purged":
				for (const id of message.sessionIds) this.sql.exec("DELETE FROM purges WHERE session_id = ?", id);
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
			case "credentials":
				// Secrets: stored for the next agent, never logged or shown in the panel.
				this.putJson("credentials", message.credentials);
				ws.send(JSON.stringify({ t: "credentials_saved", revision: message.revision } satisfies HubToAgent));
				return;
			case "approval_request":
				this.onApprovalRequest(ws, message);
				return;
			case "approval_settled":
				this.sql.exec("DELETE FROM approvals WHERE id = ?", message.approvalId);
				this.scheduleBroadcast();
				return;
			case "login_event":
			case "login_prompt":
			case "login_prompt_closed":
				this.sendToUis(message);
				return;
			case "term_output":
				this.sendToTerm(this.ctx.getWebSockets(`term:${message.termId}`)[0], { t: "output", data: message.data });
				return;
			case "term_exit": {
				const terminal = this.ctx.getWebSockets(`term:${message.termId}`)[0];
				this.sendToTerm(terminal, { t: "exit", code: message.code, ...(message.error ? { error: message.error } : {}) });
				terminal?.close(1000, "shell exited");
				return;
			}
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

	private onApprovalRequest(ws: WebSocket, message: Extract<AgentToHub, { t: "approval_request" }>): void {
		const session = this.sql
			.exec<{ spec: string }>("SELECT spec FROM sessions WHERE id = ? AND archived = 0", message.sessionId)
			.toArray()[0];
		if (!session) return;
		const inserted = this.sql.exec(
			"INSERT OR IGNORE INTO approvals (id, session_id, tool_name, preview, requested_at) VALUES (?, ?, ?, ?, ?)",
			message.approvalId,
			message.sessionId,
			message.toolName,
			message.preview,
			Date.now(),
		).rowsWritten;
		const approval = this.approvalRows(message.sessionId).find((row) => row.id === message.approvalId)!;
		if (approval.decision) {
			ws.send(
				JSON.stringify({
					t: "approval_reply",
					sessionId: approval.session_id,
					approvalId: approval.id,
					approve: approval.decision === "approve",
					...(approval.reason ? { reason: approval.reason } : {}),
				} satisfies HubToAgent),
			);
		} else if ((JSON.parse(session.spec) as SessionSpec).approvalMode !== "ask") {
			this.decide(approval, true);
		} else if (inserted > 0) {
			this.log("info", `session ${message.sessionId} waits for approval of ${message.toolName}`);
		}
		this.scheduleBroadcast();
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
			`UPDATE sessions SET ready = ?, busy = ?, error = ?, cost = ?, awaiting = ?, mcp = ?,
			 last_activity_at = CASE WHEN ? = 1 THEN ? ELSE last_activity_at END WHERE id = ?`,
			report.ready ? 1 : 0,
			report.busy ? 1 : 0,
			report.error ?? null,
			report.costUsd ?? 0,
			report.awaitingApproval ?? 0,
			report.mcp ? JSON.stringify(report.mcp) : null,
			report.busy ? 1 : 0,
			now,
			report.sessionId,
		);
		if (report.ready && !report.busy) {
			// Nothing waits in an idle session. An unanswered request is asked again if it still matters, so only an
			// answer is kept a while: the session may have reported before its resumed call asked again.
			this.sql.exec(
				"DELETE FROM approvals WHERE session_id = ? AND (decision IS NULL OR decided_at < ?)",
				report.sessionId,
				now - STALE_DECISION_MS,
			);
		}
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
		const approvals = new Map<string, ApprovalView[]>();
		for (const row of this.approvalRows()) {
			const list = approvals.get(row.session_id) ?? [];
			list.push({
				id: row.id,
				toolName: row.tool_name,
				preview: row.preview,
				requestedAt: row.requested_at,
				...(row.decision ? { decision: row.decision } : {}),
			});
			approvals.set(row.session_id, list);
		}
		const sessions: SessionView[] = this.sessionRows().map((row) => {
			const spec = JSON.parse(row.spec) as SessionSpec;
			return {
				id: spec.id,
				title: spec.title,
				...(spec.repoUrl ? { repoUrl: spec.repoUrl } : {}),
				model: spec.model,
				...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
				approvalMode: spec.approvalMode ?? "auto",
				createdAt: row.created_at,
				lastActivityAt: row.last_activity_at,
				ready: row.ready === 1,
				busy: row.busy === 1,
				pendingInputs: pending.get(spec.id) ?? 0,
				approvals: approvals.get(spec.id) ?? [],
				...(row.error ? { error: row.error } : {}),
				costUsd: row.cost,
				...(row.mcp ? { mcp: JSON.parse(row.mcp) as McpServerStatus[] } : {}),
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
			archivedCount: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE archived = 1").one().n,
			...(cloud.disk ? { disk: { id: cloud.disk.id, zone: cloud.disk.zone, sizeGb: cloud.disk.sizeGb } } : {}),
			...(cloud.archive && !cloud.disk ? { archive: { snapshotId: cloud.archive.snapshotId, sizeGb: cloud.archive.sizeGb, at: cloud.archive.at } } : {}),
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
		const settings = this.settings();
		if (!cloud.instance && cloud.retired.length === 0 && !cloud.migration && !demand) {
			const pendingDiskWork = cloud.archiving !== undefined || (cloud.staleSnapshots?.length ?? 0) > 0;
			const archiveAt =
				cloud.disk && settings.archiveAfterMinutes !== null && cloud.diskIdleSince !== undefined
					? cloud.diskIdleSince + settings.archiveAfterMinutes * 60_000
					: undefined;
			const archiveDue = cloud.disk !== undefined && settings.archiveAfterMinutes !== null && (archiveAt === undefined || archiveAt <= now);
			if (!pendingDiskWork && !archiveDue) {
				if (archiveAt !== undefined) await this.ctx.storage.setAlarm(archiveAt);
				else await this.ctx.storage.deleteAlarm();
				return;
			}
		}
		this.concurrentCloudChanges = [];
		try {
			const tc = this.tencent();
			const instances = await describeTaggedInstances(tc, TAG_KEY, this.namePrefix);
			const disk = cloud.disk ? await describeDisk(tc, cloud.disk.id) : undefined;
			if (cloud.disk && !disk) throw new Error(`data disk ${cloud.disk.id} no longer exists; refusing to continue`);
			this.adoptStrays(cloud, instances, disk, now);
			if (cloud.instance) await this.advanceInstance(tc, cloud, cloud.instance, instances, disk, demand, settings, now);
			await this.processRetired(tc, cloud, instances, disk, now);
			await this.manageDiskArchive(tc, cloud, disk, demand, settings, now);
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
			cloud.archiving !== undefined ||
			cloud.retired.length > 0 ||
			(cloud.instance !== undefined && (cloud.instance.phase !== "running" || !this.agentSocket(cloud.instance.id)));
		if (transitioning) await this.ctx.storage.setAlarm(now + 10_000);
		else if (!cloud.instance && demand) await this.ctx.storage.setAlarm(now + (cloud.noCapacitySince ? 60_000 : 15_000));
		else if (cloud.instance) await this.ctx.storage.setAlarm(now + 30_000);
		else if (cloud.disk && cloud.diskIdleSince !== undefined && settings.archiveAfterMinutes !== null) {
			await this.ctx.storage.setAlarm(Math.max(now + 10_000, cloud.diskIdleSince + settings.archiveAfterMinutes * 60_000));
		} else await this.ctx.storage.deleteAlarm();
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
				const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE archived = 0 AND awaiting > 0").one().n;
				this.log(
					"info",
					waiting > 0
						? `${waiting} session(s) wait for approval and nothing else runs; shutting down ${instance.id} until you answer`
						: `all sessions idle; shutting down ${instance.id}`,
				);
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

	/**
	 * Snapshots the data disk once it has been idle for `archiveAfterMinutes`, then deletes it; `launch` restores it.
	 * The previous snapshot is deleted only after a newer one is complete.
	 */
	private async manageDiskArchive(
		tc: TencentCloud,
		cloud: CloudState,
		disk: DiskInfo | undefined,
		demand: boolean,
		settings: Settings,
		now: number,
	): Promise<void> {
		if (cloud.staleSnapshots?.length) {
			await deleteSnapshots(tc, cloud.staleSnapshots);
			this.log("info", `deleted old snapshot(s) ${cloud.staleSnapshots.join(", ")}`);
			cloud.staleSnapshots = [];
		}
		const idle = !demand && !cloud.instance && cloud.retired.length === 0 && !cloud.migration;
		if (cloud.archiving) {
			const state = await snapshotState(tc, cloud.archiving.snapshotId);
			if (state === "NORMAL") {
				const previous = cloud.archive?.snapshotId;
				cloud.archive = { snapshotId: cloud.archiving.snapshotId, sizeGb: cloud.disk?.sizeGb ?? 0, at: now };
				cloud.archiving = undefined;
				if (previous && previous !== cloud.archive.snapshotId) (cloud.staleSnapshots ??= []).push(previous);
				if (idle && cloud.disk && disk && !disk.instanceId && disk.state === "UNATTACHED") {
					await terminateDisk(tc, cloud.disk.id);
					this.log("info", `data disk ${cloud.disk.id} saved as snapshot ${cloud.archive.snapshotId} and deleted`);
					cloud.disk = undefined;
					cloud.diskIdleSince = undefined;
				} else {
					this.log("info", `snapshot ${cloud.archive.snapshotId} complete; keeping the disk because work arrived`);
				}
			} else if (state === undefined || /FAIL/i.test(state)) {
				this.log("error", `snapshot ${cloud.archiving.snapshotId} failed (${state ?? "missing"}); keeping the disk`);
				cloud.archiving = undefined;
			}
			return;
		}
		if (!idle || !cloud.disk || !disk || disk.instanceId || disk.state !== "UNATTACHED") {
			if (!idle) cloud.diskIdleSince = undefined;
			return;
		}
		if (settings.archiveAfterMinutes === null) return;
		cloud.diskIdleSince ??= now;
		if (now - cloud.diskIdleSince < settings.archiveAfterMinutes * 60_000) return;
		const snapshotId = await createSnapshot(tc, cloud.disk.id, `${this.namePrefix}-idle-${new Date(now).toISOString().slice(0, 16)}`);
		cloud.archiving = { snapshotId, startedAt: now };
		this.log("info", `data disk idle for ${settings.archiveAfterMinutes} min; snapshotting it as ${snapshotId}`);
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
			// A new or restored disk can go to whichever zone has the best matching capacity right now.
			const anywhere = await listSpotCandidates(tc, settings, settings.zones, excluded);
			if (!anywhere[0]) throw new Error("No spot instance type in the region matches the settings");
			const zone = anywhere[0].zone;
			const archive = cloud.archive;
			const sizeGb = Math.max(settings.dataDiskGb, archive?.sizeGb ?? 0);
			const id = await createDisk(tc, {
				zone,
				sizeGb,
				diskType: this.env.DATA_DISK_TYPE || "CLOUD_BSSD",
				name: `${this.namePrefix}-data`,
				tag: { key: TAG_KEY, value: this.namePrefix },
				...(archive ? { snapshotId: archive.snapshotId } : {}),
			});
			cloud.disk = { id, zone, sizeGb, formatted: archive !== undefined };
			cloud.diskIdleSince = undefined;
			this.log(
				"info",
				archive
					? `restoring data disk ${id} (${sizeGb} GB) in ${zone} from snapshot ${archive.snapshotId}`
					: `created data disk ${id} (${sizeGb} GB) in ${zone}`,
			);
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
