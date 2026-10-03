// Messages exchanged between the Hub (Cloudflare Durable Object), the agent on the CVM, and the browser UI.
// Pi-durable agent events and entries travel as opaque JSON; only the browser interprets them.

export const PROTOCOL_VERSION = 2;

export interface ModelRef {
	provider: string;
	modelId: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** "auto" runs every tool call; "ask" holds calls that can change something until the user approves them. */
export type ApprovalMode = "auto" | "ask";

export interface SessionSpec {
	id: string;
	title: string;
	repoUrl?: string;
	branch?: string;
	model: ModelRef;
	thinkingLevel?: ThinkingLevel;
	instructions?: string;
	/** Absent means "auto". */
	approvalMode?: ApprovalMode;
}

export interface McpServerStatus {
	name: string;
	state: "connecting" | "connected" | "failed";
	tools: number;
	error?: string;
}

/** pi's credentials (`{ [providerId]: Credential }`) and the installation ID login flows send; kept by the Hub. */
export interface SavedCredentials {
	data: Record<string, unknown>;
	deviceId: string;
}

export interface PendingInput {
	sessionId: string;
	requestId: string;
	content: string;
	whenBusy: "steer" | "followUp";
}

export interface SessionReport {
	sessionId: string;
	busy: boolean;
	ready: boolean;
	error?: string;
	costUsd?: number;
	/** Tool calls held for the user's approval. */
	awaitingApproval?: number;
	mcp?: McpServerStatus[];
}

/** One model provider as the agent sees it; never carries secrets. */
export interface AuthProviderInfo {
	id: string;
	name: string;
	oauth?: { name: string; subscription: boolean };
	apiKeyLogin: boolean;
	/** Set when requests to this provider would be authenticated, e.g. `{ type: "oauth", source: "OAuth" }`. */
	configured?: { type: "api_key" | "oauth"; source?: string };
	/** Credential saved by the control panel (the only kind Log out removes). */
	stored?: "api_key" | "oauth";
}

/** A chat model whose provider has a usable credential (subscription plans filter what they offer). */
export interface AvailableModel {
	provider: string;
	providerName: string;
	id: string;
	name: string;
}

export interface AuthReport {
	providers: AuthProviderInfo[];
	models: AvailableModel[];
}

/** What a login flow shows the user; mirrors pi-ai's AuthEvent. */
export type LoginEvent =
	| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { type: "progress"; message: string };

/** What a login flow asks the user; mirrors pi-ai's AuthPrompt without its signal. */
export type LoginPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };

export type LoginMessage =
	| { t: "login_event"; loginId: string; event: LoginEvent }
	| { t: "login_prompt"; loginId: string; promptId: string; prompt: LoginPrompt }
	| { t: "login_prompt_closed"; loginId: string; promptId: string }
	| { t: "login_done"; loginId: string; ok: boolean; error?: string };

export type AgentToHub =
	| { t: "hello"; protocol: number; instanceId: string; agentVersion: string }
	| { t: "ready"; sessions: SessionReport[] }
	| { t: "status"; session: SessionReport }
	| { t: "events"; sessionId: string; events: unknown[] }
	| { t: "ack"; sessionId: string; requestId: string; error?: string }
	| { t: "aborted"; sessionId: string }
	| { t: "purged"; sessionIds: string[] }
	| { t: "reclaim"; terminationTime: string }
	| { t: "stopped"; reason: string }
	| { t: "log"; level: "info" | "warn" | "error"; message: string }
	| ({ t: "auth" } & AuthReport)
	/** The whole credential set after every change; resent after a reconnect until the Hub confirms `revision`. */
	| { t: "credentials"; revision: number; credentials: SavedCredentials }
	/** A tool call waits for the user; sent again after a reconnect or from the next VM while it still waits. */
	| { t: "approval_request"; sessionId: string; approvalId: string; toolName: string; preview: string }
	/** The call received its answer and recorded it; the Hub forgets the request. */
	| { t: "approval_settled"; sessionId: string; approvalId: string }
	| LoginMessage
	/** Terminal output, base64 because it is raw PTY bytes. */
	| { t: "term_output"; termId: string; data: string }
	| { t: "term_exit"; termId: string; code: number | null; error?: string }
	| { t: "ping" };

export type HubToAgent =
	| {
			t: "welcome";
			env: Record<string, string>;
			sessions: SessionSpec[];
			inputs: PendingInput[];
			/** Sessions whose abort was requested while no agent was connected. */
			aborts: string[];
			/** Deleted sessions whose files are still on the data disk. */
			purges: string[];
			/** Null until an agent first saved credentials. */
			credentials: SavedCredentials | null;
	  }
	| { t: "credentials_saved"; revision: number }
	| { t: "approval_reply"; sessionId: string; approvalId: string; approve: boolean; reason?: string }
	/** Reconnect the session's MCP servers after their configuration changed. */
	| { t: "mcp_reload"; sessionId: string }
	| { t: "session"; session: SessionSpec }
	| { t: "input"; input: PendingInput }
	| { t: "abort"; sessionId: string }
	/** Restart one session's event stream so a newly attached browser gets a full snapshot. */
	| { t: "resync"; sessionId: string }
	| { t: "compact"; sessionId: string; instructions?: string }
	/** Archived: close the session; its files stay. */
	| { t: "close_session"; sessionId: string }
	/** Deleted: close the sessions and remove their state, workspaces and tmux sessions. */
	| { t: "purge"; sessionIds: string[] }
	| { t: "reset"; sessionId: string; handoff?: string }
	| { t: "shutdown"; reason: string }
	| { t: "login"; loginId: string; provider: string; type: "oauth" | "api_key" }
	| { t: "login_reply"; loginId: string; promptId: string; value: string }
	| { t: "login_cancel"; loginId: string }
	| { t: "logout"; provider: string }
	/** Opens a shell attached to the tmux session of `sessionId`, or the VM-wide one when null. */
	| { t: "term_open"; termId: string; sessionId: string | null; cols: number; rows: number }
	| { t: "term_input"; termId: string; data: string }
	| { t: "term_resize"; termId: string; cols: number; rows: number }
	| { t: "term_close"; termId: string }
	| { t: "pong" };

export type InstancePhase = "launching" | "booting" | "attaching" | "running" | "draining";

export interface InstanceView {
	id: string;
	zone: string;
	type: string;
	cpu: number;
	memoryGb: number;
	hourlyPrice?: number;
	phase: InstancePhase;
	launchedAt: number;
	agentConnected: boolean;
	reclaimAt?: string;
}

export interface ApprovalView {
	id: string;
	toolName: string;
	/** The call's arguments as JSON, truncated. */
	preview: string;
	requestedAt: number;
	/** Set once the user answered while no VM could take the answer yet. */
	decision?: "approve" | "deny";
}

export interface SessionView {
	id: string;
	title: string;
	repoUrl?: string;
	model: ModelRef;
	thinkingLevel?: ThinkingLevel;
	approvalMode: ApprovalMode;
	createdAt: number;
	lastActivityAt: number;
	ready: boolean;
	busy: boolean;
	pendingInputs: number;
	approvals: ApprovalView[];
	error?: string;
	costUsd?: number;
	mcp?: McpServerStatus[];
}

export interface ArchivedSessionView {
	id: string;
	title: string;
	repoUrl?: string;
	model: ModelRef;
	createdAt: number;
	lastActivityAt: number;
	costUsd?: number;
}

export interface PanelState {
	instance?: InstanceView;
	sessions: SessionView[];
	archivedCount: number;
	disk?: { id: string; zone: string; sizeGb: number };
	/** Set while the data disk exists only as a snapshot. */
	archive?: { snapshotId: string; sizeGb: number; at: number };
	lastError?: { message: string; at: number };
	log: Array<{ at: number; level: string; message: string }>;
	/** Last provider list reported by an agent. */
	auth?: AuthReport & { at: number };
}

export type HubToUi =
	| { t: "state"; state: PanelState }
	| { t: "transcript"; sessionId: string; entries: unknown[]; snapshot?: unknown }
	| { t: "events"; sessionId: string; events: unknown[] }
	| LoginMessage;

/** Browser terminal socket (`/api/term/ws`) to the Hub; `data` is base64 of UTF-8 or raw bytes. */
export type TermToHub = { t: "input"; data: string } | { t: "resize"; cols: number; rows: number };

export type HubToTerm =
	| { t: "output"; data: string }
	| { t: "exit"; code: number | null; error?: string }
	| { t: "error"; message: string };

export type UiToHub =
	| { t: "subscribe"; sessionId: string | null }
	| { t: "login"; provider: string; type: "oauth" | "api_key" }
	| { t: "login_reply"; loginId: string; promptId: string; value: string }
	| { t: "login_cancel"; loginId: string }
	| { t: "logout"; provider: string };
