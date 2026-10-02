import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 600_000) {
	return run("git", args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 });
}

/** Points git at gh for GitHub credentials and sets the commit identity, once per boot. */
export async function configureGit(): Promise<void> {
	const name = process.env.GIT_USER_NAME;
	const email = process.env.GIT_USER_EMAIL;
	if (name) await run("git", ["config", "--global", "user.name", name]);
	if (email) await run("git", ["config", "--global", "user.email", email]);
	if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
		await run("gh", ["auth", "setup-git"]).catch((error) => console.warn("gh auth setup-git failed:", error.message));
	}
}

/** Creates the session workspace: a clone of `repoUrl`, or an empty repository. */
export async function prepareWorkspace(cwd: string, repoUrl?: string, branch?: string): Promise<void> {
	if (existsSync(join(cwd, ".git"))) {
		await removeStaleLocks(cwd);
		return;
	}
	if (repoUrl) {
		const partial = `${cwd}.cloning`;
		await mkdir(dirname(cwd), { recursive: true });
		await rm(partial, { recursive: true, force: true });
		await git(dirname(cwd), ["clone", ...(branch ? ["--branch", branch] : []), repoUrl, partial]);
		await rename(partial, cwd);
	} else {
		await mkdir(cwd, { recursive: true });
		await git(cwd, ["init", "-q"]);
	}
}

/** A killed git process leaves `index.lock` behind; nothing else can hold it right after boot. */
async function removeStaleLocks(cwd: string): Promise<void> {
	await rm(join(cwd, ".git", "index.lock"), { force: true });
}

/**
 * Pushes the working tree, including untracked files, as a commit on `pi-wip/<session>` without touching the
 * real index or branch. Insurance against losing the data disk; opt in with PI_WIP_PUSH=1.
 */
export async function pushWipSnapshot(cwd: string, sessionId: string): Promise<void> {
	if (!existsSync(join(cwd, ".git"))) return;
	const { stdout: remotes } = await git(cwd, ["remote"]);
	if (!remotes.trim().split("\n").includes("origin")) return;
	const scratch = await mkdtemp(join(tmpdir(), "pi-wip-"));
	const index = join(scratch, "index");
	try {
		if (existsSync(join(cwd, ".git", "index"))) await copyFile(join(cwd, ".git", "index"), index);
		const env = { ...process.env, GIT_INDEX_FILE: index };
		await git(cwd, ["add", "-A"], env, 30_000);
		const { stdout: tree } = await git(cwd, ["write-tree"], env, 30_000);
		const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).then((r) => r.stdout.trim(), () => "");
		const parents = head ? ["-p", head] : [];
		const message = `wip: spot reclaim snapshot ${new Date().toISOString()}`;
		const { stdout: commit } = await git(cwd, ["commit-tree", tree.trim(), ...parents, "-m", message], env, 30_000);
		await git(cwd, ["push", "-f", "origin", `${commit.trim()}:refs/heads/pi-wip/${sessionId}`], env, 45_000);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
