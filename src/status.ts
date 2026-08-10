import { join, resolve } from "node:path";
import { createGlobMatcher, loadConfig, resolveConfigPath } from "./config.ts";
import { type FileSnapshot, StateStore, toRelPath } from "./state.ts";
import { inspectFile, walkProject } from "./watcher.ts";
import { findExistingIsolatedWorktree } from "./worktree.ts";

const MAX_EXAMPLES = 5;

export interface StatusOptions {
  path?: string;
  configPath?: string;
}

export interface StatusResult {
  lines: string[];
}

type FileState = "indexed" | "changed" | "new" | "stale";

interface FileEntry {
  relPath: string;
  state: FileState;
  kind: "text" | "binary";
  size: number;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<StatusResult> {
  const projectRoot = resolve(opts.path ?? process.cwd());
  const config = await loadConfig(resolveConfigPath(projectRoot, opts.configPath).path);
  const lines: string[] = [];
  const log = (s: string): void => {
    lines.push(s);
  };

  log(`Project: ${config.project}`);
  log(`Agent: ${config.agentId}`);

  const worktree = config.worktree.enabled
    ? await findExistingIsolatedWorktree(projectRoot, config)
    : null;
  const inspectedRoot = worktree?.watchedRoot ?? projectRoot;
  const stateStore = new StateStore({
    stateDir: worktree
      ? join(worktree.controlDir, "worktree-state")
      : resolve(projectRoot, config.stateDir),
  });
  const state = await stateStore.load();
  const agentMismatch = state !== null && state.agentId !== config.agentId;

  const matcher = createGlobMatcher(config);
  const absPaths = await walkProject(inspectedRoot, matcher, config);

  let textCount = 0,
    textBytes = 0,
    binaryCount = 0,
    binaryBytes = 0;
  const entries: FileEntry[] = [];
  const currentRelPaths = new Set<string>();

  for (const absPath of absPaths) {
    const relPath = toRelPath(inspectedRoot, absPath);
    const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
    if (!inspected) continue;
    currentRelPaths.add(relPath);
    if (inspected.kind === "text") {
      textCount++;
      textBytes += inspected.size;
    } else {
      binaryCount++;
      binaryBytes += inspected.size;
    }
    const snapshot = state?.snapshots[relPath];
    const fileState: FileState = !snapshot
      ? "new"
      : snapshot.hash !== inspected.hash
        ? "changed"
        : "indexed";
    entries.push({
      relPath,
      state: fileState,
      kind: inspected.kind,
      size: inspected.size,
    });
  }

  if (state) {
    for (const [relPath, snap] of Object.entries(state.snapshots)) {
      if (currentRelPaths.has(relPath) || !matcher.matches(relPath)) continue;
      const s = snap as FileSnapshot;
      entries.push({
        relPath,
        state: "stale",
        kind: s.kind ?? "text",
        size: s.size ?? 0,
      });
    }
  }

  log("");
  log("Current selected files:");
  log(`  Text: ${textCount} file${textCount === 1 ? "" : "s"}, ${formatBytes(textBytes)}`);
  log(`  Binary: ${binaryCount} file${binaryCount === 1 ? "" : "s"}, ${formatBytes(binaryBytes)}`);
  log(`  Total: ${textCount + binaryCount} file${textCount + binaryCount === 1 ? "" : "s"}`);

  log("");
  log(`Persisted snapshots: ${state ? Object.keys(state.snapshots).length : 0}`);

  if (agentMismatch && state) {
    log(`  State belongs to agent ${state.agentId}; ignoring saved conversation routes.`);
  }

  const byState: Record<FileState, FileEntry[]> = {
    indexed: [],
    changed: [],
    new: [],
    stale: [],
  };
  for (const e of entries) byState[e.state].push(e);
  const labels: Record<FileState, string> = {
    indexed: "Indexed",
    changed: "Changed",
    new: "New",
    stale: "Stale/missing",
  };

  for (const fs of ["indexed", "changed", "new", "stale"] as FileState[]) {
    const items = byState[fs];
    if (items.length === 0) continue;
    log(`  ${labels[fs]}: ${items.length}`);
    for (const e of items.slice(0, MAX_EXAMPLES))
      log(`    ${e.relPath} (${e.kind}, ${formatBytes(e.size)})`);
    const rem = items.length - MAX_EXAMPLES;
    if (rem > 0) log(`    ...and ${rem} more`);
  }

  log("");
  log("Routing:");
  log(`  Default: ${config.routing}`);
  const currentFiles = entries
    .filter((e) => e.state !== "stale")
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const currentLabel = `${currentFiles.length} current ${currentFiles.length === 1 ? "file" : "files"}`;
  if (agentMismatch) {
    log("  Conversation routes ignored (agent mismatch).");
  } else if (config.routing === "project") {
    const convId = state?.projectConversation?.conversationId ?? null;
    log(`  ${currentLabel} -> ${convId ?? "not yet created"}`);
  } else {
    const fileConvs = state?.fileConversations ?? {};
    const withIds = currentFiles.filter((e) => fileConvs[e.relPath]).length;
    log(`  Current files: ${withIds} with route, ${currentFiles.length - withIds} without`);
    for (const e of currentFiles.slice(0, MAX_EXAMPLES))
      log(`    ${e.relPath} -> ${fileConvs[e.relPath] ?? "not yet created"}`);
    const rem = currentFiles.length - MAX_EXAMPLES;
    if (rem > 0) log(`    ...and ${rem} more`);
  }

  const namedRules = config.promptRules.flatMap((r) => (r.conversation ? [r.conversation] : []));
  const uniqueNames = [...new Set(namedRules)];
  if (uniqueNames.length > 0) {
    log("");
    log("Named prompt-rule routes:");
    const namedConvs = (!agentMismatch ? state?.namedConversations : undefined) ?? {};
    for (const name of uniqueNames) {
      const id = namedConvs[name] ?? null;
      log(`  ${name}: ${id ?? "not yet created"}`);
      for (const rule of config.promptRules.filter((r) => r.conversation === name))
        log(`    ${rule.name}: ${rule.match.join(", ")} [${rule.events.join(", ")}]`);
    }
    log("  File mapping depends on add/change/delete events; status is static.");
  }

  log("");
  log(`Worktree: ${config.worktree.enabled ? "enabled" : "disabled"}`);

  return { lines };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** exp;
  return `${exp === 0 ? val : val.toFixed(1)} ${units[exp]}`;
}
