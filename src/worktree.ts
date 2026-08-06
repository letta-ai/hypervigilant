import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { HypervigilantConfig } from "./config.ts";
import { atomicWriteJSON } from "./state.ts";

const WORKTREE_METADATA_FILENAME = "worktree.json";
const WORKTREE_SETUP_LOCK_FILENAME = "worktree-setup.lock";
const WATCHER_LOCK_FILENAME = "watcher.lock";

export interface WorktreeMetadata {
  version: 1;
  sourceRepoRoot: string;
  watchedSubpath: string;
  worktreeRepoRoot: string;
  branch: string;
  createdAt: string;
}

export interface WorktreeContext extends WorktreeMetadata {
  watchedRoot: string;
  controlDir: string;
  metadataPath: string;
}

export interface WorktreeCommit {
  commit: string;
  branch: string;
  worktreePath: string;
  mergeCommand: string;
  paths: string[];
}

export interface WorktreeStatus {
  context: WorktreeContext;
  sourceBranch: string | null;
  sourceClean: boolean;
  worktreeClean: boolean;
  watcherActive: boolean;
  commitsAhead: number;
  merged: boolean;
  mergeCommand: string;
}

export interface WorktreeMergeResult {
  branch: string;
  sourceBranch: string;
  head: string;
  alreadyMerged: boolean;
}

export interface WorktreeCleanupResult {
  branch: string;
  worktreePath: string;
  discarded: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [0],
): Promise<GitResult> {
  const process = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: globalThis.process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (!allowedExitCodes.includes(exitCode)) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "project"
  );
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function mergeCommand(sourceRepoRoot: string, branch: string): string {
  return `git -C ${shellQuote(sourceRepoRoot)} merge ${shellQuote(branch)}`;
}

function toContext(
  metadata: WorktreeMetadata,
  controlDir: string,
  metadataPath: string,
): WorktreeContext {
  return {
    ...metadata,
    watchedRoot: resolve(metadata.worktreeRepoRoot, metadata.watchedSubpath),
    controlDir,
    metadataPath,
  };
}

function parseMetadata(raw: unknown): WorktreeMetadata {
  if (!raw || typeof raw !== "object") throw new Error("Worktree metadata is not an object.");
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.sourceRepoRoot !== "string" ||
    typeof value.watchedSubpath !== "string" ||
    typeof value.worktreeRepoRoot !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Worktree metadata has an unsupported shape.");
  }
  return value as unknown as WorktreeMetadata;
}

async function loadMetadata(metadataPath: string): Promise<WorktreeMetadata | null> {
  try {
    return parseMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Cannot load isolated worktree metadata at ${metadataPath}: ${(error as Error).message}`,
    );
  }
}

function watcherLockPath(context: WorktreeContext): string {
  return join(context.controlDir, "worktree-state", WATCHER_LOCK_FILENAME);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPid(path: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function acquirePidLock(
  path: string,
  activeMessage: (pid: number) => string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeFile(
        path,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: "wx" },
      );
      return async () => {
        const pid = await readLockPid(path);
        if (pid === process.pid) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = await readLockPid(path);
      if (pid !== null && processIsAlive(pid)) throw new Error(activeMessage(pid));
      await rm(path, { force: true });
      await Bun.sleep(10 * (attempt + 1));
    }
  }
  throw new Error(`Could not acquire process lock at ${path}.`);
}

async function watcherIsActive(context: WorktreeContext): Promise<boolean> {
  const pid = await readLockPid(watcherLockPath(context));
  return pid !== null && processIsAlive(pid);
}

export async function acquireWorktreeWatcherLock(
  context: WorktreeContext,
): Promise<() => Promise<void>> {
  return acquirePidLock(
    watcherLockPath(context),
    (pid) => `A Hypervigilant watcher is already running for this worktree (PID ${pid}).`,
  );
}

async function validateExistingWorktree(
  context: WorktreeContext,
  sourceRepoRoot: string,
): Promise<void> {
  if (resolve(context.sourceRepoRoot) !== resolve(sourceRepoRoot)) {
    throw new Error(
      `Stored worktree belongs to ${context.sourceRepoRoot}, not ${sourceRepoRoot}. Remove ${context.metadataPath} only after inspecting the old worktree.`,
    );
  }
  const actualRoot = (await git(context.worktreeRepoRoot, ["rev-parse", "--show-toplevel"])).stdout;
  if (resolve(actualRoot) !== resolve(context.worktreeRepoRoot)) {
    throw new Error(`Stored worktree path is not its Git root: ${context.worktreeRepoRoot}`);
  }
  const actualBranch = (await git(context.worktreeRepoRoot, ["branch", "--show-current"])).stdout;
  if (actualBranch !== context.branch) {
    throw new Error(
      `Stored worktree expected branch ${context.branch}, but ${actualBranch || "detached HEAD"} is checked out.`,
    );
  }
}

async function uniqueBranch(
  sourceRepoRoot: string,
  prefix: string,
  project: string,
): Promise<string> {
  const stem = `${prefix}/${safeSlug(project)}-${timestamp()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
    await git(sourceRepoRoot, ["check-ref-format", "--branch", candidate]);
    const exists = await git(
      sourceRepoRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      [0, 1],
    );
    if (exists.exitCode === 1) return candidate;
  }
  throw new Error(`Could not create a unique branch below ${prefix}.`);
}

async function resolveSourceRepository(projectRoot: string): Promise<{
  sourceProjectRoot: string;
  sourceRepoRoot: string;
}> {
  const sourceProjectRoot = await realpath(resolve(projectRoot));
  try {
    const sourceRepoRoot = await realpath(
      (await git(sourceProjectRoot, ["rev-parse", "--show-toplevel"])).stdout,
    );
    await git(sourceRepoRoot, ["rev-parse", "--verify", "HEAD"]);
    return { sourceProjectRoot, sourceRepoRoot };
  } catch (error) {
    throw new Error(
      `Isolated worktree mode requires a Git repository with at least one commit. ${(error as Error).message}`,
    );
  }
}

async function loadExistingIsolatedWorktree(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
): Promise<WorktreeContext> {
  const { sourceProjectRoot, sourceRepoRoot } = await resolveSourceRepository(projectRoot);
  const controlDir = resolve(sourceProjectRoot, config.stateDir);
  const metadataPath = join(controlDir, WORKTREE_METADATA_FILENAME);
  const stored = await loadMetadata(metadataPath);
  if (!stored) {
    throw new Error(`No isolated Hypervigilant worktree is recorded at ${metadataPath}.`);
  }
  const context = toContext(stored, controlDir, metadataPath);
  await validateExistingWorktree(context, sourceRepoRoot);
  return context;
}

async function prepareIsolatedWorktreeUnderLock(
  sourceProjectRoot: string,
  sourceRepoRoot: string,
  controlDir: string,
  config: Pick<HypervigilantConfig, "project" | "worktree">,
): Promise<WorktreeContext> {
  const watchedSubpath = relative(sourceRepoRoot, sourceProjectRoot);
  if (watchedSubpath.startsWith(`..${sep}`) || watchedSubpath === "..") {
    throw new Error(`${sourceProjectRoot} is outside Git repository ${sourceRepoRoot}.`);
  }
  const metadataPath = join(controlDir, WORKTREE_METADATA_FILENAME);
  const stored = await loadMetadata(metadataPath);
  if (stored) {
    const context = toContext(stored, controlDir, metadataPath);
    await validateExistingWorktree(context, sourceRepoRoot);
    return context;
  }

  const sourceStatus = (await git(sourceRepoRoot, ["status", "--porcelain"])).stdout;
  if (sourceStatus) {
    throw new Error(
      "The source checkout has uncommitted changes. Commit or stash project files, and ignore Hypervigilant's generated config/state, before creating an isolated worktree.",
    );
  }

  const branch = await uniqueBranch(
    sourceRepoRoot,
    config.worktree.branchPrefix,
    config.project || basename(sourceProjectRoot),
  );
  const worktreeParent = join(
    dirname(sourceRepoRoot),
    ".hypervigilant-worktrees",
    basename(sourceRepoRoot),
  );
  await mkdir(worktreeParent, { recursive: true });
  const worktreeRepoRoot = join(worktreeParent, branch.replace(/\//g, "-"));
  await git(sourceRepoRoot, ["worktree", "add", "-b", branch, worktreeRepoRoot, "HEAD"]);

  const metadata: WorktreeMetadata = {
    version: 1,
    sourceRepoRoot,
    watchedSubpath,
    worktreeRepoRoot,
    branch,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJSON(metadataPath, metadata);
  return toContext(metadata, controlDir, metadataPath);
}

async function withWorktreeSetupLock<T>(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "project" | "stateDir" | "worktree">,
  operation: (context: WorktreeContext) => Promise<T>,
): Promise<T> {
  const { sourceProjectRoot, sourceRepoRoot } = await resolveSourceRepository(projectRoot);
  const controlDir = resolve(sourceProjectRoot, config.stateDir);
  const releaseSetupLock = await acquirePidLock(
    join(controlDir, WORKTREE_SETUP_LOCK_FILENAME),
    (pid) => `Another process is preparing this Hypervigilant worktree (PID ${pid}).`,
  );
  try {
    const context = await prepareIsolatedWorktreeUnderLock(
      sourceProjectRoot,
      sourceRepoRoot,
      controlDir,
      config,
    );
    return await operation(context);
  } finally {
    await releaseSetupLock();
  }
}

export async function prepareIsolatedWorktree(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "project" | "stateDir" | "worktree">,
): Promise<WorktreeContext> {
  return withWorktreeSetupLock(projectRoot, config, async (context) => context);
}

export async function prepareAndLockIsolatedWorktree(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "project" | "stateDir" | "worktree">,
): Promise<{ context: WorktreeContext; release: () => Promise<void> }> {
  return withWorktreeSetupLock(projectRoot, config, async (context) => ({
    context,
    release: await acquireWorktreeWatcherLock(context),
  }));
}

function repoRelativePaths(context: WorktreeContext, relPaths: string[]): string[] {
  const unique = [...new Set(relPaths)].sort();
  return unique.map((relPath) => {
    const absolutePath = resolve(context.watchedRoot, ...relPath.split("/"));
    const fromWatchedRoot = relative(context.watchedRoot, absolutePath);
    if (
      fromWatchedRoot === ".." ||
      fromWatchedRoot.startsWith(`..${sep}`) ||
      resolve(absolutePath) === resolve(context.watchedRoot)
    ) {
      throw new Error(`Cannot commit path outside the watched worktree: ${relPath}`);
    }
    return join(context.watchedSubpath, fromWatchedRoot).split(sep).join("/");
  });
}

export async function commitWorktreeBatch(
  context: WorktreeContext,
  relPaths: string[],
  projectName: string,
): Promise<WorktreeCommit | null> {
  if (relPaths.length === 0) return null;
  const paths = repoRelativePaths(context, relPaths);
  await git(context.worktreeRepoRoot, ["add", "--", ...paths]);
  const staged = await git(
    context.worktreeRepoRoot,
    ["diff", "--cached", "--quiet", "--", ...paths],
    [0, 1],
  );
  if (staged.exitCode === 0) return null;

  await git(context.worktreeRepoRoot, [
    "commit",
    "-m",
    `hypervigilant: apply ${projectName} review`,
    "--",
    ...paths,
  ]);
  const commit = (await git(context.worktreeRepoRoot, ["rev-parse", "--short", "HEAD"])).stdout;
  return {
    commit,
    branch: context.branch,
    worktreePath: context.worktreeRepoRoot,
    mergeCommand: mergeCommand(context.sourceRepoRoot, context.branch),
    paths,
  };
}

export async function getWorktreeStatus(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
): Promise<WorktreeStatus> {
  const context = await loadExistingIsolatedWorktree(projectRoot, config);
  const sourceBranch =
    (await git(context.sourceRepoRoot, ["branch", "--show-current"])).stdout || null;
  const sourceClean = !(await git(context.sourceRepoRoot, ["status", "--porcelain"])).stdout;
  const worktreeClean = !(await git(context.worktreeRepoRoot, ["status", "--porcelain"])).stdout;
  const watcherActive = await watcherIsActive(context);
  const commitsAhead = Number.parseInt(
    (await git(context.sourceRepoRoot, ["rev-list", "--count", `HEAD..${context.branch}`])).stdout,
    10,
  );
  const mergedResult = await git(
    context.sourceRepoRoot,
    ["merge-base", "--is-ancestor", context.branch, "HEAD"],
    [0, 1],
  );
  return {
    context,
    sourceBranch,
    sourceClean,
    worktreeClean,
    watcherActive,
    commitsAhead,
    merged: mergedResult.exitCode === 0,
    mergeCommand: mergeCommand(context.sourceRepoRoot, context.branch),
  };
}

export async function mergeIsolatedWorktree(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
): Promise<WorktreeMergeResult> {
  const status = await getWorktreeStatus(projectRoot, config);
  if (status.watcherActive) {
    throw new Error("Stop the Hypervigilant watcher before merging its worktree branch.");
  }
  if (!status.sourceBranch) {
    throw new Error(
      "The source checkout is on a detached HEAD. Check out the target branch first.",
    );
  }
  if (status.sourceBranch === status.context.branch) {
    throw new Error(
      "The source checkout cannot merge the branch that its linked worktree has checked out.",
    );
  }
  if (!status.sourceClean) {
    throw new Error(
      "The source checkout has uncommitted changes. Commit or stash them before merging.",
    );
  }
  if (!status.worktreeClean) {
    throw new Error(
      "The isolated worktree has uncommitted changes. Finish or discard them before merging.",
    );
  }
  if (!status.merged) {
    await git(status.context.sourceRepoRoot, ["merge", "--no-edit", status.context.branch]);
  }
  const head = (await git(status.context.sourceRepoRoot, ["rev-parse", "--short", "HEAD"])).stdout;
  return {
    branch: status.context.branch,
    sourceBranch: status.sourceBranch,
    head,
    alreadyMerged: status.merged,
  };
}

export async function cleanupIsolatedWorktree(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
  options: { discard?: boolean } = {},
): Promise<WorktreeCleanupResult> {
  const status = await getWorktreeStatus(projectRoot, config);
  if (status.watcherActive) {
    throw new Error("Stop the Hypervigilant watcher before removing its worktree.");
  }
  const discard = options.discard === true;
  if (!discard && !status.worktreeClean) {
    throw new Error(
      "The isolated worktree has uncommitted changes. Commit them or rerun cleanup with --discard.",
    );
  }
  if (!discard && !status.merged) {
    throw new Error(
      `Branch ${status.context.branch} is not merged into the current source HEAD. Merge it or rerun cleanup with --discard.`,
    );
  }

  await git(status.context.sourceRepoRoot, [
    "worktree",
    "remove",
    ...(discard ? ["--force"] : []),
    status.context.worktreeRepoRoot,
  ]);
  await git(status.context.sourceRepoRoot, [
    "branch",
    discard ? "-D" : "-d",
    status.context.branch,
  ]);
  await rm(status.context.metadataPath, { force: true });
  await rm(join(status.context.controlDir, "worktree-state"), { recursive: true, force: true });
  await git(status.context.sourceRepoRoot, ["worktree", "prune"]);
  return {
    branch: status.context.branch,
    worktreePath: status.context.worktreeRepoRoot,
    discarded: discard,
  };
}
