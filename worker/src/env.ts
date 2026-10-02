import type { Hub } from "./hub.ts";

export interface Env {
	HUB: DurableObjectNamespace<Hub>;
	ASSETS: Fetcher;

	// Secrets
	ADMIN_TOKEN: string;
	TENCENTCLOUD_SECRET_ID?: string;
	TENCENTCLOUD_SECRET_KEY?: string;
	/** JSON object of environment variables for the agent: model API keys, GH_TOKEN, GIT_USER_NAME, ... */
	AGENT_ENV?: string;
	/** Only for CLOUD_MODE=local: the token a locally started agent presents. */
	LOCAL_AGENT_TOKEN?: string;

	// Vars
	CLOUD_MODE?: "tencent" | "local";
	/** Where VMs reach the Worker; defaults to the origin the control panel is used from. */
	PUBLIC_URL?: string;
	TENCENT_REGION?: string;
	/** API URL template with `{service}`, e.g. https://{service}.tencentcloudapi.com/ (the default). */
	TENCENT_API_ENDPOINT?: string;
	NAME_PREFIX?: string;
	DEFAULT_MODEL?: string;
	/** Thinking level for new sessions that do not pick one: off, minimal, low, medium, high, xhigh or max. */
	DEFAULT_THINKING_LEVEL?: string;
	MIN_CPU?: string;
	MIN_MEMORY_GB?: string;
	MAX_HOURLY_PRICE?: string;
	PREFERRED_CATEGORY?: string;
	ZONES?: string;
	IDLE_MINUTES?: string;
	DATA_DISK_GB?: string;
	/** Idle minutes before the data disk is snapshotted and deleted; empty keeps it. */
	ARCHIVE_AFTER_MINUTES?: string;
	DATA_DISK_TYPE?: string;
	SYSTEM_DISK_TYPE?: string;
	SYSTEM_DISK_GB?: string;
	BANDWIDTH_MBPS?: string;
	NODE_MAJOR?: string;
	AGENT_SUDO?: string;
	ALLOW_ZONE_MIGRATION?: string;
	KEY_IDS?: string;
	SSH_CIDR?: string;
	VPC_ID?: string;
	SUBNET_ID?: string;
	SECURITY_GROUP_ID?: string;
	IMAGE_ID?: string;
}
