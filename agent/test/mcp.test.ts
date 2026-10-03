import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandValue, isHidden, loadMcpConfig, McpServers, toolNames } from "../src/mcp.ts";

const echoServer = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sim", "mcp-echo.mjs");
let root: string;
let agentDir: string;
let cwd: string;

function writeConfig(path: string, servers: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-mcp-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadMcpConfig", () => {
	it("merges the user and project files; project entries replace same-named ones, - and _ counting as equal", () => {
		writeConfig(join(agentDir, "mcp.json"), {
			"git-hub": { url: "https://user.example/mcp" },
			docs: { command: "docs-server" },
		});
		writeConfig(join(cwd, ".pi", "mcp.json"), { git_hub: { url: "https://project.example/mcp" } });
		const { servers, problems } = loadMcpConfig(cwd, agentDir);
		expect(problems).toEqual([]);
		expect(Object.fromEntries(servers)).toEqual({ docs: { command: "docs-server" }, git_hub: { url: "https://project.example/mcp" } });
	});

	it("reports invalid entries and keeps the rest", () => {
		writeConfig(join(agentDir, "mcp.json"), {
			"bad name": { command: "x" },
			both: { command: "x", url: "https://x" },
			sse: { type: "sse", url: "https://x/sse" },
			a_b: { command: "first" },
			"a-b": { command: "second" },
			ok: { command: "fine" },
		});
		const { servers, problems } = loadMcpConfig(cwd, agentDir);
		expect([...servers.keys()]).toEqual(["a_b", "ok"]);
		expect(problems).toHaveLength(4);
		expect(problems.join("\n")).toMatch(/SSE transport is not supported/);
	});
});

describe("tool names and exposure", () => {
	it("names tools mcp__<server>__<tool>, with hash suffixes on collisions and overlong names", () => {
		const names = toolNames("my-server", ["read file", "read_file", "x".repeat(80), "plain"]);
		expect(names.get("plain")).toBe("mcp__my_server__plain");
		expect(names.get("read file")).toMatch(/^mcp__my_server__read_file_[0-9a-f]{6}$/);
		expect(names.get("read_file")).toMatch(/^mcp__my_server__read_file_[0-9a-f]{6}$/);
		expect(names.get("read file")).not.toBe(names.get("read_file"));
		expect(names.get("x".repeat(80))!.length).toBe(64);
	});

	it("applies exact tool exposure over patterns, the first matching pattern, then the server's", () => {
		const config = { exposure: "hidden", toolExposure: { "get_*": "direct", get_secret: "hidden", "delete_*": "hidden" } };
		expect(isHidden(config, "get_issue")).toBe(false);
		expect(isHidden(config, "get_secret")).toBe(true);
		expect(isHidden(config, "list_issues")).toBe(true);
		expect(isHidden({ toolExposure: { "delete_*": "hidden" } }, "delete_repo")).toBe(true);
		expect(isHidden({ exposure: "codemode" }, "anything")).toBe(false);
	});

	it("expands ${NAME} from the environment and !command output", () => {
		process.env.MCP_TEST_TOKEN = "t0k";
		expect(expandValue("Bearer ${MCP_TEST_TOKEN}${MCP_TEST_UNSET}")).toBe("Bearer t0k");
		expect(expandValue("!echo from-command")).toBe("from-command");
	});
});

describe("McpServers", () => {
	it("connects a stdio server and installs its visible tools as the mcp extension", async () => {
		writeConfig(join(agentDir, "mcp.json"), {
			echo: { command: process.execPath, args: [echoServer], env: { ECHO_PREFIX: "${MCP_TEST_PREFIX}" }, toolExposure: { "secret-*": "hidden" } },
			off: { command: "does-not-run", enabled: false },
			broken: { command: join(root, "missing-binary") },
		});
		process.env.MCP_TEST_PREFIX = "echo: ";
		let installed: Extension | undefined;
		const servers = new McpServers(cwd, agentDir, (extension) => (installed = extension), () => undefined, () => undefined);
		try {
			await servers.start(15_000);
			const status = Object.fromEntries(servers.status().map((server) => [server.name, server]));
			expect(status.echo).toMatchObject({ state: "connected", tools: 1 });
			expect(status.broken?.state).toBe("failed");
			expect(status.off).toBeUndefined();
			expect(installed?.name).toBe("mcp");
			const tool = installed!.tools!.find((each) => each.name === "mcp__echo__echo")!;
			expect(installed!.tools!.map((each) => each.name)).toEqual(["mcp__echo__echo"]);
			const result = await tool.execute({ text: "hello" }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
			expect(result.content).toEqual([{ type: "text", text: "echo: hello" }]);
		} finally {
			await servers.close();
		}
	}, 30_000);
});
