import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { SavedCredentials } from "../../shared/protocol.ts";

/**
 * pi's credentials kept in memory and by the Hub, never on the data disk: logins survive deleting the disk and stay
 * out of its snapshots. Every change, such as a rotated OAuth refresh token, is sent to the Hub and resent after a
 * reconnect until the Hub confirms it. One agent process owns the set, so an in-process queue is the only lock needed.
 */
export class HubCredentialStore implements CredentialStore {
	private revision = 0;
	private savedRevision = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly waiters: Array<{ revision: number; resolve(): void }> = [];

	constructor(
		private state: SavedCredentials,
		private readonly send: (credentials: SavedCredentials, revision: number) => void,
	) {}

	get deviceId(): string {
		return this.state.deviceId;
	}

	private get data(): Record<string, Credential> {
		return this.state.data as Record<string, Credential>;
	}

	private serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private replace(data: Record<string, Credential>): void {
		this.state = { ...this.state, data };
		this.publish();
	}

	/** Sends the current set as a new revision. */
	publish(): void {
		this.revision += 1;
		this.send(this.state, this.revision);
	}

	/** The Hub stored `revision`. */
	saved(revision: number): void {
		this.savedRevision = Math.max(this.savedRevision, revision);
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.revision <= this.savedRevision) waiter.resolve();
			else this.waiters.push(waiter);
		}
	}

	/** After a reconnect: sends the latest change again unless the Hub already has it. */
	resend(): void {
		if (this.savedRevision < this.revision) this.send(this.state, this.revision);
	}

	/** Resolves once the Hub has stored the current set. */
	whenSaved(): Promise<void> {
		const revision = this.revision;
		if (revision <= this.savedRevision) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({ revision, resolve }));
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.data[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.serialized(async () => {
			const next = await fn(this.data[providerId]);
			if (next === undefined) return this.data[providerId];
			this.replace({ ...this.data, [providerId]: next });
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.serialized(async () => {
			const { [providerId]: _removed, ...rest } = this.data;
			this.replace(rest);
		});
	}
}

/**
 * The credential store for this agent: the Hub's set, or on the first start after the move to Hub-kept logins, what
 * earlier agents left in `auth.json` and `device-id` on the data disk. Those files are deleted once the Hub has the
 * set; a copy that reappears, e.g. on a disk restored from an older snapshot, is stale and deleted at once.
 */
export async function openCredentials(
	saved: SavedCredentials | null,
	agentDir: string,
	send: (credentials: SavedCredentials, revision: number) => void,
): Promise<HubCredentialStore> {
	const authFile = join(agentDir, "auth.json");
	const deviceIdFile = join(agentDir, "device-id");
	const removeFiles = () => Promise.all([rm(authFile, { force: true }), rm(deviceIdFile, { force: true })]);
	if (saved) {
		await removeFiles();
		return new HubCredentialStore(saved, send);
	}
	let data: Record<string, unknown> = {};
	try {
		if (existsSync(authFile)) data = JSON.parse(await readFile(authFile, "utf8")) as Record<string, unknown>;
	} catch {
		// An unreadable file holds nothing usable.
	}
	const deviceId = existsSync(deviceIdFile) ? (await readFile(deviceIdFile, "utf8")).trim() : randomUUID();
	const store = new HubCredentialStore({ data, deviceId }, send);
	store.publish();
	void store.whenSaved().then(removeFiles);
	return store;
}
