import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Credentials in pi's `auth.json` format (`{ [providerId]: Credential }`, mode 0600) on the data disk, so logins and
 * rotated OAuth refresh tokens survive VM replacement. One agent process owns the disk, so an in-process queue is
 * the only lock needed.
 */
export class FileCredentialStore implements CredentialStore {
	private data: Record<string, Credential> | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly path: string) {}

	private async load(): Promise<Record<string, Credential>> {
		if (!this.data) {
			this.data = existsSync(this.path)
				? (JSON.parse(await readFile(this.path, "utf8")) as Record<string, Credential>)
				: {};
		}
		return this.data;
	}

	private async save(data: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.path);
	}

	private serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.serialized(async () => {
			const data = await this.load();
			const next = await fn(data[providerId]);
			if (next === undefined) return data[providerId];
			const updated = { ...data, [providerId]: next };
			await this.save(updated);
			this.data = updated;
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.serialized(async () => {
			const { [providerId]: _removed, ...rest } = await this.load();
			await this.save(rest);
			this.data = rest;
		});
	}
}

/** Stable installation ID some login flows send to the provider (e.g. OpenAI's agent host ID). */
export async function deviceId(agentDir: string): Promise<string> {
	const path = join(agentDir, "device-id");
	if (existsSync(path)) return (await readFile(path, "utf8")).trim();
	const id = randomUUID();
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, `${id}\n`, { encoding: "utf8", mode: 0o600 });
	return id;
}
