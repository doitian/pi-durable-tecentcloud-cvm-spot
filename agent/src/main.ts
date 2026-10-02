import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore, OAuthAuth } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type HubToAgent, PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { AGENT_VERSION, loadConfig } from "./config.ts";
import { deviceId, FileCredentialStore } from "./credentials.ts";
import { configureGit, pushWipSnapshot } from "./git.ts";
import { HubClient } from "./hub-client.ts";
import { LoginManager } from "./login.ts";
import { SessionManager } from "./sessions.ts";
import { watchSpotTermination } from "./spot.ts";

const context = BACKGROUND_CONTEXT;
const config = loadConfig();

// pi-ai loads OAuth flows through import() specifiers a bundler cannot follow; register them statically instead.
registerBunOAuthFlows();

// Seconds before the reclaim time at which the agent checkpoints and stops.
const RECLAIM_STOP_LEAD_MS = 60_000;

const credentials = new FileCredentialStore(join(config.agentDir, "auth.json"));
let manager: SessionManager | undefined;
let logins: LoginManager | undefined;
let stopping = false;

const wsUrl =
	`${config.hubUrl.replace(/^http/, "ws")}/api/agent/ws` +
	`?instance=${encodeURIComponent(config.instanceId)}&token=${encodeURIComponent(config.token)}`;

const hub = new HubClient(wsUrl, {
	onOpen: () => {
		console.log("connected to hub");
		hub.send({ t: "hello", protocol: PROTOCOL_VERSION, instanceId: config.instanceId, agentVersion: AGENT_VERSION });
	},
	onMessage: (message) => void handle(message).catch((error) => log("error", `handling ${message.t}: ${error}`)),
	onClose: () => undefined,
});

function log(level: "info" | "warn" | "error", message: string): void {
	(level === "error" ? console.error : level === "warn" ? console.warn : console.log)(message);
	hub.send({ t: "log", level, message });
}

/** A pretend OAuth provider for exercising the login plumbing locally. */
const fauxOAuth: OAuthAuth = {
	name: "Faux subscription (test)",
	isSubscription: true,
	async login(interaction) {
		interaction.notify({
			type: "auth_url",
			url: "https://example.com/oauth/authorize?client_id=faux",
			instructions: "Open the link, sign in, then paste the code it shows.",
		});
		const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
		interaction.notify({ type: "progress", message: "Exchanging the code for tokens..." });
		return { type: "oauth", access: `faux-${code}`, refresh: "faux-refresh", expires: Date.now() + 3_600_000 };
	},
	async refresh(credential) {
		return { ...credential, expires: Date.now() + 3_600_000 };
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

function createModels(store: CredentialStore): MutableModels {
	const models = builtinModels({ credentials: store });
	if (process.env.PI_FAUX === "1") {
		// A scripted model for local testing: one tool call per prompt (a subagent when asked to "delegate:", bash
		// otherwise), then a short answer.
		const faux = fauxProvider({ tokensPerSecond: 50 });
		const step = (ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
			const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
			if (last?.role !== "user") return fauxAssistantMessage("Done. The command ran on the agent machine.");
			const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
			const call = text.includes("delegate:")
				? fauxToolCall("subagent", { task: "child task: run the command" })
				: fauxToolCall("bash", { command: "sleep 8; echo hello from $(hostname); ls -la | head -5" });
			return fauxAssistantMessage(call, { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 10_000 }, () => step));
		models.setProvider({ ...faux.provider, auth: { ...faux.provider.auth, oauth: fauxOAuth } });
	}
	return models;
}

async function handle(message: HubToAgent): Promise<void> {
	if (stopping) return;
	switch (message.t) {
		case "welcome": {
			if (!manager) {
				Object.assign(process.env, message.env);
				await configureGit().catch((error) => log("warn", `git setup: ${error}`));
				const models = createModels(credentials);
				logins = new LoginManager(
					models,
					credentials,
					(login) => void hub.send(login),
					() => deviceId(config.agentDir),
					() => void publishAuth(),
				);
				manager = new SessionManager(
					config,
					models,
					{
						events: (sessionId, events) => void hub.sendEvents(sessionId, events),
						status: (session) => void hub.send({ t: "status", session }),
						ack: (sessionId, requestId, error) =>
							void hub.send({ t: "ack", sessionId, requestId, ...(error ? { error } : {}) }),
						log,
					},
					context,
				);
			}
			manager.sync(message.sessions);
			for (const input of message.inputs) void manager.submit(input);
			for (const sessionId of message.aborts) void abort(sessionId);
			hub.send({ t: "ready", sessions: manager.reports() });
			await publishAuth();
			return;
		}
		case "session":
			manager?.upsert(message.session);
			return;
		case "input":
			await manager?.submit(message.input);
			return;
		case "abort":
			await abort(message.sessionId);
			return;
		case "resync":
			await manager?.resync(message.sessionId);
			return;
		case "compact":
			await manager?.compact(message.sessionId, message.instructions);
			log("info", `compaction requested for session ${message.sessionId}`);
			return;
		case "reset":
			await manager?.reset(message.sessionId, message.handoff);
			log("info", `new context started for session ${message.sessionId}`);
			return;
		case "shutdown":
			await stop(`shutdown: ${message.reason}`, false);
			return;
		case "login":
			void logins?.start(message.loginId, message.provider, message.type);
			return;
		case "login_reply":
			logins?.reply(message.loginId, message.promptId, message.value);
			return;
		case "login_cancel":
			logins?.cancel(message.loginId);
			return;
		case "logout":
			await logins?.logout(message.provider);
			log("info", `logged out of ${message.provider}`);
			return;
		case "pong":
			return;
	}
}

async function publishAuth(): Promise<void> {
	if (logins) hub.send({ t: "auth", ...(await logins.report()) });
}

async function abort(sessionId: string): Promise<void> {
	await manager?.abort(sessionId);
	hub.send({ t: "aborted", sessionId });
}

async function stop(reason: string, wipPush: boolean): Promise<void> {
	if (stopping) return;
	stopping = true;
	stopSpotWatch();
	log("info", `stopping (${reason})`);
	await manager?.closeAll();
	if (wipPush && process.env.PI_WIP_PUSH === "1") {
		for (const session of manager?.all ?? []) {
			await pushWipSnapshot(session.cwd, session.spec.id).catch((error) =>
				log("warn", `wip push ${session.spec.id}: ${error}`),
			);
		}
	}
	try {
		execFileSync("sync");
	} catch {
		// Not available on every platform.
	}
	hub.send({ t: "stopped", reason });
	await hub.close();
	process.exit(0);
}

const stopSpotWatch = watchSpotTermination(config.metadataUrl, config.spotPollMs, (time, raw) => {
	const delay = Math.max(0, time.getTime() - Date.now() - RECLAIM_STOP_LEAD_MS);
	log("warn", `spot reclaim scheduled at ${raw} (UTC+8); stopping in ${Math.round(delay / 1000)}s`);
	hub.send({ t: "reclaim", terminationTime: time.toISOString() });
	setTimeout(() => void stop("spot reclaim", true), delay);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop(signal, false));

hub.connect();
