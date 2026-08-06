import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configSchema } from "../src/config.ts";
import {
  acquireWorktreeWatcherLock,
  cleanupIsolatedWorktree,
  commitWorktreeBatch,
  getWorktreeStatus,
  mergeIsolatedWorktree,
  prepareIsolatedWorktree,
} from "../src/worktree.ts";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cwd: string, command: string[], allowed = [0]): Promise<CommandResult> {
  const process = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (!allowed.includes(exitCode)) {
    throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

const root = join(import.meta.dirname, "tmp-worktree-repo");
const externalWorktreeRoot = join(dirname(root), ".hypervigilant-worktrees");
const externalWorktrees = join(externalWorktreeRoot, "tmp-worktree-repo");

async function createRepository(): Promise<void> {
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".hypervigilant/\nhypervigilant.toml\n");
  await writeFile(join(root, "docs", "SPEC.md"), "Version 1\n");
  await writeFile(join(root, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
  await writeFile(join(root, "unrelated.txt"), "unchanged\n");
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.name", "Hypervigilant Test"]);
  await run(root, ["git", "config", "user.email", "hypervigilant@example.com"]);
  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial"]);
  await writeFile(join(root, "hypervigilant.toml"), "# generated config\n");
  await mkdir(join(root, ".hypervigilant"), { recursive: true });
}

function config() {
  return configSchema.parse({
    version: 1,
    project: "Worktree Demo",
    agentId: "agent-test",
    worktree: { enabled: true, autoCommit: true, branchPrefix: "hv/reviews" },
  });
}

describe("isolated worktrees", () => {
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(externalWorktreeRoot, { recursive: true, force: true });
    await createRepository();
  });

  afterEach(async () => {
    try {
      await run(root, ["git", "worktree", "prune"]);
    } catch {
      // The test may remove the repository before a worktree exists.
    }
    await rm(root, { recursive: true, force: true });
    await rm(externalWorktreeRoot, { recursive: true, force: true });
  });

  it("creates and reuses a branch without changing the source checkout", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    expect(context.branch.startsWith("hv/reviews/worktree-demo-")).toBe(true);
    expect(context.worktreeRepoRoot.startsWith(externalWorktrees)).toBe(true);
    expect(await readFile(join(context.watchedRoot, "docs", "SPEC.md"), "utf8")).toBe(
      "Version 1\n",
    );
    expect((await run(root, ["git", "status", "--porcelain"])).stdout).toBe("");

    const resumed = await prepareIsolatedWorktree(root, config());
    expect(resumed.branch).toBe(context.branch);
    expect(resumed.worktreeRepoRoot).toBe(context.worktreeRepoRoot);
  });

  it("does not create duplicate branches during concurrent preparation", async () => {
    const results = await Promise.allSettled([
      prepareIsolatedWorktree(root, config()),
      prepareIsolatedWorktree(root, config()),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const branches = (
      await run(root, ["git", "branch", "--list", "hv/reviews/*", "--format=%(refname:short)"])
    ).stdout
      .split("\n")
      .filter(Boolean);
    expect(branches).toHaveLength(1);
  });

  it("commits only batch paths and leaves unrelated staged work alone", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    await writeFile(join(context.watchedRoot, "docs", "SPEC.md"), "Version 2\n");
    await writeFile(
      join(context.watchedRoot, "src", "greeting.ts"),
      'export const greeting = "Hi";\n',
    );
    await writeFile(join(context.worktreeRepoRoot, "unrelated.txt"), "keep staged\n");
    await run(context.worktreeRepoRoot, ["git", "add", "unrelated.txt"]);

    const committed = await commitWorktreeBatch(
      context,
      ["docs/SPEC.md", "src/greeting.ts"],
      "Worktree Demo",
    );
    expect(committed?.mergeCommand).toContain(`merge '${context.branch}'`);
    const committedPaths = (
      await run(context.worktreeRepoRoot, [
        "git",
        "show",
        "--pretty=format:",
        "--name-only",
        "HEAD",
      ])
    ).stdout
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(committedPaths).toEqual(["docs/SPEC.md", "src/greeting.ts"]);
    expect(
      (await run(context.worktreeRepoRoot, ["git", "diff", "--cached", "--name-only"])).stdout,
    ).toBe("unrelated.txt");
    expect(await readFile(join(root, "docs", "SPEC.md"), "utf8")).toBe("Version 1\n");
  });

  it("reports, merges, and cleans up a completed worktree", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    await writeFile(join(context.watchedRoot, "docs", "SPEC.md"), "Version 2\n");
    await commitWorktreeBatch(context, ["docs/SPEC.md"], "Worktree Demo");

    const beforeMerge = await getWorktreeStatus(root, config());
    expect(beforeMerge.commitsAhead).toBe(1);
    expect(beforeMerge.merged).toBe(false);
    expect(beforeMerge.sourceClean).toBe(true);
    expect(beforeMerge.worktreeClean).toBe(true);
    await expect(cleanupIsolatedWorktree(root, config())).rejects.toThrow("not merged");

    const merged = await mergeIsolatedWorktree(root, config());
    expect(merged.alreadyMerged).toBe(false);
    expect(merged.sourceBranch).toBe("main");
    expect(await readFile(join(root, "docs", "SPEC.md"), "utf8")).toBe("Version 2\n");
    expect((await getWorktreeStatus(root, config())).merged).toBe(true);

    const cleaned = await cleanupIsolatedWorktree(root, config());
    expect(cleaned.discarded).toBe(false);
    expect((await run(root, ["git", "branch", "--list", context.branch])).stdout).toBe("");
    await expect(readFile(context.metadataPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit discard for unmerged or dirty worktrees", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    await writeFile(join(context.watchedRoot, "docs", "SPEC.md"), "Uncommitted\n");
    await expect(cleanupIsolatedWorktree(root, config())).rejects.toThrow("uncommitted changes");

    const discarded = await cleanupIsolatedWorktree(root, config(), { discard: true });
    expect(discarded.discarded).toBe(true);
    expect((await run(root, ["git", "branch", "--list", context.branch])).stdout).toBe("");
  });

  it("blocks a second watcher and mutating lifecycle commands while active", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    const release = await acquireWorktreeWatcherLock(context);
    expect((await getWorktreeStatus(root, config())).watcherActive).toBe(true);
    await expect(acquireWorktreeWatcherLock(context)).rejects.toThrow("already running");
    await expect(mergeIsolatedWorktree(root, config())).rejects.toThrow(
      "Stop the Hypervigilant watcher",
    );
    await expect(cleanupIsolatedWorktree(root, config(), { discard: true })).rejects.toThrow(
      "Stop the Hypervigilant watcher",
    );
    await release();
    expect((await getWorktreeStatus(root, config())).watcherActive).toBe(false);

    await writeFile(
      join(context.controlDir, "worktree-state", "watcher.lock"),
      `${JSON.stringify({ pid: 2_147_483_647 })}\n`,
    );
    const releaseRecovered = await acquireWorktreeWatcherLock(context);
    expect((await getWorktreeStatus(root, config())).watcherActive).toBe(true);
    await releaseRecovered();
  });

  it("runs commit hooks and preserves changes when a hook rejects the commit", async () => {
    const context = await prepareIsolatedWorktree(root, config());
    const hookPath = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    await chmod(hookPath, 0o755);
    await writeFile(join(context.watchedRoot, "docs", "SPEC.md"), "Rejected change\n");

    await expect(commitWorktreeBatch(context, ["docs/SPEC.md"], "Worktree Demo")).rejects.toThrow(
      "git commit failed",
    );
    expect(await readFile(join(context.watchedRoot, "docs", "SPEC.md"), "utf8")).toBe(
      "Rejected change\n",
    );
    expect(
      (await run(context.worktreeRepoRoot, ["git", "diff", "--cached", "--name-only"])).stdout,
    ).toBe("docs/SPEC.md");
  });

  it("rejects a dirty source checkout before creating a branch", async () => {
    await writeFile(join(root, "docs", "SPEC.md"), "Dirty\n");
    await expect(prepareIsolatedWorktree(root, config())).rejects.toThrow(
      "source checkout has uncommitted changes",
    );
    expect((await run(root, ["git", "branch", "--list", "hv/reviews/*"])).stdout).toBe("");
  });
});
