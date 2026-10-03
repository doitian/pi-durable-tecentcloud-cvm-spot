import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ApprovalMode } from "../../shared/protocol.ts";
import { Approvals } from "../src/approvals.ts";

function setup(mode: ApprovalMode = "ask") {
	const requests: Array<{ approvalId: string; toolName: string; preview: string }> = [];
	const settled: string[] = [];
	let current = mode;
	const approvals = new Approvals("s1", () => current, {
		request: (approvalId, toolName, preview) => requests.push({ approvalId, toolName, preview }),
		settled: (approvalId) => settled.push(approvalId),
		changed: () => undefined,
	});
	const beforeTool = (approvals.extension.hooks![0]!.handlers as ToolHooks).beforeTool;
	const memos = new Map<string, unknown>();
	const api = (taskId: string) =>
		({
			taskId,
			memo: async (name: string, ...rest: unknown[]) => {
				const key = `${taskId}/${name}`;
				if (rest.length === 2 && !memos.has(key)) memos.set(key, rest[0]);
				return memos.get(key);
			},
		}) as unknown as HookApi;
	const call = (name: string, taskId: string, context: Context = BACKGROUND_CONTEXT) =>
		beforeTool({ type: "toolCall", id: `call-${taskId}`, name, arguments: { command: "rm -rf build" } }, api(taskId), context);
	return { approvals, requests, settled, call, setMode: (next: ApprovalMode) => (current = next) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Approvals", () => {
	it("lets every call through in auto mode, and read-only tools in any mode", async () => {
		const { requests, call, setMode } = setup("auto");
		expect(await call("bash", "t1")).toBeUndefined();
		setMode("ask");
		expect(await call("read", "t2")).toBeUndefined();
		expect(requests).toEqual([]);
	});

	it("holds a call until the user approves, and remembers the answer for a rerun", async () => {
		const { approvals, requests, settled, call } = setup();
		const pending = call("bash", "t1");
		await tick();
		expect(approvals.count).toBe(1);
		expect(requests[0]).toMatchObject({ approvalId: "s1:t1", toolName: "bash" });
		expect(requests[0]!.preview).toContain("rm -rf build");
		approvals.reply("s1:t1", { approve: true });
		expect(await pending).toBeUndefined();
		expect(settled).toEqual(["s1:t1"]);
		expect(approvals.count).toBe(0);
		expect(await call("bash", "t1")).toBeUndefined();
		expect(requests).toHaveLength(1);
	});

	it("blocks a denied call with the user's reason", async () => {
		const { approvals, call } = setup();
		const pending = call("edit", "t2");
		await tick();
		approvals.reply("s1:t2", { approve: false, reason: "use a branch" });
		expect(await pending).toEqual({ block: "the user denied it: use a branch" });
	});

	it("asks again after a reconnect and stops waiting when the run is aborted", async () => {
		const { approvals, requests, settled, call } = setup();
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const pending = call("write", "t3", context);
		await tick();
		approvals.resend();
		expect(requests.map((request) => request.approvalId)).toEqual(["s1:t3", "s1:t3"]);
		cancel(new Error("aborted"));
		await expect(pending).rejects.toThrow();
		expect(approvals.count).toBe(0);
		expect(settled).toEqual([]);
	});

	it("keeps counting a call whose wait a closing session cuts short", async () => {
		const { approvals, call } = setup();
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const pending = call("bash", "t4", context);
		await tick();
		approvals.freeze();
		cancel(new Error("closing"));
		await expect(pending).rejects.toThrow();
		expect(approvals.count).toBe(1);
	});
});
