// A fake Tencent Cloud API (CVM, CBS, VPC subset) plus instance metadata, for exercising the Hub's lifecycle logic
// without a cloud account. Each "instance" is a local agent process started once its data disk is attached; every
// instance shares one local directory as the persistent data disk.
//
//   node sim/tencent-sim.mjs            # API on http://127.0.0.1:8790/{service}
//   curl -X POST 127.0.0.1:8790/_sim/reclaim     # spot-reclaim the running instance in 70 s
//   curl 127.0.0.1:8790/_sim/state
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SIM_PORT ?? 8790);
const HUB_URL = process.env.SIM_HUB_URL ?? "http://127.0.0.1:8787";
const DATA_DIR = process.env.SIM_DATA_DIR ?? join(root, ".local-data");
const RECLAIM_NOTICE_MS = Number(process.env.SIM_RECLAIM_NOTICE_MS ?? 70_000);
// The real API answers in a few hundred milliseconds; races in the Hub only show up with comparable latency.
const LATENCY_MS = Number(process.env.SIM_LATENCY_MS ?? 0);

const instances = new Map();
const disks = new Map();
const snapshots = new Map();
const securityGroups = new Map();
let counter = 0;
const newId = (prefix) => `${prefix}-${(Date.now() + counter++).toString(36)}`;
const later = (ms, fn) => setTimeout(fn, ms);
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const QUOTAS = [];
for (const zone of ["ap-singapore-1", "ap-singapore-2", "ap-singapore-3", "ap-singapore-4"]) {
	const add = (type, family, cpu, mem, price, extra = {}) =>
		QUOTAS.push({
			Zone: zone, InstanceType: type, InstanceFamily: family, TypeName: family, Cpu: cpu, Memory: mem,
			Status: "SELL", StatusCategory: "EnoughStock", InstanceChargeType: "SPOTPAID",
			Price: { UnitPrice: price * 5, UnitPriceDiscount: price, ChargeUnit: "HOUR" }, ...extra,
		});
	add("SA5.MEDIUM4", "SA5", 2, 4, 0.012);
	add("SA5.LARGE8", "SA5", 4, 8, 0.024);
	add("S5.LARGE8", "S5", 4, 8, 0.03);
	add("C6.LARGE8", "C6", 4, 8, 0.028);
	add("C6.LARGE4", "C6", 4, 4, 0.02);
	add("M6.LARGE32", "M6", 4, 32, 0.05);
	add("SR1.LARGE8", "SR1", 4, 8, 0.008, { CpuType: "Ampere Altra" });
	add("GN7.LARGE20", "GN7", 4, 20, 0.2, { Gpu: 1, GpuCount: 1 });
}

function fail(code, message) {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function filterValue(params, name) {
	return params.Filters?.find((filter) => filter.Name === name)?.Values;
}

function startAgent(instance) {
	if (instance.proc) return;
	log(`boot ${instance.id}: starting agent`);
	instance.proc = spawn(process.execPath, [join(root, "worker/public/agent/agent.mjs")], {
		env: {
			...process.env,
			PI_HUB_URL: HUB_URL,
			PI_INSTANCE_ID: instance.id,
			PI_AGENT_TOKEN: instance.token,
			PI_DATA_DIR: DATA_DIR,
			PI_FAUX: "1",
			PI_METADATA_URL: `http://127.0.0.1:${PORT}/meta/${instance.id}`,
			PI_SPOT_POLL_MS: "1000",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const prefix = `[${instance.id}]`;
	instance.proc.stdout.on("data", (d) => process.stdout.write(`${prefix} ${d}`));
	instance.proc.stderr.on("data", (d) => process.stdout.write(`${prefix} ${d}`));
	instance.proc.on("exit", (code) => {
		log(`${instance.id}: agent exited (${code})`);
		instance.proc = undefined;
	});
}

function destroy(instance, reason) {
	log(`destroy ${instance.id}: ${reason}`);
	instance.proc?.kill("SIGKILL");
	instance.state = "TERMINATING";
	for (const disk of disks.values()) {
		if (disk.instanceId === instance.id) {
			disk.instanceId = undefined;
			disk.state = "UNATTACHED";
		}
	}
	later(3000, () => instances.delete(instance.id));
}

function maybeBoot(instance) {
	const attached = [...disks.values()].some((disk) => disk.instanceId === instance.id && disk.state === "ATTACHED");
	if (instance.state === "RUNNING" && attached && instance.userDataOk) startAgent(instance);
}

const handlers = {
	DescribeZoneInstanceConfigInfos(params) {
		const zones = filterValue(params, "zone");
		return { InstanceTypeQuotaSet: QUOTAS.filter((q) => !zones || zones.includes(q.Zone)) };
	},
	DescribeImages() {
		return {
			ImageSet: [
				{ ImageId: "img-ubuntu2404", ImageName: "Ubuntu Server 24.04 LTS 64bit", Architecture: "x86_64", ImageState: "NORMAL", CreatedTime: "2026-01-01T00:00:00Z" },
				{ ImageId: "img-ubuntu2204", ImageName: "Ubuntu Server 22.04 LTS 64bit", Architecture: "x86_64", ImageState: "NORMAL", CreatedTime: "2025-01-01T00:00:00Z" },
			],
		};
	},
	DescribeSecurityGroups(params) {
		const names = filterValue(params, "security-group-name") ?? [];
		return { SecurityGroupSet: [...securityGroups.values()].filter((g) => names.includes(g.SecurityGroupName)) };
	},
	CreateSecurityGroupWithPolicies(params) {
		if (!params.SecurityGroupPolicySet?.Egress?.length) fail("InvalidParameter", "egress expected");
		const group = { SecurityGroupId: newId("sg"), SecurityGroupName: params.GroupName };
		securityGroups.set(group.SecurityGroupId, group);
		return { SecurityGroup: group };
	},
	CreateDefaultVpc(params) {
		return { Vpc: { VpcId: "vpc-default", SubnetId: `subnet-${params.Zone}` } };
	},
	RunInstances(params) {
		if (params.InstanceChargeType !== "SPOTPAID") fail("InvalidParameter", "expected SPOTPAID");
		if (params.InstanceMarketOptions?.MarketType !== "spot") fail("InvalidParameter", "expected spot market");
		const quota = QUOTAS.find((q) => q.Zone === params.Placement.Zone && q.InstanceType === params.InstanceType);
		if (!quota) fail("InvalidParameterValue.InstanceTypeNotFound", params.InstanceType);
		if (process.env.SIM_SOLD_OUT?.split(",").includes(params.InstanceType)) {
			fail("ResourceInsufficient.SpecifiedInstanceType", `${params.InstanceType} sold out`);
		}
		const script = Buffer.from(params.UserData, "base64").toString("utf8");
		const token = /^AGENT_TOKEN='([0-9a-f]+)'$/m.exec(script)?.[1];
		const diskId = /^DISK_ID='([^']+)'$/m.exec(script)?.[1];
		const id = newId("ins");
		instances.set(id, {
			id, token, state: "PENDING", zone: params.Placement.Zone, type: params.InstanceType,
			tags: params.TagSpecification?.[0]?.Tags ?? [], userDataOk: !!token && disks.has(diskId),
		});
		log(`RunInstances ${id} ${params.InstanceType} in ${params.Placement.Zone} (disk ${diskId})`);
		later(2000, () => {
			const instance = instances.get(id);
			if (instance?.state === "PENDING") {
				instance.state = "RUNNING";
				maybeBoot(instance);
			}
		});
		return { InstanceIdSet: [id] };
	},
	DescribeInstances(params) {
		const tagFilter = params.Filters?.find((f) => f.Name.startsWith("tag:"));
		const set = [...instances.values()].filter(
			(i) => !tagFilter || i.tags.some((t) => `tag:${t.Key}` === tagFilter.Name && tagFilter.Values.includes(t.Value)),
		);
		return {
			InstanceSet: set.map((i) => ({ InstanceId: i.id, InstanceState: i.state, InstanceType: i.type, Placement: { Zone: i.zone } })),
		};
	},
	TerminateInstances(params) {
		for (const id of params.InstanceIds) {
			const instance = instances.get(id);
			if (!instance) fail("InvalidInstanceId.NotFound", id);
			destroy(instance, "TerminateInstances");
		}
		return {};
	},
	CreateDisks(params) {
		const id = newId("disk");
		disks.set(id, { id, state: "CREATING", zone: params.Placement.Zone, size: params.DiskSize, deleteWithInstance: false });
		log(`CreateDisks ${id} ${params.DiskSize}GB in ${params.Placement.Zone}${params.SnapshotId ? ` from ${params.SnapshotId}` : ""}`);
		later(1000, () => (disks.get(id).state = "UNATTACHED"));
		return { DiskIdSet: [id] };
	},
	DescribeDisks(params) {
		return {
			DiskSet: params.DiskIds.filter((id) => disks.has(id)).map((id) => {
				const d = disks.get(id);
				return { DiskId: d.id, DiskState: d.state, Attached: !!d.instanceId, InstanceId: d.instanceId ?? "", Placement: { Zone: d.zone }, DiskSize: d.size, DeleteWithInstance: d.deleteWithInstance };
			}),
		};
	},
	AttachDisks(params) {
		const instance = instances.get(params.InstanceId);
		if (!instance || instance.state !== "RUNNING") fail("InvalidInstance.NotSupported", "instance not running");
		for (const id of params.DiskIds) {
			const disk = disks.get(id);
			if (disk.state !== "UNATTACHED") fail("ResourceBusy", `disk is ${disk.state}`);
			if (disk.zone !== instance.zone) fail("InvalidParameter", "zone mismatch");
			disk.state = "ATTACHING";
			disk.instanceId = instance.id;
			log(`AttachDisks ${id} -> ${instance.id}`);
			later(2000, () => {
				disk.state = "ATTACHED";
				maybeBoot(instance);
			});
		}
		return {};
	},
	DetachDisks(params) {
		for (const id of params.DiskIds) {
			const disk = disks.get(id);
			if (disk.state !== "ATTACHED") fail("ResourceBusy", `disk is ${disk.state}`);
			disk.state = "DETACHING";
			log(`DetachDisks ${id} from ${disk.instanceId}`);
			later(2000, () => {
				disk.state = "UNATTACHED";
				disk.instanceId = undefined;
			});
		}
		return {};
	},
	ModifyDiskAttributes(params) {
		for (const id of params.DiskIds) disks.get(id).deleteWithInstance = params.DeleteWithInstance;
		return {};
	},
	TerminateDisks(params) {
		for (const id of params.DiskIds) {
			const disk = disks.get(id);
			if (!disk) fail("InvalidDisk.NotFound", id);
			if (disk.state !== "UNATTACHED") fail("ResourceBusy", `disk is ${disk.state}`);
			disks.delete(id);
			log(`TerminateDisks ${id}`);
		}
		return {};
	},
	DeleteSnapshots(params) {
		for (const id of params.SnapshotIds) {
			snapshots.delete(id);
			log(`DeleteSnapshots ${id}`);
		}
		return {};
	},
	CreateSnapshot(params) {
		const id = newId("snap");
		snapshots.set(id, { id, state: "CREATING", diskId: params.DiskId });
		later(3000, () => (snapshots.get(id).state = "NORMAL"));
		return { SnapshotId: id };
	},
	DescribeSnapshots(params) {
		return { SnapshotSet: params.SnapshotIds.map((id) => ({ SnapshotId: id, SnapshotState: snapshots.get(id)?.state })) };
	},
};

function reclaim() {
	const instance = [...instances.values()].find((i) => i.state === "RUNNING");
	if (!instance) return { error: "no running instance" };
	instance.reclaimAt = Date.now() + RECLAIM_NOTICE_MS;
	log(`spot reclaim of ${instance.id} scheduled in ${RECLAIM_NOTICE_MS / 1000}s`);
	later(RECLAIM_NOTICE_MS, () => instances.get(instance.id)?.state === "RUNNING" && destroy(instance, "spot reclaim"));
	return { id: instance.id, reclaimAt: instance.reclaimAt };
}

function utc8(ms) {
	return new Date(ms + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

createServer(async (req, res) => {
	const url = new URL(req.url, "http://sim");
	const send = (status, body) => {
		res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	};
	const meta = /^\/meta\/([^/]+)\/spot\/termination-time$/.exec(url.pathname);
	if (meta) {
		const instance = instances.get(meta[1]);
		return instance?.reclaimAt ? send(200, utc8(instance.reclaimAt)) : send(404, "Not Found");
	}
	if (url.pathname === "/_sim/reclaim" && req.method === "POST") return send(200, reclaim());
	if (url.pathname === "/_sim/state") {
		return send(200, {
			instances: [...instances.values()].map(({ proc, ...i }) => ({ ...i, agent: !!proc })),
			disks: [...disks.values()],
			snapshots: [...snapshots.values()],
		});
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const action = req.headers["x-tc-action"];
	if (!req.headers.authorization?.startsWith("TC3-HMAC-SHA256 Credential=")) {
		return send(200, { Response: { Error: { Code: "AuthFailure.SignatureFailure", Message: "unsigned" } } });
	}
	const handler = handlers[action];
	if (LATENCY_MS > 0) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
	try {
		if (!handler) fail("InvalidAction", `${action} is not simulated`);
		send(200, { Response: { ...handler(JSON.parse(body || "{}")), RequestId: newId("req") } });
	} catch (error) {
		log(`${action} -> ${error.code ?? "InternalError"}: ${error.message}`);
		send(200, { Response: { Error: { Code: error.code ?? "InternalError", Message: error.message }, RequestId: newId("req") } });
	}
}).listen(PORT, "127.0.0.1", () => log(`tencent simulator on http://127.0.0.1:${PORT}`));
