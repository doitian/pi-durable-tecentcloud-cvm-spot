import { describe, expect, it } from "vitest";
import { bootstrapScript } from "../src/bootstrap.ts";
import { classify, rankCandidates, type SelectionSettings } from "../src/cloud.ts";

const item = (type: string, family: string, cpu: number, memory: number, price: number, extra: object = {}) => ({
	Zone: "ap-singapore-3",
	InstanceType: type,
	InstanceFamily: family,
	Cpu: cpu,
	Memory: memory,
	Status: "SELL",
	StatusCategory: "EnoughStock",
	Price: { UnitPriceDiscount: price },
	...extra,
});

const catalog = [
	item("SA5.MEDIUM4", "SA5", 2, 4, 0.012),
	item("SA5.LARGE8", "SA5", 4, 8, 0.024),
	item("C6.LARGE8", "C6", 4, 8, 0.028),
	item("M6.LARGE32", "M6", 4, 32, 0.05),
	item("SR1.LARGE8", "SR1", 4, 8, 0.008, { CpuType: "Ampere Altra" }),
	item("GN7.LARGE20", "GN7", 4, 20, 0.2, { Gpu: 1 }),
	item("S5.SOLDOUT", "S5", 4, 8, 0.001, { StatusCategory: "WithoutStock" }),
];

const base: SelectionSettings = { minCpu: 2, minMemoryGb: 4, maxHourlyPrice: null, category: "general", zones: [] };

describe("rankCandidates", () => {
	it("drops ARM, GPU and out-of-stock types and prefers the category, then price", () => {
		expect(rankCandidates(catalog, base).map((c) => c.instanceType)).toEqual([
			"SA5.MEDIUM4",
			"SA5.LARGE8",
			"C6.LARGE8",
			"M6.LARGE32",
		]);
	});

	it("applies minimum size, price cap and category preference", () => {
		const ranked = rankCandidates(catalog, { ...base, minCpu: 4, minMemoryGb: 8, maxHourlyPrice: 0.03, category: "compute" });
		expect(ranked.map((c) => c.instanceType)).toEqual(["C6.LARGE8", "SA5.LARGE8"]);
	});

	it("excludes types on cooldown", () => {
		const ranked = rankCandidates(catalog, base, (_zone, type) => type === "SA5.MEDIUM4");
		expect(ranked[0]?.instanceType).toBe("SA5.LARGE8");
	});
});

describe("classify", () => {
	it("uses the family, then the memory ratio", () => {
		expect(classify("C6", 4, 8)).toBe("compute");
		expect(classify("MA3", 4, 32)).toBe("memory");
		expect(classify("SA5", 4, 8)).toBe("general");
		expect(classify("X9", 4, 64)).toBe("memory");
	});
});

describe("bootstrapScript", () => {
	it("embeds parameters as shell literals", () => {
		const script = bootstrapScript({
			hubUrl: "https://hub.example.workers.dev",
			agentToken: "abc123",
			diskId: "disk-xyz",
			formatIfEmpty: false,
			nodeMajor: 24,
			agentSudo: true,
		});
		expect(script).toContain("HUB_URL='https://hub.example.workers.dev'");
		expect(script).toContain("AGENT_TOKEN='abc123'");
		expect(script).toContain("FORMAT_IF_EMPTY=0");
		expect(script).toContain('SERIAL="${DISK_ID#disk-}"');
	});
});
