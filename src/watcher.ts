import { existsSync } from "node:fs";
import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { GlobMatcher, HypervigilantConfig } from "./config.ts";
import { createGlobMatcher } from "./config.ts";
import type { FileSnapshot } from "./state.ts";
import { hashContent, toRelPath } from "./state.ts";

export type WatchEvent = "add" | "change" | "unlink";

export interface FileChange {
  relPath: string;
  absPath: string;
  event: WatchEvent;
  oldContent: string | null;
  newContent: string | null;
  hash: string | null;
  size: number | null;
}

export type FileChangeCallback = (change: FileChange) => void | Promise<void>;

/** Reject obvious binary content without guessing from the file extension. */
export async function isTextFile(absPath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absPath, "r");
    const buffer = new Uint8Array(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function checkFileSize(
  absPath: string,
  maxSize: number,
): Promise<{ ok: boolean; size: number }> {
  try {
    const stats = await stat(absPath);
    return { ok: stats.isFile() && stats.size <= maxSize, size: stats.size };
  } catch {
    return { ok: false, size: 0 };
  }
}

export async function readFileContent(absPath: string): Promise<string | null> {
  if (!existsSync(absPath)) return null;
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function shouldSkipDirectory(
  projectRoot: string,
  stateDir: string,
  matcher: GlobMatcher,
  absPath: string,
): boolean {
  if (isWithin(stateDir, absPath)) return true;
  const relPath = toRelPath(projectRoot, absPath);
  return (
    matcher.isExcluded(relPath) ||
    matcher.isExcluded(`${relPath}/`) ||
    matcher.isExcluded(`${relPath}/__hypervigilant_probe__`)
  );
}

/** Walk matching files without following symlinks or entering excluded directories. */
export async function walkProject(
  projectRoot: string,
  matcher: GlobMatcher,
  config: HypervigilantConfig,
): Promise<string[]> {
  const root = resolve(projectRoot);
  const stateDir = resolve(root, config.stateDir);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(root, stateDir, matcher, fullPath)) await walk(fullPath);
        continue;
      }
      if (entry.isFile() && matcher.matches(toRelPath(root, fullPath))) results.push(fullPath);
    }
  }

  await walk(root);
  return results.sort();
}

/** Compare the current tree with the last delivered text, including changes made while stopped. */
export async function detectOfflineChanges(
  projectRoot: string,
  config: HypervigilantConfig,
  snapshots: Record<string, FileSnapshot>,
): Promise<FileChange[]> {
  const root = resolve(projectRoot);
  const matcher = createGlobMatcher(config);
  const changes: FileChange[] = [];
  const currentPaths = new Set<string>();

  for (const absPath of await walkProject(root, matcher, config)) {
    const relPath = toRelPath(root, absPath);
    currentPaths.add(relPath);
    const sizeCheck = await checkFileSize(absPath, config.maxFileSizeBytes);
    if (!sizeCheck.ok || !(await isTextFile(absPath))) continue;
    const newContent = await readFileContent(absPath);
    if (newContent === null) continue;
    const hash = await hashContent(newContent);
    const snapshot = snapshots[relPath];
    if (!snapshot) {
      changes.push({
        relPath,
        absPath,
        event: "add",
        oldContent: null,
        newContent,
        hash,
        size: sizeCheck.size,
      });
    } else if (snapshot.hash !== hash) {
      changes.push({
        relPath,
        absPath,
        event: "change",
        oldContent: snapshot.content,
        newContent,
        hash,
        size: sizeCheck.size,
      });
    }
  }

  for (const [relPath, snapshot] of Object.entries(snapshots)) {
    if (!matcher.matches(relPath) || currentPaths.has(relPath)) continue;
    changes.push({
      relPath,
      absPath: join(root, ...relPath.split("/")),
      event: "unlink",
      oldContent: snapshot.content,
      newContent: null,
      hash: null,
      size: null,
    });
  }

  return changes.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

export interface WatcherOptions {
  projectRoot: string;
  config: HypervigilantConfig;
  onChange: FileChangeCallback;
  getPreviousContent?: (relPath: string) => string | null;
  isSuppressed?: (relPath: string) => boolean;
  onSuppressedChange?: FileChangeCallback;
  onError?: (error: Error) => void;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly opts: WatcherOptions;
  private readonly matcher: GlobMatcher;

  constructor(opts: WatcherOptions) {
    this.opts = opts;
    this.matcher = createGlobMatcher(opts.config);
  }

  async start(onReady?: () => void): Promise<void> {
    const root = resolve(this.opts.projectRoot);
    const stateDir = resolve(root, this.opts.config.stateDir);
    this.watcher = chokidarWatch(root, {
      cwd: root,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (rawPath: string) => {
        const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
        if (!isWithin(root, absPath)) return true;
        return shouldSkipDirectory(root, stateDir, this.matcher, absPath);
      },
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on("add", (path: string) => void this.handleEvent("add", path));
    this.watcher.on("change", (path: string) => void this.handleEvent("change", path));
    this.watcher.on("unlink", (path: string) => void this.handleEvent("unlink", path));
    this.watcher.on("error", (error: unknown) =>
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error))),
    );
    if (onReady) this.watcher.on("ready", onReady);
  }

  private async handleEvent(event: WatchEvent, rawPath: string): Promise<void> {
    try {
      const root = resolve(this.opts.projectRoot);
      const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
      if (!isWithin(root, absPath)) return;
      const relPath = toRelPath(root, absPath);
      if (!this.matcher.matches(relPath)) return;

      let size: number | null = null;
      if (event !== "unlink") {
        const sizeCheck = await checkFileSize(absPath, this.opts.config.maxFileSizeBytes);
        if (!sizeCheck.ok || !(await isTextFile(absPath))) return;
        size = sizeCheck.size;
      }

      const newContent = event === "unlink" ? null : await readFileContent(absPath);
      if (event !== "unlink" && newContent === null) return;
      const oldContent = this.opts.getPreviousContent?.(relPath) ?? null;
      if (event !== "unlink" && oldContent === newContent) return;
      if (event === "unlink" && this.opts.getPreviousContent && oldContent === null) return;
      const change: FileChange = {
        relPath,
        absPath,
        event,
        oldContent,
        newContent,
        hash: newContent === null ? null : await hashContent(newContent),
        size,
      };

      if (this.opts.isSuppressed?.(relPath)) {
        await this.opts.onSuppressedChange?.(change);
        return;
      }
      await this.opts.onChange(change);
    } catch (error) {
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}
