import type { Env } from "./env.ts";
import type { CreateSessionInput, Settings } from "./hub.ts";

export { Hub } from "./hub.ts";

function hub(env: Env) {
	return env.HUB.get(env.HUB.idFromName("main"));
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value ?? { ok: true }), { status, headers: { "content-type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	return crypto.subtle.timingSafeEqual(left, right);
}

/** Why the request may not use the API, or undefined when it carries the admin token. */
function adminDenial(request: Request, url: URL, env: Env): string | undefined {
	// Values pasted into the dashboard easily pick up a trailing newline.
	const expected = env.ADMIN_TOKEN?.trim();
	if (!expected) {
		return "This Worker has no ADMIN_TOKEN secret yet. Add it under Settings > Variables and Secrets, then deploy.";
	}
	const header = request.headers.get("Authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "");
	return timingSafeEqual(token.trim(), expected) ? undefined : "Wrong admin token.";
}

async function api(request: Request, url: URL, env: Env): Promise<Response> {
	const stub = hub(env);
	const path = url.pathname.slice("/api".length);
	const method = request.method;
	const body = async <T>() => (await request.json()) as T;
	const session = /^\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(path);
	if (method !== "GET") await stub.notePublicUrl(url.origin);

	if (method === "GET" && path === "/state") return json(await stub.panelState());
	if (method === "GET" && path === "/settings") return json(await stub.getSettings());
	if (method === "PUT" && path === "/settings") return json(await stub.updateSettings(await body<Partial<Settings>>()));
	if (method === "GET" && path === "/candidates") return json(await stub.candidates());
	if (method === "POST" && path === "/sessions") return json(await stub.createSession(await body<CreateSessionInput>()), 201);
	if (method === "GET" && path === "/sessions/archived") return json(await stub.archivedSessions());
	if (method === "POST" && path === "/sessions/unarchive") {
		return json({ resumed: await stub.unarchiveSessions((await body<{ ids: string[] }>()).ids ?? []) });
	}
	if (method === "POST" && path === "/sessions/delete") {
		return json({ deleted: await stub.deleteSessions((await body<{ ids: string[] }>()).ids ?? []) });
	}
	if (method === "POST" && path === "/instance/start") return json(await stub.startInstance());
	if (method === "POST" && path === "/instance/stop") return json(await stub.stopInstance());
	if (method === "POST" && path === "/reconcile") return json(await stub.tick());
	if (method === "POST" && path === "/disk/delete") return json(await stub.deleteDataDisk());
	if (session) {
		const [, id, action] = session as unknown as [string, string, string | undefined];
		if (method === "GET" && action === "/transcript") return json(await stub.transcript(id));
		if (method === "POST" && action === "/input") {
			const input = await body<{ content: string; steer?: boolean }>();
			return json(await stub.sendInput(id, input.content, input.steer ? "steer" : "followUp"));
		}
		if (method === "POST" && action === "/abort") return json(await stub.abortSession(id));
		if (method === "POST" && action === "/compact") {
			return json(await stub.compactSession(id, (await body<{ instructions?: string }>()).instructions));
		}
		if (method === "POST" && action === "/reset") {
			return json(await stub.resetSession(id, (await body<{ handoff?: string }>()).handoff));
		}
		if (method === "POST" && action === "/model") {
			return json(await stub.updateSessionAgent(id, await body<{ model?: string; thinkingLevel?: string; approvalMode?: string }>()));
		}
		if (method === "POST" && action === "/approval") {
			const answer = await body<{ approvalId: string; approve: boolean; reason?: string }>();
			return json(await stub.answerApproval(id, answer.approvalId, answer.approve === true, answer.reason));
		}
		if (method === "POST" && action === "/mcp") return json(await stub.reloadMcp(id));
		if (method === "POST" && action === "/archive") return json(await stub.archiveSession(id));
	}
	return json({ error: "not found" }, 404);
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		// The Hub checks the per-instance token itself.
		if (url.pathname === "/api/agent/ws") return hub(env).fetch(request);
		if (url.pathname.startsWith("/api/")) {
			const denial = adminDenial(request, url, env);
			if (denial) return json({ error: denial }, 401);
			if (url.pathname === "/api/ui/ws" || url.pathname === "/api/term/ws") return hub(env).fetch(request);
			try {
				return await api(request, url, env);
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}
		return env.ASSETS.fetch(request);
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(hub(env).tick());
	},
} satisfies ExportedHandler<Env>;
