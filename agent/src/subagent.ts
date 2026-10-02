// Ported from pi's coding agent (MIT): experimental/durable/subagent.ts.
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? "";
}

/**
 * A foreground subagent: each call runs its task in a child conversation owned by the call and returns the child's
 * answer. The child starts with this conversation's agent (model, tools, working directory) minus this extension,
 * so it cannot delegate further. Aborting the call aborts the child; a crash resumes it.
 */
export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained task to a subagent with the same tools and get its answer back. Give it everything it needs to know; it does not see this conversation.",
			parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
			// A rerun after a crash finds the child it created and the submission it made.
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);
				const handle = (await api.conversation(child, context))!;
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent ${child} failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, context);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});
