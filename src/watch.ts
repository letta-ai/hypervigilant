import { readFile } from "node:fs/promises";
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
  hashContent,
  removeSnapshot,
  resetConversationRoutes,
  StateStore,
  setSnapshot,
  toRelPath,
} from "./state.ts";
import {
  checkFileSize,
  detectOfflineChanges,
  type FileChange,
  FileWatcher,
  isTextFile,
  readFileContent,
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

  activePaths(): string[] {
    return [...this.expirations.keys()].filter((relPath) => this.has(relPath));
  }
}

export async function watchCommand(opts: WatchOptions, client: LettaAgentClient): Promise<void> {
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
  const loadedState = await store.load();
  let state: HypervigilantState;
  if (!loadedState) {
    opts.onStatus?.("First run: establishing the saved-file baseline...");
    state = await establishBaseline(projectRoot, config);
    await store.save(state);
    opts.onStatus?.("Baseline established. Existing files were not sent.");
  } else if (loadedState.agentId !== config.agentId) {
    state = resetConversationRoutes(loadedState, config.agentId);
    await store.save(state);
    opts.onStatus?.("Agent changed. Conversation routes were reset.");
  } else {
    state = loadedState;
  }

  const offlineChanges = await detectOfflineChanges(projectRoot, config, state.snapshots);
  if (offlineChanges.length > 0) {
    opts.onStatus?.(`Found ${offlineChanges.length} change(s) made while stopped.`);
  }

  const turnSerializer = new TurnSerializer();
  const suppressions = new MutationSuppressions();
  const persistCurrentFile = async (relPath: string): Promise<void> => {
    const absPath = join(projectRoot, ...relPath.split("/"));
    const content = await readFileContent(absPath);
    if (content === null) {
      state = removeSnapshot(state, relPath);
    } else {
      state = setSnapshot(
        state,
        relPath,
        await hashContent(content),
        Buffer.byteLength(content),
        content,
      );
    }
    await store.save(state);
  };

  const batcher: Batcher = createBatcher(config, async (rawChanges) => {
    try {
      await turnSerializer.run(async () => {
        const changes = hydrateChanges(rawChanges, state);
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
        opts.onStatus?.(formatDeliveryStatus(changes));
        const batchMutationPaths = new Set<string>();
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
            if (watchedMatcher.matches(relPath)) suppressions.mark(relPath);
          },
        });

        state = delivery.newState;
        const delivered = new Set(delivery.deliveredPaths);
        for (const change of changes) {
          if (!delivered.has(change.relPath)) continue;
          state = applyDeliveredChange(state, change);
        }
        for (const relPath of suppressions.activePaths()) {
          const absPath = join(projectRoot, ...relPath.split("/"));
          const content = await readFileContent(absPath);
          state =
            content === null
              ? removeSnapshot(state, relPath)
              : setSnapshot(
                  state,
                  relPath,
                  await hashContent(content),
                  Buffer.byteLength(content),
                  content,
                );
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
          opts.onStatus?.("Delivery complete.");
        } else {
          opts.onError?.(
            `Delivery stopped (${delivery.result.errorCode ?? "error"}): ${
              delivery.result.error ?? "unknown error"
            }`,
          );
        }
      });
    } catch (error) {
      opts.onError?.(
        `Failed to process a saved-change batch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  for (const change of offlineChanges) batcher.add(change);

  const watcher = new FileWatcher({
    projectRoot,
    config,
    getPreviousContent: (relPath) => state.snapshots[relPath]?.content ?? null,
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

export function formatDeliveryStatus(changes: Array<Pick<FileChange, "relPath">>): string {
  const count = changes.length;
  const visiblePaths = changes.slice(0, 4).map((change) => change.relPath);
  const remaining = count - visiblePaths.length;
  const pathSummary = `${visiblePaths.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
  return `Sending ${count} saved ${count === 1 ? "change" : "changes"} to the agent: ${pathSummary}`;
}

function hydrateChanges(changes: FileChange[], state: HypervigilantState): FileChange[] {
  return changes
    .map((change) => {
      const oldContent = state.snapshots[change.relPath]?.content ?? null;
      const event: FileChange["event"] =
        change.newContent === null ? "unlink" : oldContent === null ? "add" : "change";
      return { ...change, oldContent, event };
    })
    .filter((change) => change.oldContent !== change.newContent);
}

function applyDeliveredChange(state: HypervigilantState, change: FileChange): HypervigilantState {
  return change.newContent === null
    ? removeSnapshot(state, change.relPath)
    : setSnapshot(state, change.relPath, change.hash, change.size, change.newContent);
}

export async function establishBaseline(
  projectRoot: string,
  config: HypervigilantConfig,
): Promise<HypervigilantState> {
  let state: HypervigilantState = {
    version: 1,
    agentId: config.agentId,
    projectConversation: { conversationId: null },
    fileConversations: {},
    namedConversations: {},
    snapshots: {},
  };
  const matcher = createGlobMatcher(config);
  for (const absPath of await walkProject(projectRoot, matcher, config)) {
    try {
      const sizeCheck = await checkFileSize(absPath, config.maxFileSizeBytes);
      if (!sizeCheck.ok || !(await isTextFile(absPath))) continue;
      const content = await readFile(absPath, "utf8");
      state = setSnapshot(
        state,
        toRelPath(projectRoot, absPath),
        await hashContent(content),
        sizeCheck.size,
        content,
      );
    } catch {
      // An unreadable file is not part of the baseline.
    }
  }
  return state;
}
