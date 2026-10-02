// pi's system prompt on pi-durable, ported from pi's coding agent (MIT): core/system-prompt.ts, the tool prompt
// contributions in core/tools/*.ts, context files from core/resource-loader.ts, skills from core/skills.ts, and the
// glue in experimental/durable/prompt.ts. None of these are exported by the published package.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { parse as parseYaml } from "yaml";

const TOOL_CONTRIBUTIONS: Record<string, { snippet: string; guidelines: string[] }> = {
	read: { snippet: "Read file contents", guidelines: ["Use read to examine files instead of cat or sed."] },
	bash: {
		snippet: "Execute bash commands (ls, grep, find, etc.)",
		guidelines: ["You can inspect PI_* environment variables for current model and session details."],
	},
	edit: {
		snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		guidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
	},
	write: { snippet: "Create or overwrite files", guidelines: ["Use write only for new files or complete rewrites."] },
	subagent: {
		snippet: "Delegate a self-contained task to a subagent with the same tools and get its answer back",
		guidelines: ["Give a subagent everything it needs to know; it does not see this conversation."],
	},
};

/** Rules specific to running unattended on a replaceable spot VM. */
const SPOT_RULES = [
	"You run unattended on a cloud spot VM that can be replaced at any moment. The conversation and the working directory survive a replacement; running processes and system packages installed with sudo do not, so prefer project-local installs.",
	"When a tool result says it was interrupted, check the real state first (git status, git log, gh pr list, ...) before repeating a command with side effects such as git push or gh pr create.",
	"git and the GitHub CLI (gh) are installed and authenticated when a token is configured. Commit meaningful progress regularly.",
];

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface ContextFile {
	path: string;
	content: string;
}

interface Skill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation: boolean;
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function contextFileIn(dir: string): ContextFile | undefined {
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(dir, name);
		try {
			if (existsSync(path) && statSync(path).isFile()) return { path, content: stripBom(readFileSync(path, "utf8")) };
		} catch {
			// Unreadable files are skipped, as pi does.
		}
	}
	return undefined;
}

/** pi's order: the agent directory's file, then each directory from the filesystem root down to `cwd`. */
export function loadContextFiles(cwd: string, agentDir: string): ContextFile[] {
	const files: ContextFile[] = [];
	const seen = new Set<string>();
	const global = contextFileIn(resolve(agentDir));
	if (global) {
		files.push(global);
		seen.add(global.path);
	}
	const ancestors: ContextFile[] = [];
	let dir = resolve(cwd);
	while (true) {
		const file = contextFileIn(dir);
		if (file && !seen.has(file.path)) {
			ancestors.unshift(file);
			seen.add(file.path);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...files, ...ancestors];
}

function parseFrontmatter(text: string): Record<string, unknown> | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(stripBom(text));
	if (!match) return {};
	const parsed: unknown = parseYaml(match[1]!);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

function skillFromFile(filePath: string): Skill | undefined {
	let frontmatter: Record<string, unknown> | undefined;
	try {
		frontmatter = parseFrontmatter(readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
	const description = frontmatter?.description;
	if (typeof description !== "string" || description.trim() === "") return undefined;
	const name = typeof frontmatter?.name === "string" && frontmatter.name ? frontmatter.name : basename(dirname(filePath));
	return { name, description, filePath, disableModelInvocation: frontmatter?.["disable-model-invocation"] === true };
}

/**
 * pi's discovery: a directory holding SKILL.md is one skill; otherwise its subdirectories are searched (skipping
 * dot directories and node_modules), and top-level .md files with a description are skills too.
 */
function skillsIn(dir: string, topLevel: boolean): Skill[] {
	if (!existsSync(dir)) return [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const declared = entries.find((entry) => entry.name === "SKILL.md");
	if (declared) {
		const skill = skillFromFile(join(dir, "SKILL.md"));
		return skill ? [skill] : [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(path);
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}
		if (isDirectory) skills.push(...skillsIn(path, false));
		else if (isFile && topLevel && entry.name.endsWith(".md")) {
			const skill = skillFromFile(path);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}

/** User skills (`<agentDir>/skills`) win name collisions over project skills (`<cwd>/.pi/skills`), as in pi. */
export function loadSkills(cwd: string, agentDir: string): Skill[] {
	const byName = new Map<string, Skill>();
	const realPaths = new Set<string>();
	for (const skill of [...skillsIn(join(resolve(agentDir), "skills"), true), ...skillsIn(resolve(cwd, ".pi", "skills"), true)]) {
		let real = skill.filePath;
		try {
			real = realpathSync(skill.filePath);
		} catch {
			// Keep the given path.
		}
		if (realPaths.has(real) || byName.has(skill.name)) continue;
		realPaths.add(real);
		byName.set(skill.name, skill);
	}
	return [...byName.values()];
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function formatSkills(skills: Skill[], readTool: "read" | "bash"): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	return [
		"The following skills provide specialized instructions for specific tasks.",
		readTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
		...visible.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.filePath)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

function buildRules(tools: string[]): string {
	const rules: string[] = [];
	const add = (rule: string) => {
		if (rule.trim() && !rules.includes(rule.trim())) rules.push(rule.trim());
	};
	if (tools.includes("bash")) add("Use bash for file operations like ls, rg, find");
	for (const name of tools) for (const rule of TOOL_CONTRIBUTIONS[name]?.guidelines ?? []) add(rule);
	for (const rule of SPOT_RULES) add(rule);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

export interface PiPromptSources {
	contextFiles: ContextFile[];
	skills: Skill[];
}

/** pi's sections in pi's order; each but the preamble is wrapped in a tag so later updates replace it in place. */
export function buildSections(cwd: string, tools: string[], sources: PiPromptSources): Record<string, string> {
	const raw: Record<string, string> = {};
	const visible = tools.filter((name) => TOOL_CONTRIBUTIONS[name]);
	raw.tools = `${visible.length > 0 ? visible.map((name) => `- ${name}: ${TOOL_CONTRIBUTIONS[name]!.snippet}`).join("\n") : "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
	raw.rules = buildRules(tools);
	if (sources.contextFiles.length > 0) {
		raw.project_context = [
			"Project-specific instructions and guidelines:",
			...sources.contextFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
		].join("\n\n");
	}
	const readTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
	const skills = readTool ? formatSkills(sources.skills, readTool) : "";
	if (skills) raw.skills = skills;
	raw.cwd = cwd.replace(/\\/g, "/");
	const sections: Record<string, string> = {
		preamble:
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
	};
	for (const [name, content] of Object.entries(raw)) sections[name] = `<${name}>\n${content}\n</${name}>`;
	return sections;
}

const KEYS = ["preamble", "tools", "rules", "project_context", "skills", "cwd"] as const;
const SOURCES_TTL_MS = 30_000;

/**
 * The extension that renders pi's prompt before each request. Context files and skills are re-read at most every
 * 30 seconds, so an AGENTS.md the agent edits takes effect on a later request; unchanged sections are not resent.
 */
export function createPiPrompt(agentDir: string, fallbackCwd: string) {
	const cache = new Map<string, { at: number; sources: PiPromptSources }>();
	const sourcesFor = (cwd: string): PiPromptSources => {
		const cached = cache.get(cwd);
		if (cached && Date.now() - cached.at < SOURCES_TTL_MS) return cached.sources;
		const sources = { contextFiles: loadContextFiles(cwd, agentDir), skills: loadSkills(cwd, agentDir) };
		cache.set(cwd, { at: Date.now(), sources });
		return sources;
	};
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (!sections) {
			const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
			sections = buildSections(cwd, input.agent.tools.map((tool) => tool.name), sourcesFor(cwd));
			built.set(input, sections);
		}
		return sections;
	};
	return defineExtension({
		name: "pi-prompt",
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
