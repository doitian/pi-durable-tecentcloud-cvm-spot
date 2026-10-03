import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type HookApi, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ApprovalMode } from "../../shared/protocol.ts";

/** Tools that change nothing themselves; a subagent's own tool calls are asked about one by one. */
const NO_APPROVAL = new Set(["read", "subagent"]);
const PREVIEW_CHARS = 20_000;
const MEMO = "approval";

export interface Decision {
	approve: boolean;
	reason?: string;
}

/** How a decision is memoized; memos hold JSON. */
type StoredDecision = { approve: boolean; reason: string | null };

export interface ApprovalChannel {
	request(approvalId: string, toolName: string, preview: string): void;
	settled(approvalId: string): void;
	/** The number of waiting calls changed. */
	changed(): void;
}

function preview(args: unknown): string {
	const text = JSON.stringify(args, null, 2);
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n… (${text.length - PREVIEW_CHARS} more characters)` : text;
}

/**
 * "Ask me" mode: a call of any tool that can change something waits until the user answers in the control panel.
 * The answer is memoized on the tool task, so a VM replacement neither loses it nor asks twice. A call still waiting
 * when the VM goes away asks again from the next VM, and the Hub answers at once if the user already did.
 */
export class Approvals {
	private readonly waiting = new Map<string, { toolName: string; preview: string; resolve(decision: Decision): void }>();
	private frozen = false;
	readonly extension: Extension;

	constructor(
		private readonly sessionId: string,
		private readonly mode: () => ApprovalMode,
		private readonly channel: ApprovalChannel,
	) {
		this.extension = defineExtension({
			name: "approvals",
			hooks: [hook(ToolTask, { beforeTool: (call, api, context) => this.check(call.name, call.arguments, api, context) })],
		});
	}

	get count(): number {
		return this.waiting.size;
	}

	private async check(toolName: string, args: unknown, api: HookApi, context: Context) {
		if (NO_APPROVAL.has(toolName)) return undefined;
		const decision =
			(await api.memo<StoredDecision>(MEMO, context)) ??
			(this.mode() === "ask" ? await this.ask(`${this.sessionId}:${api.taskId}`, toolName, args, api, context) : undefined);
		if (!decision || decision.approve) return undefined;
		return { block: decision.reason ? `the user denied it: ${decision.reason}` : "the user denied it" };
	}

	private async ask(approvalId: string, toolName: string, args: unknown, api: HookApi, context: Context): Promise<StoredDecision> {
		const answer = new Promise<Decision>((resolve) => {
			const request = { toolName, preview: preview(args), resolve };
			this.waiting.set(approvalId, request);
			this.channel.request(approvalId, toolName, request.preview);
			this.channel.changed();
		});
		let decision: Decision;
		try {
			decision = await awaitWithContext(answer, context);
		} finally {
			if (!this.frozen && this.waiting.delete(approvalId)) this.channel.changed();
		}
		const recorded = await api.memo<StoredDecision>(MEMO, { approve: decision.approve, reason: decision.reason || null }, context);
		this.channel.settled(approvalId);
		return recorded;
	}

	reply(approvalId: string, decision: Decision): void {
		this.waiting.get(approvalId)?.resolve(decision);
	}

	/**
	 * The session is closing: calls whose wait the close cuts short stay counted, so the last report still shows them
	 * waiting and the Hub does not start a VM for them before the user answers.
	 */
	freeze(): void {
		this.frozen = true;
	}

	/** After a reconnect: asks again for every call still waiting. */
	resend(): void {
		for (const [approvalId, request] of this.waiting) this.channel.request(approvalId, request.toolName, request.preview);
	}
}
