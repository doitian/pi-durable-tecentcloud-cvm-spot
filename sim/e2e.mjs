// End-to-end lifecycle test: the real Worker (wrangler dev) against the Tencent Cloud simulator, with real agent
// processes and the scripted faux model. Covers launch, spot reclaim mid-run, idle shutdown, sudden instance loss,
// Hub-kept logins, MCP tools and approvals.
//
//   npm run test:e2e
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "http://127.0.0.1:8788";
const SIM = "http://127.0.0.1:8790";
const TOKEN = "e2e-admin-token";
const scratch = mkdtempSync(join(tmpdir(), "pi-spot-e2e-"));
const children = [];

function start(name, command, args, options) {
	const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
	const lines = [];
	const capture = (data) => lines.push(...String(data).split("\n").filter(Boolean).map((line) => `[${name}] ${line}`));
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	children.push({ child, lines });
	return child;
}

function stopAll() {
	for (const { child } of children) {
		if (child.exitCode !== null) continue;
		if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
		else child.kill("SIGTERM");
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
		} catch {
			// Not ready yet.
		}
		await sleep(1000);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

async function api(path, init = {}) {
	const response = await fetch(`${HUB}/api${path}`, {
		...init,
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json();
}

const simState = async () => (await fetch(`${SIM}/_sim/state`)).json();
const runningAgent = async () => (await simState()).instances.find((i) => i.agent && i.state === "RUNNING");
const session = async (id) => (await api("/state")).sessions.find((s) => s.id === id);
const answers = async (id) =>
	(await api(`/sessions/${id}/transcript`)).filter(
		(e) => e.kind === "pi.assistant" && e.model?.[0]?.content?.some((b) => b.type === "text"),
	).length;
const interrupted = async (id) =>
	(await api(`/sessions/${id}/transcript`)).some(
		(e) => e.kind === "pi.tool-result" && JSON.stringify(e.model).includes("interrupted"),
	);
const input = (id, content) => api(`/sessions/${id}/input`, { method: "POST", body: JSON.stringify({ content }) });
const step = (message) => console.log(`\n== ${message}`);

const CONTEXT_MARKER = "E2E-GLOBAL-CONTEXT-MARKER";
const agentDir = join(scratch, "data", "home", ".pi", "agent");
const legacyAuthFile = join(agentDir, "auth.json");

/**
 * What pi would find in ~/.pi/agent on the data disk: a global AGENTS.md, one skill, an MCP server, and the auth.json
 * an earlier agent saved logins to; plus a skill in ~/.agents/skills.
 */
function seedAgentDir() {
	mkdirSync(join(agentDir, "skills", "e2e-skill"), { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), `Always mention ${CONTEXT_MARKER}.\n`);
	writeFileSync(
		join(agentDir, "skills", "e2e-skill", "SKILL.md"),
		"---\nname: e2e-skill\ndescription: Checks that skills reach the prompt.\n---\nDo the thing.\n",
	);
	const agentsSkill = join(scratch, "data", "home", ".agents", "skills", "e2e-agents-skill");
	mkdirSync(agentsSkill, { recursive: true });
	writeFileSync(join(agentsSkill, "SKILL.md"), "---\nname: e2e-agents-skill\ndescription: From ~/.agents/skills.\n---\n");
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				echo: {
					command: process.execPath,
					args: [join(root, "sim", "mcp-echo.mjs")],
					env: { ECHO_PREFIX: "echo: " },
					toolExposure: { "secret-*": "hidden" },
				},
			},
		}),
	);
	writeFileSync(
		legacyAuthFile,
		JSON.stringify({ faux: { type: "oauth", access: "faux-seeded", refresh: "faux-refresh", expires: Date.now() + 86_400_000 } }),
	);
}

const fauxLogin = async (since = 0) => {
	const { auth } = await api("/state");
	return auth && auth.at >= since && auth.providers.find((provider) => provider.id === "faux")?.stored === "oauth";
};
const toolResult = async (id, name, needle) =>
	(await api(`/sessions/${id}/transcript`)).some(
		(e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name && JSON.stringify(e.model).includes(needle),
	);
const waitingApproval = async (id) => (await session(id))?.approvals.find((approval) => !approval.decision);
const answer = (id, approval, approve, reason) =>
	api(`/sessions/${id}/approval`, { method: "POST", body: JSON.stringify({ approvalId: approval.id, approve, reason }) });

async function main() {
	seedAgentDir();
	start("sim", process.execPath, [join(root, "sim/tencent-sim.mjs")], {
		env: { ...process.env, SIM_HUB_URL: HUB, SIM_DATA_DIR: join(scratch, "data"), SIM_LATENCY_MS: "400" },
	});
	const vars = {
		CLOUD_MODE: "tencent",
		TENCENT_API_ENDPOINT: `${SIM}/{service}`,
		TENCENTCLOUD_SECRET_ID: "sim",
		TENCENTCLOUD_SECRET_KEY: "sim",
		ADMIN_TOKEN: TOKEN,
		DEFAULT_MODEL: "faux/faux-1",
		IDLE_MINUTES: "1",
		ARCHIVE_AFTER_MINUTES: "0",
		AGENT_ENV: "{}",
	};
	start(
		"worker",
		"npx",
		["wrangler", "dev", "--port", "8788", "--ip", "127.0.0.1", "--persist-to", join(scratch, "state"),
			...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`])],
		{ cwd: root },
	);
	await waitFor("worker", () => api("/state"), 90_000);

	step("a new session launches a spot instance, attaches the data disk and answers");
	const created = await api("/sessions", { method: "POST", body: JSON.stringify({ title: "e2e", prompt: "first" }) });
	const first = await waitFor("first agent", runningAgent, 90_000);
	await waitFor("first answer", async () => (await answers(created.id)) >= 1, 60_000);
	console.log(`ok: ${first.id} (${first.type}) answered`);

	step("the prompt carries pi's sections, context files and skills; subagents, compact and new context work");
	const system = (await api(`/sessions/${created.id}/transcript`)).find((e) => e.kind === "pi.system")?.model?.[0];
	const sections = system?.sections ?? {};
	for (const [name, needle] of [["rules", "Use edit for precise changes"], ["project_context", CONTEXT_MARKER], ["skills", "e2e-skill"], ["skills", "e2e-agents-skill"], ["tools", "subagent"]]) {
		if (!sections[name]?.includes(needle)) throw new Error(`system prompt section ${name} lacks "${needle}"`);
	}
	await input(created.id, "delegate: list the files");
	await waitFor("subagent answer", async () => (await api(`/sessions/${created.id}/transcript`)).some(
		(e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === "subagent" && JSON.stringify(e.model).includes("Done."),
	), 90_000);
	await waitFor("delegating run settled", async () => !(await session(created.id))?.busy, 30_000);
	await api(`/sessions/${created.id}/compact`, { method: "POST", body: JSON.stringify({ instructions: "" }) });
	await api(`/sessions/${created.id}/reset`, { method: "POST", body: JSON.stringify({ handoff: "Continue from here." }) });
	await waitFor("reset entry", async () => (await api(`/sessions/${created.id}/transcript`)).some((e) => e.kind === "pi.reset"), 30_000);
	console.log("ok: pi sections, AGENTS.md and skills present; subagent answered; compact accepted; new context started");

	step("logins move from auth.json on the disk to the Hub; MCP tools from mcp.json are callable");
	await waitFor("seeded login reported", () => fauxLogin(), 30_000);
	await waitFor("auth.json removed from the disk", async () => !existsSync(legacyAuthFile), 30_000);
	const mcp = (await session(created.id))?.mcp ?? [];
	if (mcp[0]?.name !== "echo" || mcp[0].state !== "connected" || mcp[0].tools !== 1) throw new Error(`unexpected MCP status ${JSON.stringify(mcp)}`);
	await input(created.id, 'mcp: mcp__echo__echo {"text":"from e2e"}');
	await waitFor("MCP tool result", () => toolResult(created.id, "mcp__echo__echo", "echo: from e2e"), 60_000);
	await waitFor("MCP run settled", async () => !(await session(created.id))?.busy, 30_000);
	console.log("ok: login kept by the Hub, auth.json gone; echo server connected with its one visible tool, call answered");

	step("a spot reclaim mid-run moves the work to a replacement instance");
	const beforeAB = await answers(created.id);
	await input(created.id, "task A");
	await input(created.id, "task B");
	await sleep(1000);
	await fetch(`${SIM}/_sim/reclaim`, { method: "POST" });
	const second = await waitFor("replacement agent", async () => {
		const agent = await runningAgent();
		return agent && agent.id !== first.id ? agent : undefined;
	}, 120_000);
	await waitFor("both tasks answered", async () => (await answers(created.id)) >= beforeAB + 2, 90_000);
	console.log(`ok: replacement ${second.id} (${second.type}); interrupted tool seen: ${await interrupted(created.id)}`);

	step("the instance is terminated after the idle period, then the idle disk is saved as a snapshot and deleted");
	await waitFor("idle shutdown", async () => (await simState()).instances.length === 0, 180_000);
	await waitFor("disk archived", async () => {
		const state = await simState();
		return state.disks.length === 0 && state.snapshots.some((s) => s.state === "NORMAL");
	}, 120_000);
	console.log("ok: no instances, no disk, one snapshot");

	step("work restores the disk from its snapshot; an instance lost without notice is replaced and its run resumes");
	const beforeC = await answers(created.id);
	await input(created.id, "task C");
	const third = await waitFor("agent for task C", runningAgent, 150_000);
	if ((await simState()).disks.length !== 1) throw new Error("the data disk was not restored");
	await waitFor("task C running", async () => (await session(created.id))?.busy, 30_000);
	await sleep(3000);
	await fetch(`${SIM}/cvm`, {
		method: "POST",
		headers: { authorization: "TC3-HMAC-SHA256 Credential=e2e", "x-tc-action": "TerminateInstances" },
		body: JSON.stringify({ InstanceIds: [third.id] }),
	});
	const fourth = await waitFor("agent after loss", async () => {
		const agent = await runningAgent();
		return agent && agent.id !== third.id ? agent : undefined;
	}, 150_000);
	await waitFor("task C answered", async () => (await answers(created.id)) >= beforeC + 1, 90_000);
	await waitFor("task C run settled", async () => !(await session(created.id))?.busy, 30_000);
	console.log(`ok: ${third.id} lost, ${fourth.id} finished the run`);

	step("Stop VM terminates the instance promptly instead of waiting for the drain timeout");
	const stopRequested = Date.now();
	await api("/instance/stop", { method: "POST" });
	await waitFor("instance terminated after stop", async () => (await simState()).instances.length === 0, 75_000);
	console.log(`ok: terminated ${Math.round((Date.now() - stopRequested) / 1000)}s after Stop VM`);

	step("in ask mode a shell call waits for approval; approve and deny both reach the agent");
	const asking = await api("/sessions", { method: "POST", body: JSON.stringify({ title: "approvals", prompt: "run it", approvalMode: "ask" }) });
	let approval = await waitFor("approval request", () => waitingApproval(asking.id), 150_000);
	if (approval.toolName !== "bash" || !approval.preview.includes("hostname")) throw new Error(`unexpected approval ${JSON.stringify(approval)}`);
	await answer(asking.id, approval, true);
	await waitFor("approved call answered", async () => (await answers(asking.id)) >= 1, 60_000);
	await input(asking.id, "run it again");
	approval = await waitFor("second approval request", () => waitingApproval(asking.id), 60_000);
	await answer(asking.id, approval, false, "not now");
	await waitFor("denial reaches the model", () => toolResult(asking.id, "bash", "the user denied it: not now"), 60_000);
	await waitFor("denied call answered", async () => (await answers(asking.id)) >= 2, 60_000);
	console.log("ok: approved call ran; denied call was blocked with the reason");

	step("a VM whose only work waits for approval stops; answering later starts a VM that finishes the call");
	await input(asking.id, "run it a third time");
	approval = await waitFor("third approval request", () => waitingApproval(asking.id), 60_000);
	await waitFor("idle shutdown while waiting", async () => (await simState()).instances.length === 0, 240_000);
	if (!(await waitingApproval(asking.id))) throw new Error("the approval request was lost when the VM stopped");
	await answer(asking.id, approval, true);
	await waitFor("call finished on a new VM", async () => (await answers(asking.id)) >= 3, 240_000);
	console.log("ok: no VM while waiting; the answer given offline was applied by the next VM");

	step("deleting the data disk keeps the saved logins");
	await api("/instance/stop", { method: "POST" });
	await waitFor("instance gone", async () => (await simState()).instances.length === 0, 120_000);
	await waitFor("disk deletable", async () => {
		try {
			await api("/disk/delete", { method: "POST" });
			return true;
		} catch {
			return false;
		}
	}, 120_000);
	const deletedAt = Date.now();
	await api("/instance/start", { method: "POST" });
	await waitFor("login reported by the agent on the new disk", () => fauxLogin(deletedAt), 240_000);
	if (existsSync(legacyAuthFile)) throw new Error("auth.json reappeared on the disk");
	console.log("ok: a fresh disk, and the agent still has the login");

	console.log("\nPASS");
}

let failed = false;
try {
	await main();
} catch (error) {
	failed = true;
	console.error(`\nFAIL: ${error.message}`);
	const state = await api("/state").catch(() => undefined);
	if (state) {
		const sessions = state.sessions.map(({ id, title, ready, busy, pendingInputs, approvals, error: sessionError }) => ({
			id, title, ready, busy, pendingInputs, approvals: approvals.length, sessionError,
		}));
		console.error(`sessions: ${JSON.stringify(sessions)}\ninstance: ${JSON.stringify(state.instance)}`);
	}
	for (const { lines } of children) console.error(lines.slice(-40).join("\n"));
} finally {
	stopAll();
	await sleep(500);
	rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
	process.exit(failed ? 1 : 0);
}
