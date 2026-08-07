import { join, resolve } from "node:path";
import type {
  CanUseToolContext,
  CanUseToolResponse,
  LettaAgentClient,
} from "@letta-ai/letta-agent-sdk";
import { deliverBatch, TurnSerializer } from "./agent.ts";
import { type Batcher, createBatcher } from "./batcher.ts";
import {
  createGlobMatcher,
  type HypervigilantConfig,
  loadConfig,
  resolveConfigPath,
} from "./config.ts";
import { getPermissionStatus, type PermissionPolicy, permissionAgentMode } from "./permissions.ts";
import {
  type HypervigilantState,
  removeSnapshot,
  resetConversationRoutes,
  StateStore,
  setSnapshot,
  toRelPath,
} from "./state.ts";
import {
  detectOfflineChanges,
  type FileChange,
  FileWatcher,
  inspectFile,
  walkProject,
} from "./watcher.ts";
import {
  commitWorktreeBatch,
  prepareAndLockIsolatedWorktree,
  type WorktreeContext,
} from "./worktree.ts";

export interface WatchOptions {
  path?: string;
  configPath?: string;
  runtimeEnv: Record<string, string>;
  validateAgent?: (agentId: string) => Promise<void>;
  onAssistantText?: (text: string) => void;
  onToolApproval?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: CanUseToolContext,
  ) => Promise<CanUseToolResponse>;
  onClientToolApproval?: (toolName: string) => Promise<CanUseToolResponse>;
  onStatus?: (message: string) => void;
  onError?: (error: string) => void;
}

class MutationSuppressions {
  private readonly expirations = new Map<string, number>();

  mark(relPath: string): void {
    this.expirations.set(relPath, Date.now() + 5_000);
  }

  has(relPath: string): boolean {
    const expiresAt = this.expirations.get(relPath);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    this.expirations.delete(relPath);
    return false;
  }
}

export type ScanOptions = WatchOptions;

type CommandMode = "watch" | "scan";

export async function watchCommand(opts: WatchOptions, client: LettaAgentClient): Promise<void> {
  return runCommand(opts, client, "watch");
}

export async function scanCommand(opts: ScanOptions, client: LettaAgentClient): Promise<void> {
  return runCommand(opts, client, "scan");
}

async function runCommand(
  opts: WatchOptions,
  client: LettaAgentClient,
  commandMode: CommandMode,
): Promise<void> {
  const sourceProjectRoot = resolve(opts.path ?? process.cwd());
  const resolvedConfig = resolveConfigPath(sourceProjectRoot, opts.configPath);
  const config = await loadConfig(resolvedConfig.path);
  if (resolvedConfig.legacy) {
    opts.onStatus?.(
      `Using legacy JSON config at ${resolvedConfig.path}. Run init to migrate to TOML.`,
    );
  }
  if (opts.validateAgent) {
    try {
      await opts.validateAgent(config.agentId);
    } catch (error) {
      throw new Error(
        `Configured agent ${config.agentId} is not available for the selected Letta account. Check agent_id and the project's .env. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  let permissionStatus = await getPermissionStatus(sourceProjectRoot, config);
  if (permissionStatus.effective === "ask" && !opts.onToolApproval) {
    throw new Error("Ask permission policy requires an interactive tool-approval callback.");
  }
  if (config.tools.ask.length > 0 && !opts.onClientToolApproval) {
    throw new Error("Configured ask tools require an interactive client-tool approval callback.");
  }
  let worktree: WorktreeContext | null = null;
  let releaseWorktreeLock = async (): Promise<void> => {};
  if (config.worktree.enabled) {
    const prepared = await prepareAndLockIsolatedWorktree(sourceProjectRoot, config);
    worktree = prepared.context;
    releaseWorktreeLock = prepared.release;
    opts.onStatus?.(`Source checkout: ${sourceProjectRoot}`);
    opts.onStatus?.(`Isolated worktree: ${worktree.worktreeRepoRoot}`);
    opts.onStatus?.(`Worktree branch: ${worktree.branch}`);
    opts.onStatus?.(`Edit watched files in: ${worktree.watchedRoot}`);
  }
  const projectRoot = worktree?.watchedRoot ?? sourceProjectRoot;
  const stateDirectory = worktree
    ? join(worktree.controlDir, "worktree-state")
    : resolve(projectRoot, config.stateDir);
  const watchedMatcher = createGlobMatcher(config);
  const store = new StateStore({ stateDir: stateDirectory });
  let initialized: { state: HypervigilantState; pendingChanges: FileChange[] };
  try {
    initialized = await initializeCommandState(
      projectRoot,
      config,
      store,
      commandMode,
      opts.onStatus,
    );
  } catch (error) {
    await releaseWorktreeLock();
    throw error;
  }
  let { state } = initialized;
  const { pendingChanges } = initialized;

  const turnSerializer = new TurnSerializer();
  const suppressions = new MutationSuppressions();
  const persistCurrentFile = async (relPath: string): Promise<void> => {
    const absPath = join(projectRoot, ...relPath.split("/"));
    const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
    if (!inspected) {
      state = removeSnapshot(state, relPath);
    } else {
      state = setSnapshot(
        state,
        relPath,
        inspected.hash,
        inspected.size,
        inspected.content,
        inspected.kind,
      );
    }
    await store.save(state);
  };

  const batcher: Batcher = createBatcher(config, async (rawChanges) => {
    try {
      await turnSerializer.run(async () => {
        const changes = hydrateChanges(rawChanges, state, commandMode === "scan");
        if (changes.length === 0) return;
        const nextPermissionStatus = await getPermissionStatus(sourceProjectRoot, config);
        if (nextPermissionStatus.effective !== permissionStatus.effective) {
          opts.onStatus?.(
            `Permissions changed: ${permissionStatus.effective} -> ${nextPermissionStatus.effective}.`,
          );
        }
        permissionStatus = nextPermissionStatus;
        if (permissionStatus.effective === "ask" && !opts.onToolApproval) {
          throw new Error("Ask permission policy requires an interactive tool-approval callback.");
        }
        opts.onStatus?.(
          commandMode === "scan" ? formatScanStatus(changes) : formatDeliveryStatus(changes),
        );
        const batchMutationPaths = new Set<string>();
        const watchedMutationPaths = new Set<string>();
        const onToolApproval = approvalForPolicy(permissionStatus.effective, opts);

        const delivery = await deliverBatch(client, state, changes, {
          agentId: config.agentId,
          projectName: config.project,
          projectRoot,
          instructions: config.instructions,
          promptRules: config.promptRules,
          clientTools: config.tools,
          routing: config.routing,
          mode: permissionAgentMode(permissionStatus.effective),
          permissionPolicy: permissionStatus.effective,
          deliveryKind: commandMode === "scan" ? "scan" : "update",
          protectedPaths: [
            resolve(sourceProjectRoot, config.stateDir),
            resolvedConfig.path,
            join(projectRoot, ".git"),
          ],
          runtimeEnv: opts.runtimeEnv,
          onAssistantText: opts.onAssistantText,
          onNamedConversation: (name) =>
            opts.onStatus?.(`Dispatching filesystem-read-only prompt conversation: ${name}`),
          onToolApproval,
          onClientToolApproval: opts.onClientToolApproval,
          onAgentMutation: (relPath) => {
            batchMutationPaths.add(relPath);
            if (watchedMatcher.matches(relPath)) {
              watchedMutationPaths.add(relPath);
              suppressions.mark(relPath);
            }
          },
        });

        state = delivery.newState;
        const delivered = new Set(delivery.deliveredPaths);
        for (const change of changes) {
          if (!delivered.has(change.relPath)) continue;
          state = applyDeliveredChange(state, change);
        }
        if (commandMode === "scan" && delivery.result.success) {
          state = removeMissingScanSnapshots(
            state,
            watchedMatcher,
            new Set(changes.map((change) => change.relPath)),
          );
        }
        for (const relPath of watchedMutationPaths) {
          const absPath = join(projectRoot, ...relPath.split("/"));
          const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
          state = inspected
            ? setSnapshot(
                state,
                relPath,
                inspected.hash,
                inspected.size,
                inspected.content,
                inspected.kind,
              )
            : removeSnapshot(state, relPath);
        }
        await store.save(state);
        opts.onAssistantText?.("\n");

        if (delivery.result.success && worktree) {
          const batchPaths = [...delivery.deliveredPaths, ...batchMutationPaths];
          if (config.worktree.autoCommit) {
            try {
              const commit = await commitWorktreeBatch(worktree, batchPaths, config.project);
              if (commit) {
                opts.onStatus?.(`Committed ${commit.commit} on ${commit.branch}.`);
                opts.onStatus?.(`Merge when ready: ${commit.mergeCommand}`);
              }
            } catch (error) {
              opts.onError?.(
                `Delivery succeeded, but auto-commit failed in ${worktree.worktreeRepoRoot}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          } else {
            opts.onStatus?.(`Changes remain uncommitted in ${worktree.worktreeRepoRoot}.`);
          }
        }

        if (delivery.result.success) {
          opts.onStatus?.(commandMode === "scan" ? "Scan complete." : "Delivery complete.");
        } else {
          const message = `Delivery stopped (${delivery.result.errorCode ?? "error"}): ${
            delivery.result.error ?? "unknown error"
          }`;
          if (commandMode === "scan") throw new Error(message);
          opts.onError?.(message);
        }
      });
    } catch (error) {
      if (commandMode === "scan") throw error;
      opts.onError?.(
        `Failed to process a saved-change batch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  for (const change of pendingChanges) batcher.add(change);

  if (commandMode === "scan") {
    try {
      if (pendingChanges.length === 0) {
        state = removeMissingScanSnapshots(state, watchedMatcher, new Set());
        await store.save(state);
        opts.onStatus?.("No matching files found. Nothing was sent.");
      } else {
        await batcher.close();
      }
    } finally {
      await releaseWorktreeLock();
    }
    return;
  }

  const watcher = new FileWatcher({
    projectRoot,
    config,
    getPreviousSnapshot: (relPath) => state.snapshots[relPath],
    isSuppressed: (relPath) => suppressions.has(relPath),
    onSuppressedChange: (change) => {
      void turnSerializer
        .run(async () => persistCurrentFile(change.relPath))
        .catch((error: unknown) =>
          opts.onError?.(
            `Failed to save an agent-edited baseline: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    },
    onChange: (change) => batcher.add(change),
    onError: (error) => opts.onError?.(`Watcher error: ${error.message}`),
  });
  try {
    await new Promise<void>((ready) => void watcher.start(ready));
  } catch (error) {
    await releaseWorktreeLock();
    throw error;
  }

  opts.onStatus?.(`Watching ${projectRoot}`);
  const clientToolStatus =
    config.tools.autoAllow.length + config.tools.ask.length === 0
      ? "no extras"
      : `${config.tools.autoAllow.length} auto, ${config.tools.ask.length} ask`;
  opts.onStatus?.(
    `Permissions: ${formatPermissionStatus(permissionStatus)}; client tools: ${clientToolStatus}; conversations: ${config.routing}; batching: ${config.batching.strategy}`,
  );

  let closing = false;
  const cleanup = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    opts.onStatus?.("Shutting down...");
    await watcher.stop();
    await batcher.close();
    await releaseWorktreeLock();
  };
  process.once("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.once("SIGTERM", () => void cleanup().then(() => process.exit(0)));
}

export function approvalForPolicy(
  policy: PermissionPolicy,
  opts: Pick<WatchOptions, "onToolApproval" | "onStatus">,
): WatchOptions["onToolApproval"] {
  if (policy === "review") return undefined;
  if (policy === "ask") return opts.onToolApproval;
  return async (toolName, toolInput) => {
    const target = typeof toolInput.file_path === "string" ? toolInput.file_path : "(unknown file)";
    opts.onStatus?.(`YOLO auto-approved ${toolName}: ${target}`);
    return { behavior: "allow", message: "Allowed by Hypervigilant YOLO policy" };
  };
}

function formatPermissionStatus(status: Awaited<ReturnType<typeof getPermissionStatus>>): string {
  return status.override
    ? `${status.effective} (override; configured ${status.configured})`
    : `${status.effective} (configured)`;
}

async function initializeCommandState(
  projectRoot: string,
  config: HypervigilantConfig,
  store: StateStore,
  commandMode: CommandMode,
  onStatus: WatchOptions["onStatus"],
): Promise<{ state: HypervigilantState; pendingChanges: FileChange[] }> {
  const loadedState = await store.load();
  let state: HypervigilantState;
  if (!loadedState) {
    if (commandMode === "scan") {
      state = emptyState(config.agentId);
      await store.save(state);
    } else {
      onStatus?.("First run: establishing the saved-file baseline...");
      state = await establishBaseline(projectRoot, config);
      await store.save(state);
      onStatus?.("Baseline established. Existing files were not sent.");
    }
  } else if (loadedState.agentId !== config.agentId) {
    state = resetConversationRoutes(loadedState, config.agentId);
    await store.save(state);
    onStatus?.("Agent changed. Conversation routes were reset.");
  } else {
    state = loadedState;
  }

  if (commandMode === "watch" && state.binaryBaselineEstablished !== true) {
    state = await establishBinaryBaseline(projectRoot, config, state);
    await store.save(state);
    onStatus?.("Binary baseline established. Existing binary files were not sent.");
  } else if (commandMode === "scan" && state.binaryBaselineEstablished !== true) {
    state = { ...state, binaryBaselineEstablished: true };
    await store.save(state);
  }

  const pendingChanges = await detectOfflineChanges(
    projectRoot,
    config,
    commandMode === "scan" ? {} : state.snapshots,
  );
  if (pendingChanges.length > 0) {
    onStatus?.(
      commandMode === "scan"
        ? `Found ${pendingChanges.length} matching ${pendingChanges.length === 1 ? "file" : "files"} to scan.`
        : `Found ${pendingChanges.length} change(s) made while stopped.`,
    );
  }
  return { state, pendingChanges };
}

export function formatDeliveryStatus(changes: Array<Pick<FileChange, "relPath">>): string {
  const count = changes.length;
  const visiblePaths = changes.slice(0, 4).map((change) => change.relPath);
  const remaining = count - visiblePaths.length;
  const pathSummary = `${visiblePaths.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
  return `Sending ${count} saved ${count === 1 ? "change" : "changes"} to the agent: ${pathSummary}`;
}

export function formatScanStatus(changes: Array<Pick<FileChange, "relPath">>): string {
  const count = changes.length;
  const visiblePaths = changes.slice(0, 4).map((change) => change.relPath);
  const remaining = count - visiblePaths.length;
  const pathSummary = `${visiblePaths.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
  return `Sending ${count} existing ${count === 1 ? "file" : "files"} to the agent: ${pathSummary}`;
}

function hydrateChanges(
  changes: FileChange[],
  state: HypervigilantState,
  forceAdd = false,
): FileChange[] {
  if (forceAdd) {
    return changes
      .filter((change) => change.hash !== null)
      .map((change) => ({ ...change, event: "add", oldContent: null }));
  }
  return changes
    .map((change) => {
      const snapshot = state.snapshots[change.relPath];
      const event: FileChange["event"] =
        change.hash === null ? "unlink" : snapshot ? "change" : "add";
      return { ...change, oldContent: snapshot?.content ?? null, event };
    })
    .filter((change) => {
      const snapshot = state.snapshots[change.relPath];
      if (change.hash === null) return Boolean(snapshot);
      if (!snapshot) return true;
      return snapshot.hash !== change.hash || (snapshot.kind ?? "text") !== (change.kind ?? "text");
    });
}

function applyDeliveredChange(state: HypervigilantState, change: FileChange): HypervigilantState {
  return change.hash === null
    ? removeSnapshot(state, change.relPath)
    : setSnapshot(
        state,
        change.relPath,
        change.hash,
        change.size,
        change.newContent,
        change.kind ?? "text",
      );
}

function removeMissingScanSnapshots(
  state: HypervigilantState,
  matcher: Pick<ReturnType<typeof createGlobMatcher>, "matches">,
  currentPaths: ReadonlySet<string>,
): HypervigilantState {
  let nextState = state;
  for (const relPath of Object.keys(state.snapshots)) {
    if (matcher.matches(relPath) && !currentPaths.has(relPath)) {
      nextState = removeSnapshot(nextState, relPath);
    }
  }
  return nextState;
}

export async function establishBinaryBaseline(
  projectRoot: string,
  config: HypervigilantConfig,
  state: HypervigilantState,
): Promise<HypervigilantState> {
  let nextState = state;
  const matcher = createGlobMatcher(config);
  for (const absPath of await walkProject(projectRoot, matcher, config)) {
    const relPath = toRelPath(projectRoot, absPath);
    if (nextState.snapshots[relPath]) continue;
    const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
    if (inspected?.kind !== "binary") continue;
    nextState = setSnapshot(nextState, relPath, inspected.hash, inspected.size, null, "binary");
  }
  return { ...nextState, binaryBaselineEstablished: true };
}

function emptyState(agentId: string): HypervigilantState {
  return {
    version: 1,
    agentId,
    projectConversation: { conversationId: null },
    fileConversations: {},
    namedConversations: {},
    snapshots: {},
    binaryBaselineEstablished: true,
  };
}

export async function establishBaseline(
  projectRoot: string,
  config: HypervigilantConfig,
): Promise<HypervigilantState> {
  let state = emptyState(config.agentId);
  const matcher = createGlobMatcher(config);
  for (const absPath of await walkProject(projectRoot, matcher, config)) {
    try {
      const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
      if (!inspected) continue;
      state = setSnapshot(
        state,
        toRelPath(projectRoot, absPath),
        inspected.hash,
        inspected.size,
        inspected.content,
        inspected.kind,
      );
    } catch {
      // An unreadable file is not part of the baseline.
    }
  }
  return state;
}
