import { TencentApiError, type TencentCloud } from "./tencent.ts";

export type Category = "general" | "compute" | "memory" | "any";

export interface SelectionSettings {
	minCpu: number;
	minMemoryGb: number;
	/** Upper limit for the spot hourly price of CPU and memory, in the account's currency. */
	maxHourlyPrice: number | null;
	category: Category;
	/** Allowed zones; empty means every zone in the region. */
	zones: string[];
}

export interface Candidate {
	zone: string;
	instanceType: string;
	family: string;
	typeName: string;
	cpu: number;
	memoryGb: number;
	hourlyPrice: number | null;
	category: Exclude<Category, "any">;
	stock: string;
}

interface QuotaItem {
	Zone: string;
	InstanceType: string;
	InstanceFamily: string;
	TypeName?: string;
	Cpu: number;
	Memory: number;
	Status: string;
	StatusCategory?: string;
	CpuType?: string;
	Gpu?: number;
	Fpga?: number;
	GpuCount?: number;
	Price?: { UnitPrice?: number; UnitPriceDiscount?: number; ChargeUnit?: string };
}

const STOCK_RANK: Record<string, number> = { EnoughStock: 0, NormalStock: 1, UnderStock: 2 };

/** Tencent family prefixes: S/SA/SN standard, C/CN compute-optimised, M/MA memory-optimised. */
export function classify(family: string, cpu: number, memoryGb: number): Exclude<Category, "any"> {
	if (/^(C|CN|CA)\d/i.test(family)) return "compute";
	if (/^(M|MA)\d/i.test(family)) return "memory";
	if (/^(S|SA|SN)\d/i.test(family)) return "general";
	const ratio = memoryGb / cpu;
	return ratio <= 2 ? "compute" : ratio >= 8 ? "memory" : "general";
}

function isUsableFamily(item: QuotaItem): boolean {
	if ((item.Gpu ?? 0) > 0 || (item.Fpga ?? 0) > 0 || (item.GpuCount ?? 0) > 0) return false;
	// The bootstrap installs x86_64 builds; ARM families need a different image and toolchain.
	if (/^SR\d/i.test(item.InstanceFamily) || /ampere|arm|kunpeng|yitian/i.test(item.CpuType ?? "")) return false;
	if (/^BM/i.test(item.InstanceFamily) || /bare metal|裸金属|gpu|fpga/i.test(item.TypeName ?? "")) return false;
	return true;
}

export function rankCandidates(
	items: readonly QuotaItem[],
	settings: SelectionSettings,
	excluded: (zone: string, type: string) => boolean = () => false,
): Candidate[] {
	const candidates: Candidate[] = [];
	for (const item of items) {
		if (item.Status !== "SELL" || item.StatusCategory === "WithoutStock") continue;
		if (item.Cpu < settings.minCpu || item.Memory < settings.minMemoryGb) continue;
		if (!isUsableFamily(item) || excluded(item.Zone, item.InstanceType)) continue;
		const price = item.Price?.UnitPriceDiscount ?? item.Price?.UnitPrice ?? null;
		if (settings.maxHourlyPrice !== null && (price === null || price > settings.maxHourlyPrice)) continue;
		candidates.push({
			zone: item.Zone,
			instanceType: item.InstanceType,
			family: item.InstanceFamily,
			typeName: item.TypeName ?? item.InstanceFamily,
			cpu: item.Cpu,
			memoryGb: item.Memory,
			hourlyPrice: price,
			category: classify(item.InstanceFamily, item.Cpu, item.Memory),
			stock: item.StatusCategory ?? "Unknown",
		});
	}
	const preference = (c: Candidate) => (settings.category === "any" || c.category === settings.category ? 0 : 1);
	return candidates.sort(
		(a, b) =>
			preference(a) - preference(b) ||
			(a.hourlyPrice ?? Number.MAX_VALUE) - (b.hourlyPrice ?? Number.MAX_VALUE) ||
			(STOCK_RANK[a.stock] ?? 3) - (STOCK_RANK[b.stock] ?? 3) ||
			a.cpu - b.cpu,
	);
}

export async function listSpotCandidates(
	tc: TencentCloud,
	settings: SelectionSettings,
	zones: readonly string[],
	excluded?: (zone: string, type: string) => boolean,
): Promise<Candidate[]> {
	const filters: Array<{ Name: string; Values: string[] }> = [{ Name: "instance-charge-type", Values: ["SPOTPAID"] }];
	if (zones.length > 0) filters.push({ Name: "zone", Values: [...zones] });
	const result = await tc.cvm<{ InstanceTypeQuotaSet: QuotaItem[] }>("DescribeZoneInstanceConfigInfos", {
		Filters: filters,
	});
	return rankCandidates(result.InstanceTypeQuotaSet ?? [], settings, excluded);
}

/** Errors that no other instance type or zone can fix. */
export function isGlobalLaunchError(error: unknown): boolean {
	if (!(error instanceof TencentApiError)) return true;
	return /^(AuthFailure|UnauthorizedOperation|LimitExceeded|AccountQualificationRestrictions)|Balance|Arrears|Unpaid/i.test(
		error.code,
	);
}

export async function ensureSecurityGroup(tc: TencentCloud, name: string, sshCidr?: string): Promise<string> {
	const existing = await tc.vpc<{ SecurityGroupSet: Array<{ SecurityGroupId: string }> }>("DescribeSecurityGroups", {
		Filters: [{ Name: "security-group-name", Values: [name] }],
	});
	if (existing.SecurityGroupSet?.[0]) return existing.SecurityGroupSet[0].SecurityGroupId;
	const created = await tc.vpc<{ SecurityGroup: { SecurityGroupId: string } }>("CreateSecurityGroupWithPolicies", {
		GroupName: name,
		GroupDescription: "pi-spot agent: outbound only",
		SecurityGroupPolicySet: {
			Egress: [{ Protocol: "ALL", CidrBlock: "0.0.0.0/0", Action: "ACCEPT", PolicyDescription: "all outbound" }],
		},
	});
	const id = created.SecurityGroup.SecurityGroupId;
	if (sshCidr) {
		await tc.vpc("CreateSecurityGroupPolicies", {
			SecurityGroupId: id,
			SecurityGroupPolicySet: {
				Ingress: [{ Protocol: "TCP", Port: "22", CidrBlock: sshCidr, Action: "ACCEPT", PolicyDescription: "ssh" }],
			},
		});
	}
	return id;
}

/** The account's default VPC and its default subnet in `zone`, created when missing. */
export async function ensureDefaultSubnet(
	tc: TencentCloud,
	zone: string,
): Promise<{ vpcId: string; subnetId: string } | undefined> {
	const result = await tc.vpc<{ Vpc?: { VpcId?: string; SubnetId?: string } }>("CreateDefaultVpc", {
		Zone: zone,
		Force: true,
	});
	const { VpcId, SubnetId } = result.Vpc ?? {};
	// "0" means the account still has the classic network, which RunInstances uses without a VPC.
	if (!VpcId || VpcId === "0" || !SubnetId) return undefined;
	return { vpcId: VpcId, subnetId: SubnetId };
}

interface ImageItem {
	ImageId: string;
	ImageName: string;
	OsName?: string;
	Architecture?: string;
	ImageState?: string;
	CreatedTime?: string;
}

/** Newest official Ubuntu 24.04 x86_64 image in the region. */
export async function findUbuntuImage(tc: TencentCloud): Promise<string> {
	const result = await tc.cvm<{ ImageSet: ImageItem[] }>("DescribeImages", {
		Filters: [
			{ Name: "image-type", Values: ["PUBLIC_IMAGE"] },
			{ Name: "platform", Values: ["Ubuntu"] },
		],
		Limit: 100,
	});
	const images = (result.ImageSet ?? []).filter(
		(image) =>
			(image.ImageState ?? "NORMAL") === "NORMAL" &&
			(image.Architecture ?? "x86_64") === "x86_64" &&
			/24\.04/.test(`${image.ImageName} ${image.OsName ?? ""}`) &&
			!/gpu|cuda|深度学习/i.test(image.ImageName),
	);
	images.sort(
		(a, b) =>
			Number(/uefi/i.test(a.ImageName)) - Number(/uefi/i.test(b.ImageName)) ||
			(b.CreatedTime ?? "").localeCompare(a.CreatedTime ?? ""),
	);
	if (!images[0]) throw new Error("No public Ubuntu 24.04 x86_64 image found; set IMAGE_ID");
	return images[0].ImageId;
}

export interface DiskInfo {
	id: string;
	state: string;
	instanceId?: string;
	zone: string;
	sizeGb: number;
	deleteWithInstance: boolean;
}

export async function describeDisk(tc: TencentCloud, diskId: string): Promise<DiskInfo | undefined> {
	const result = await tc.cbs<{
		DiskSet: Array<{
			DiskId: string;
			DiskState: string;
			Attached: boolean;
			InstanceId?: string;
			Placement: { Zone: string };
			DiskSize: number;
			DeleteWithInstance?: boolean;
		}>;
	}>("DescribeDisks", { DiskIds: [diskId] });
	const disk = result.DiskSet?.[0];
	if (!disk) return undefined;
	return {
		id: disk.DiskId,
		state: disk.DiskState,
		...(disk.Attached && disk.InstanceId ? { instanceId: disk.InstanceId } : {}),
		zone: disk.Placement.Zone,
		sizeGb: disk.DiskSize,
		deleteWithInstance: disk.DeleteWithInstance ?? false,
	};
}

export interface DiskRequest {
	zone: string;
	sizeGb: number;
	diskType: string;
	name: string;
	tag: { key: string; value: string };
	snapshotId?: string;
}

export async function createDisk(tc: TencentCloud, request: DiskRequest): Promise<string> {
	const result = await tc.cbs<{ DiskIdSet: string[] }>("CreateDisks", {
		Placement: { Zone: request.zone },
		DiskChargeType: "POSTPAID_BY_HOUR",
		DiskType: request.diskType,
		DiskSize: request.sizeGb,
		DiskName: request.name,
		DiskCount: 1,
		Tags: [{ Key: request.tag.key, Value: request.tag.value }],
		...(request.snapshotId ? { SnapshotId: request.snapshotId } : {}),
	});
	const id = result.DiskIdSet?.[0];
	if (!id) throw new Error("CreateDisks returned no disk");
	return id;
}

export async function attachDisk(tc: TencentCloud, diskId: string, instanceId: string): Promise<void> {
	await tc.cbs("AttachDisks", { DiskIds: [diskId], InstanceId: instanceId });
}

export async function keepDiskOnTermination(tc: TencentCloud, diskId: string): Promise<void> {
	await tc.cbs("ModifyDiskAttributes", { DiskIds: [diskId], DeleteWithInstance: false });
}

export async function detachDisk(tc: TencentCloud, diskId: string, instanceId: string): Promise<void> {
	await tc.cbs("DetachDisks", { DiskIds: [diskId], InstanceId: instanceId });
}

export async function createSnapshot(tc: TencentCloud, diskId: string, name: string): Promise<string> {
	const result = await tc.cbs<{ SnapshotId: string }>("CreateSnapshot", { DiskId: diskId, SnapshotName: name });
	return result.SnapshotId;
}

export async function snapshotState(tc: TencentCloud, snapshotId: string): Promise<string | undefined> {
	const result = await tc.cbs<{ SnapshotSet: Array<{ SnapshotState: string }> }>("DescribeSnapshots", {
		SnapshotIds: [snapshotId],
	});
	return result.SnapshotSet?.[0]?.SnapshotState;
}

export interface InstanceInfo {
	id: string;
	state: string;
	zone: string;
	type: string;
	publicIp?: string;
}

/** Every instance carrying the pi-spot tag, keyed by ID. */
export async function describeTaggedInstances(
	tc: TencentCloud,
	tagKey: string,
	tagValue: string,
): Promise<Map<string, InstanceInfo>> {
	const result = await tc.cvm<{
		InstanceSet: Array<{
			InstanceId: string;
			InstanceState: string;
			InstanceType: string;
			Placement: { Zone: string };
			PublicIpAddresses?: string[] | null;
		}>;
	}>("DescribeInstances", { Filters: [{ Name: `tag:${tagKey}`, Values: [tagValue] }], Limit: 100 });
	return new Map(
		(result.InstanceSet ?? []).map((instance) => [
			instance.InstanceId,
			{
				id: instance.InstanceId,
				state: instance.InstanceState,
				zone: instance.Placement.Zone,
				type: instance.InstanceType,
				...(instance.PublicIpAddresses?.[0] ? { publicIp: instance.PublicIpAddresses[0] } : {}),
			},
		]),
	);
}

export interface LaunchRequest {
	zone: string;
	instanceType: string;
	imageId: string;
	subnet?: { vpcId: string; subnetId: string };
	securityGroupId: string;
	userData: string;
	name: string;
	maxPrice: number | null;
	keyIds: string[];
	bandwidthMbps: number;
	systemDiskType: string;
	systemDiskGb: number;
	clientToken: string;
	tag: { key: string; value: string };
}

export async function runSpotInstance(tc: TencentCloud, request: LaunchRequest): Promise<string> {
	const result = await tc.cvm<{ InstanceIdSet: string[] }>("RunInstances", {
		InstanceChargeType: "SPOTPAID",
		InstanceMarketOptions: {
			MarketType: "spot",
			SpotOptions: { MaxPrice: String(request.maxPrice ?? 1000), SpotInstanceType: "one-time" },
		},
		Placement: { Zone: request.zone },
		InstanceType: request.instanceType,
		ImageId: request.imageId,
		SystemDisk: { DiskType: request.systemDiskType, DiskSize: request.systemDiskGb },
		...(request.subnet
			? { VirtualPrivateCloud: { VpcId: request.subnet.vpcId, SubnetId: request.subnet.subnetId } }
			: {}),
		InternetAccessible: {
			InternetChargeType: "TRAFFIC_POSTPAID_BY_HOUR",
			InternetMaxBandwidthOut: request.bandwidthMbps,
			PublicIpAssigned: true,
		},
		InstanceCount: 1,
		InstanceName: request.name,
		LoginSettings: request.keyIds.length > 0 ? { KeyIds: request.keyIds } : { Password: randomPassword() },
		SecurityGroupIds: [request.securityGroupId],
		EnhancedService: { SecurityService: { Enabled: true }, MonitorService: { Enabled: true } },
		UserData: request.userData,
		ClientToken: request.clientToken,
		TagSpecification: [{ ResourceType: "instance", Tags: [{ Key: request.tag.key, Value: request.tag.value }] }],
	});
	const id = result.InstanceIdSet?.[0];
	if (!id) throw new Error("RunInstances returned no instance");
	return id;
}

export async function terminateInstance(tc: TencentCloud, instanceId: string): Promise<void> {
	try {
		await tc.cvm("TerminateInstances", { InstanceIds: [instanceId] });
	} catch (error) {
		if (error instanceof TencentApiError && /NotFound|InstanceIdNotFound/i.test(error.code)) return;
		throw error;
	}
}

/** Nobody logs in with it; it only satisfies RunInstances when no SSH key is configured. */
function randomPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	const body = btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "x");
	return `Pi-${body}#9`;
}
