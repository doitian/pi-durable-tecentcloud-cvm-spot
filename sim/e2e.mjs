// End-to-end lifecycle test: the real Worker (wrangler dev) against the Tencent Cloud simulator, with real agent
// processes and the scripted faux model. Covers launch, spot reclaim mid-run, idle shutdown and sudden instance loss.
//
//   npm run test:e2e
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** What pi would find in ~/.pi/agent on the data disk: a global AGENTS.md and one skill. */
function seedAgentDir() {
	const agentDir = join(scratch, "data", "home", ".pi", "agent");
	mkdirSync(join(agentDir, "skills", "e2e-skill"), { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), `Always mention ${CONTEXT_MARKER}.\n`);
	writeFileSync(
		join(agentDir, "skills", "e2e-skill", "SKILL.md"),
		"---\nname: e2e-skill\ndescription: Checks that skills reach the prompt.\n---\nDo the thing.\n",
	);
}

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
	for (const [name, needle] of [["rules", "Use edit for precise changes"], ["project_context", CONTEXT_MARKER], ["skills", "e2e-skill"], ["tools", "subagent"]]) {
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
	console.log("ok: pi sections, AGENTS.md and skill present; subagent answered; compact accepted; new context started");

	step("a spot reclaim mid-run moves the work to a replacement instance");
	await input(created.id, "task A");
	await input(created.id, "task B");
	await sleep(1000);
	await fetch(`${SIM}/_sim/reclaim`, { method: "POST" });
	const second = await waitFor("replacement agent", async () => {
		const agent = await runningAgent();
		return agent && agent.id !== first.id ? agent : undefined;
	}, 120_000);
	await waitFor("both tasks answered", async () => (await answers(created.id)) >= 4, 90_000);
	console.log(`ok: replacement ${second.id} (${second.type}); interrupted tool seen: ${await interrupted(created.id)}`);

	step("the instance is terminated after the idle period, then the idle disk is saved as a snapshot and deleted");
	await waitFor("idle shutdown", async () => (await simState()).instances.length === 0, 180_000);
	await waitFor("disk archived", async () => {
		const state = await simState();
		return state.disks.length === 0 && state.snapshots.some((s) => s.state === "NORMAL");
	}, 120_000);
	console.log("ok: no instances, no disk, one snapshot");

	step("work restores the disk from its snapshot; an instance lost without notice is replaced and its run resumes");
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
	await waitFor("task C answered", async () => (await answers(created.id)) >= 5, 90_000);
	console.log(`ok: ${third.id} lost, ${fourth.id} finished the run`);

	step("Stop VM terminates the instance promptly instead of waiting for the drain timeout");
	const stopRequested = Date.now();
	await api("/instance/stop", { method: "POST" });
	await waitFor("instance terminated after stop", async () => (await simState()).instances.length === 0, 75_000);
	console.log(`ok: terminated ${Math.round((Date.now() - stopRequested) / 1000)}s after Stop VM`);

	console.log("\nPASS");
}

let failed = false;
try {
	await main();
} catch (error) {
	failed = true;
	console.error(`\nFAIL: ${error.message}`);
	for (const { lines } of children) console.error(lines.slice(-40).join("\n"));
} finally {
	stopAll();
	await sleep(500);
	rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
	process.exit(failed ? 1 : 0);
}
