import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SavedCredentials } from "../../shared/protocol.ts";
import { openCredentials } from "../src/credentials.ts";

let agentDir: string;
let sent: Array<{ credentials: SavedCredentials; revision: number }>;
const send = (credentials: SavedCredentials, revision: number) => sent.push({ credentials: structuredClone(credentials), revision });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-credentials-"));
	sent = [];
});

afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe("openCredentials", () => {
	it("moves auth.json and device-id off the disk once the Hub stored them", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "k" } }));
		writeFileSync(join(agentDir, "device-id"), "device-1\n");
		const store = await openCredentials(null, agentDir, send);
		expect(sent).toEqual([{ revision: 1, credentials: { data: { anthropic: { type: "api_key", key: "k" } }, deviceId: "device-1" } }]);
		expect(store.deviceId).toBe("device-1");
		await flush();
		expect(existsSync(join(agentDir, "auth.json"))).toBe(true);
		store.saved(1);
		await flush();
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(agentDir, "device-id"))).toBe(false);
	});

	it("prefers the Hub's set and deletes a stale auth.json", async () => {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ old: { type: "api_key", key: "stale" } }));
		const store = await openCredentials({ data: { openai: { type: "api_key", key: "fresh" } }, deviceId: "d" }, agentDir, send);
		expect(sent).toEqual([]);
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(await store.read("openai")).toEqual({ type: "api_key", key: "fresh" });
		expect(await store.read("old")).toBeUndefined();
	});

	it("sends every change and resends the latest until the Hub confirms it", async () => {
		const store = await openCredentials({ data: {}, deviceId: "d" }, agentDir, send);
		await store.modify("openai", async () => ({ type: "api_key", key: "a" }));
		await store.modify("openai", async () => ({ type: "api_key", key: "b" }));
		await store.modify("openai", async () => undefined);
		expect(sent.map((item) => item.revision)).toEqual([1, 2]);
		expect(sent[1]!.credentials.data).toEqual({ openai: { type: "api_key", key: "b" } });
		store.resend();
		expect(sent.map((item) => item.revision)).toEqual([1, 2, 2]);
		store.saved(2);
		store.resend();
		expect(sent).toHaveLength(3);
		await store.delete("openai");
		expect(sent.at(-1)).toEqual({ revision: 3, credentials: { data: {}, deviceId: "d" } });
		expect(await store.list()).toEqual([]);
	});
});
