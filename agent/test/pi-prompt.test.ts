import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSections, loadContextFiles, loadSkills } from "../src/pi-prompt.ts";

let root: string;
let agentDir: string;
let repo: string;

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-prompt-"));
	agentDir = join(root, "home", ".pi", "agent");
	repo = join(root, "work", "repo");
	mkdirSync(join(repo, "pkg"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadContextFiles", () => {
	it("puts the agent directory first, then ancestors from the root down", () => {
		write(join(agentDir, "AGENTS.md"), "global");
		write(join(root, "work", "CLAUDE.md"), "work");
		write(join(repo, "AGENTS.md"), "repo");
		write(join(repo, "pkg", "AGENTS.md"), "pkg");
		const files = loadContextFiles(join(repo, "pkg"), agentDir).map((file) => file.content);
		expect(files).toEqual(["global", "work", "repo", "pkg"]);
	});

	it("prefers AGENTS.override.md over AGENTS.md and CLAUDE.md in the same directory", () => {
		write(join(repo, "AGENTS.md"), "plain");
		write(join(repo, "CLAUDE.md"), "claude");
		write(join(repo, "AGENTS.override.md"), "override");
		expect(loadContextFiles(repo, agentDir).map((file) => file.content)).toEqual(["override"]);
	});
});

describe("loadSkills", () => {
	it("finds SKILL.md directories and described top-level files; user skills win name collisions", () => {
		write(join(agentDir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: user deploy\n---\nbody");
		write(join(agentDir, "skills", "nested", "review", "SKILL.md"), "---\ndescription: Review code\n---\n");
		write(join(agentDir, "skills", "notes.md"), "---\nname: notes\ndescription: Take notes\n---\n");
		write(join(agentDir, "skills", "no-description", "SKILL.md"), "---\nname: x\n---\n");
		write(join(repo, ".pi", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: project deploy\n---\n");
		write(join(repo, ".pi", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint the repo\n---\n");
		const skills = loadSkills(repo, agentDir);
		const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill.description]));
		expect(byName).toEqual({ deploy: "user deploy", review: "Review code", notes: "Take notes", lint: "Lint the repo" });
	});
});

describe("buildSections", () => {
	it("renders pi's tagged sections with tool guidance, context files, visible skills and the spot rules", () => {
		const sections = buildSections("/data/work/s1", ["read", "bash", "edit", "write", "subagent"], {
			contextFiles: [{ path: "/data/work/s1/AGENTS.md", content: "Use pnpm." }],
			skills: [
				{ name: "lint", description: "Lint <things>", filePath: "/s/lint/SKILL.md", disableModelInvocation: false },
				{ name: "secret", description: "Only on request", filePath: "/s/secret/SKILL.md", disableModelInvocation: true },
			],
		});
		expect(sections.preamble).toMatch(/^You are an expert coding assistant operating inside pi/);
		expect(sections.tools).toContain("- subagent: Delegate a self-contained task");
		expect(sections.rules).toContain("- Use edit for precise changes");
		expect(sections.rules).toContain("spot VM");
		expect(sections.project_context).toContain('<project_instructions path="/data/work/s1/AGENTS.md">\nUse pnpm.');
		expect(sections.skills).toContain("<name>lint</name>");
		expect(sections.skills).toContain("Lint &lt;things&gt;");
		expect(sections.skills).not.toContain("secret");
		expect(sections.cwd).toBe("<cwd>\n/data/work/s1\n</cwd>");
	});

	it("omits project context and skills when there are none", () => {
		const sections = buildSections("/w", ["read"], { contextFiles: [], skills: [] });
		expect(Object.keys(sections)).toEqual(["preamble", "tools", "rules", "cwd"]);
	});
});
