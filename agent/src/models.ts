import type { MutableModels } from "@earendil-works/pi-ai/models";

type RequestMethod = "stream" | "streamSimple" | "complete" | "completeSimple";
const REQUEST_METHODS = new Set<PropertyKey>(["stream", "streamSimple", "complete", "completeSimple"]);

/**
 * The shared model registry, with pi-ai's `sessionId` on every request one session makes. pi-durable does not pass
 * one; providers need it: OpenCode routes on it (`x-opencode-session`) and others use it for prompt-cache affinity.
 */
export function withSessionId(models: MutableModels, sessionId: string): MutableModels {
	return new Proxy(models, {
		get(target, property) {
			if (REQUEST_METHODS.has(property)) {
				const method = target[property as RequestMethod] as (...args: unknown[]) => unknown;
				return (model: unknown, context: unknown, options?: { sessionId?: string }) =>
					method.call(target, model, context, { ...options, sessionId: options?.sessionId ?? sessionId });
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
