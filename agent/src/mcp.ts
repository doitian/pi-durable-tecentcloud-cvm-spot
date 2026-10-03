import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Compile } from "typebox/compile";
import type { McpServerStatus } from "../../shared/protocol.ts";
import { AGENT_VERSION } from "./config.ts";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
// The longest tool name the major providers accept.
const MAX_TOOL_NAME = 64;
const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 4000;

/** One `mcpServers` entry of pi's `mcp.json`. */
export interface McpServerConfig {
	type?: "stdio" | "http" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
	exposure?: string;
	toolExposure?: Record<string, string>;
	description?: string;
}

type Log = (level: "info" | "warn" | "error", message: string) => void;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function problemWith(name: string, value: unknown): string | undefined {
	if (!SERVER_NAME.test(name)) return "names may contain only letters, digits, _ and -";
	if (!value || typeof value !== "object" || Array.isArray(value)) return "must be an object";
	const config = value as McpServerConfig;
	const type = config.type as string | undefined;
	if (type === "sse") return "the SSE transport is not supported; try the server's streamable HTTP endpoint (often /mcp)";
	if (type !== undefined && !["stdio", "http", "streamable-http"].includes(type)) return "type must be stdio, http or streamable-http";
	if ((typeof config.command === "string") === (typeof config.url === "string")) return "needs exactly one of command and url";
	if (type === "stdio" && !config.command) return "a stdio server needs command";
	if (type !== undefined && type !== "stdio" && !config.url) return "an HTTP server needs url";
	return undefined;
}

const serverKey = (name: string) => name.replace(/-/g, "_");

function readServers(path: string, problems: string[]): Array<[string, McpServerConfig]> {
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		problems.push(`${path}: ${errorText(error)}`);
		return [];
	}
	const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
	if (servers === undefined) return [];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		problems.push(`${path}: mcpServers must be an object`);
		return [];
	}
	const entries: Array<[string, McpServerConfig]> = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(servers)) {
		const problem = problemWith(name, value) ?? (seen.has(serverKey(name)) ? "another server's name differs only in - and _" : undefined);
		if (problem) {
			problems.push(`${path}: ${name}: ${problem}`);
			continue;
		}
		seen.add(serverKey(name));
		entries.push([name, value as McpServerConfig]);
	}
	return entries;
}

/** pi's files: `<agentDir>/mcp.json`, then the project's `.pi/mcp.json`, whose entries replace same-named ones. */
export function loadMcpConfig(cwd: string, agentDir: string): { servers: Map<string, McpServerConfig>; problems: string[] } {
	const problems: string[] = [];
	const servers = new Map<string, McpServerConfig>();
	for (const path of [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		for (const [name, config] of readServers(path, problems)) {
			for (const existing of servers.keys()) if (serverKey(existing) === serverKey(name)) servers.delete(existing);
			servers.set(name, config);
		}
	}
	return { servers, problems };
}

/** `${NAME}` from the environment, or the output of `!command` when the command makes up the whole value. */
export function expandValue(value: string): string {
	if (value.startsWith("!")) return execFileSync("bash", ["-c", value.slice(1)], { encoding: "utf8", timeout: 15_000 }).trim();
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function expandAll(values: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, expandValue(value)]));
}

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);

/** `mcp__<server>__<tool>` as pi names them; names that collide after sanitizing, or run too long, get a hash suffix. */
export function toolNames(server: string, tools: readonly string[]): Map<string, string> {
	const base = new Map(tools.map((tool) => [tool, `mcp__${sanitize(server)}__${sanitize(tool)}`]));
	const counts = new Map<string, number>();
	for (const name of base.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
	const names = new Map<string, string>();
	for (const [tool, name] of base) {
		let unique = counts.get(name)! > 1 ? `${name}_${shortHash(tool)}` : name;
		if (unique.length > MAX_TOOL_NAME) unique = `${unique.slice(0, MAX_TOOL_NAME - 7)}_${shortHash(tool)}`;
		names.set(tool, unique);
	}
	return names;
}

function globMatches(pattern: string, text: string): boolean {
	const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${escaped.join(".*")}$`).test(text);
}

/** pi's `exposure` and `toolExposure`: an exact tool name wins over patterns, and the first matching pattern wins. */
export function isHidden(config: McpServerConfig, tool: string): boolean {
	const overrides = Object.entries(config.toolExposure ?? {});
	const exposure =
		config.toolExposure?.[tool] ??
		overrides.find(([pattern]) => pattern.includes("*") && globMatches(pattern, tool))?.[1] ??
		config.exposure;
	return exposure === "hidden";
}

/** The server's input schema when pi-ai can validate against it, otherwise any object. */
function parameters(schema: unknown): TSchema {
	const { $schema: _dialect, ...rest } = (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>;
	const candidate = { type: "object", properties: {}, ...rest } as unknown as TSchema;
	try {
		Compile(candidate);
		return candidate;
	} catch {
		return { type: "object", additionalProperties: true } as unknown as TSchema;
	}
}

type Content = NonNullable<ToolExecutionResult["content"]>[number];

function toContent(block: Record<string, unknown>): Content {
	switch (block.type) {
		case "text":
			return { type: "text", text: String(block.text ?? "") };
		case "image":
			return { type: "image", data: String(block.data), mimeType: String(block.mimeType) };
		case "resource": {
			const resource = (block.resource ?? {}) as { uri?: string; text?: string; mimeType?: string };
			return { type: "text", text: resource.text ?? `[resource ${resource.uri ?? ""}${resource.mimeType ? `, ${resource.mimeType}` : ""}]` };
		}
		case "resource_link":
			return { type: "text", text: `[resource link ${String(block.uri)}${block.name ? ` (${String(block.name)})` : ""}]` };
		default:
			return { type: "text", text: `[${String(block.type)} content]` };
	}
}

function toResult(result: { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown }): ToolExecutionResult {
	const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>).map(toContent) : [];
	if (content.length === 0) content.push({ type: "text", text: JSON.stringify(result.structuredContent ?? result.toolResult ?? {}, null, 2) });
	return { content, ...(result.isError === true ? { isError: true } : {}) };
}

interface ListedTool {
	name: string;
	description?: string;
	inputSchema: unknown;
}

/** One configured server: connects on start and again on the next call after its connection dropped. */
class McpServer {
	status: McpServerStatus;
	tools: ToolRegistration[] = [];
	private client: Client | undefined;
	private connecting: Promise<Client> | undefined;
	private stderr = "";
	private closed = false;

	constructor(
		readonly name: string,
		private readonly config: McpServerConfig,
		private readonly cwd: string,
		private readonly onChange: () => void,
	) {
		this.status = { name, state: "connecting", tools: 0 };
	}

	private get timeoutMs(): number {
		return (this.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	connect(): Promise<Client> {
		this.connecting ??= this.doConnect().catch((error: unknown) => {
			this.connecting = undefined;
			this.setStatus("failed", this.describe(error));
			throw error;
		});
		return this.connecting;
	}

	private setStatus(state: McpServerStatus["state"], error?: string): void {
		this.status = { name: this.name, state, tools: this.tools.length, ...(error ? { error } : {}) };
		this.onChange();
	}

	private describe(error: unknown): string {
		const message = errorText(error);
		const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
		const hint = /\b401\b|unauthorized/i.test(message) ? "; OAuth sign-in is not supported here, so put a token in headers" : "";
		return `${message}${hint}${tail ? ` (stderr: ${tail})` : ""}`;
	}

	private transport(): StdioClientTransport | StreamableHTTPClientTransport {
		if (this.config.command) {
			const transport = new StdioClientTransport({
				command: expandHome(this.config.command),
				args: (this.config.args ?? []).map(expandHome),
				env: { ...(process.env as Record<string, string>), ...expandAll(this.config.env) },
				cwd: this.config.cwd ? resolve(this.cwd, expandHome(this.config.cwd)) : this.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer) => {
				this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
			});
			return transport;
		}
		return new StreamableHTTPClientTransport(new URL(this.config.url!), { requestInit: { headers: expandAll(this.config.headers) } });
	}

	private async doConnect(): Promise<Client> {
		if (this.closed) throw new Error("closed");
		this.setStatus("connecting");
		const client = new Client({ name: "pi-spot", version: AGENT_VERSION });
		client.onclose = () => {
			if (this.client !== client) return;
			this.client = undefined;
			this.connecting = undefined;
			if (!this.closed) this.setStatus("failed", "disconnected; reconnects on the next call");
		};
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			void this.listTools(client).catch(() => undefined);
		});
		await client.connect(this.transport(), { timeout: this.timeoutMs });
		this.client = client;
		await this.listTools(client);
		return client;
	}

	private async listTools(client: Client): Promise<void> {
		const listed: ListedTool[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeoutMs });
			listed.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor);
		const visible = listed.filter((tool) => !isHidden(this.config, tool.name));
		const names = toolNames(this.name, visible.map((tool) => tool.name));
		this.tools = visible.map((tool) => this.registration(names.get(tool.name)!, tool));
		this.setStatus("connected");
	}

	private registration(name: string, tool: ListedTool): ToolRegistration {
		return {
			name,
			description: tool.description || `${tool.name} from the ${this.name} MCP server`,
			parameters: parameters(tool.inputSchema),
			execute: async (args, _api, context) => {
				const client = this.client ?? (await this.connect());
				const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, {
					timeout: this.timeoutMs,
					resetTimeoutOnProgress: true,
					...(context.abortSignal ? { signal: context.abortSignal } : {}),
				});
				return toResult(result);
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => undefined);
	}
}

/**
 * A session's MCP servers from pi's `mcp.json` files. Their tools form the `mcp` extension, reinstalled whenever a
 * server connects or changes its tool list. pi's codemode and tool search do not exist here, so every tool that is
 * not `hidden` is declared to the model directly. OAuth sign-in to remote servers is not supported.
 */
export class McpServers {
	private servers: McpServer[] = [];

	constructor(
		private readonly cwd: string,
		private readonly agentDir: string,
		private readonly install: (extension: Extension) => void,
		private readonly onStatus: () => void,
		private readonly log: Log,
	) {}

	/**
	 * (Re)reads the configuration and connects every enabled server, waiting up to `waitMs` so a resumed run finds the
	 * tools it called before.
	 */
	async start(waitMs = 10_000): Promise<void> {
		await this.close();
		const config = loadMcpConfig(this.cwd, this.agentDir);
		for (const problem of config.problems) this.log("warn", `mcp: ${problem}`);
		this.servers = [...config.servers]
			.filter(([, server]) => server.enabled !== false)
			.map(([name, server]) => new McpServer(name, server, this.cwd, () => this.changed()));
		this.changed();
		const connected = this.servers.map((server) =>
			server.connect().catch(() => this.log("warn", `mcp server ${server.name}: ${server.status.error}`)),
		);
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([Promise.all(connected), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
		clearTimeout(timer);
	}

	private changed(): void {
		this.install(defineExtension({ name: "mcp", tools: this.servers.flatMap((server) => server.tools) }));
		this.onStatus();
	}

	status(): McpServerStatus[] {
		return this.servers.map((server) => server.status);
	}

	async close(): Promise<void> {
		const servers = this.servers;
		this.servers = [];
		await Promise.all(servers.map((server) => server.close()));
	}
}
