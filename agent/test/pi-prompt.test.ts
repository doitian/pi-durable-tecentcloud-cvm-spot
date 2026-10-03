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
	const home = () => join(root, "home");
	const frontmatter = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;
	const byName = (cwd: string) => Object.fromEntries(loadSkills(cwd, agentDir, home()).map((skill) => [skill.name, skill.description]));

	// Keeps the upward search inside the temporary directory, away from the real home's ~/.agents/skills.
	beforeEach(() => mkdirSync(join(root, ".git")));

	it("finds SKILL.md directories and described top-level files; project skills win name collisions", () => {
		write(join(agentDir, "skills", "deploy", "SKILL.md"), `${frontmatter("deploy", "user deploy")}body`);
		write(join(agentDir, "skills", "nested", "review", "SKILL.md"), "---\ndescription: Review code\n---\n");
		write(join(agentDir, "skills", "notes.md"), frontmatter("notes", "Take notes"));
		write(join(agentDir, "skills", "no-description", "SKILL.md"), "---\nname: x\n---\n");
		write(join(repo, ".pi", "skills", "deploy", "SKILL.md"), frontmatter("deploy", "project deploy"));
		write(join(repo, ".pi", "skills", "lint", "SKILL.md"), frontmatter("lint", "Lint the repo"));
		expect(byName(repo)).toEqual({ deploy: "project deploy", lint: "Lint the repo", review: "Review code", notes: "Take notes" });
	});

	it("reads .agents/skills from the working directory up to the repository root, and ~/.agents/skills", () => {
		mkdirSync(join(repo, ".git"));
		write(join(repo, "pkg", ".agents", "skills", "pkg-skill", "SKILL.md"), frontmatter("pkg-skill", "from pkg"));
		write(join(repo, ".agents", "skills", "repo-skill", "SKILL.md"), frontmatter("repo-skill", "from the repo root"));
		write(join(repo, ".agents", "skills", "loose.md"), frontmatter("loose", "top-level files are not skills here"));
		write(join(repo, ".agents", "skills", "group", "grouped.md"), frontmatter("grouped", "nested loose file"));
		write(join(root, "work", ".agents", "skills", "outside", "SKILL.md"), frontmatter("outside", "above the repository"));
		write(join(home(), ".agents", "skills", "mine", "SKILL.md"), frontmatter("mine", "user agent skill"));
		write(join(home(), ".agents", "skills", "repo-skill", "SKILL.md"), frontmatter("repo-skill", "loses to the project"));
		expect(byName(join(repo, "pkg"))).toEqual({
			"pkg-skill": "from pkg",
			"repo-skill": "from the repo root",
			grouped: "nested loose file",
			mine: "user agent skill",
		});
	});

	it("walks past a workspace that is not a repository, up to the enclosing one", () => {
		write(join(root, "work", ".agents", "skills", "outside", "SKILL.md"), frontmatter("outside", "above the workspace"));
		expect(byName(repo)).toEqual({ outside: "above the workspace" });
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
