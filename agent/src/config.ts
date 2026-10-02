import { join } from "node:path";

export const AGENT_VERSION = "0.1.0";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing environment variable ${name}`);
	return value;
}

export interface AgentConfig {
	hubUrl: string;
	instanceId: string;
	token: string;
	dataDir: string;
	sessionsDir: string;
	workDir: string;
	/** pi's agent directory (auth.json, device-id); `$HOME/.pi/agent` on the VM, where HOME is on the data disk. */
	agentDir: string;
	metadataUrl: string;
	spotPollMs: number;
}

export function loadConfig(): AgentConfig {
	const dataDir = process.env.PI_DATA_DIR ?? "/data";
	const token = required("PI_AGENT_TOKEN");
	// Shell tools inherit process.env; the model has no business seeing the Hub credential.
	delete process.env.PI_AGENT_TOKEN;
	return {
		hubUrl: required("PI_HUB_URL").replace(/\/+$/, ""),
		instanceId: required("PI_INSTANCE_ID"),
		token,
		dataDir,
		sessionsDir: join(dataDir, "pi", "sessions"),
		workDir: join(dataDir, "work"),
		agentDir: process.env.PI_CODING_AGENT_DIR ?? join(dataDir, "home", ".pi", "agent"),
		metadataUrl: process.env.PI_METADATA_URL ?? "http://metadata.tencentyun.com/latest/meta-data",
		spotPollMs: Number(process.env.PI_SPOT_POLL_MS ?? 5000),
	};
}
