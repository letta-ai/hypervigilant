import { existsSync } from "node:fs";
import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { GlobMatcher, HypervigilantConfig } from "./config.ts";
import { createGlobMatcher } from "./config.ts";
import type { FileKind, FileSnapshot } from "./state.ts";
import { hashBytes, toRelPath } from "./state.ts";

export type WatchEvent = "add" | "change" | "unlink";

export interface FileChange {
  relPath: string;
  absPath: string;
  event: WatchEvent;
  kind: FileKind;
  oldContent: string | null;
  newContent: string | null;
  hash: string | null;
  size: number | null;
}

export type FileChangeCallback = (change: FileChange) => void | Promise<void>;

function bytesLookLikeText(content: Uint8Array): boolean {
  const sampleLength = Math.min(content.byteLength, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (content[index] === 0) return false;
  }
  return true;
}

/** Reject obvious binary content without guessing from the file extension. */
export async function isTextFile(absPath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absPath, "r");
    const buffer = new Uint8Array(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesLookLikeText(buffer.subarray(0, bytesRead));
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

export interface InspectedFile {
  kind: FileKind;
  hash: string;
  size: number;
  content: string | null;
}

/** Read one bounded file once. Binary bytes are hashed, then discarded. */
export async function inspectFile(absPath: string, maxSize: number): Promise<InspectedFile | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absPath, "r");
    const file = await handle.stat();
    if (!file.isFile() || file.size > maxSize) return null;

    const buffer = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > file.size) return null;

    const bytes = buffer.subarray(0, offset);
    const kind: FileKind = bytesLookLikeText(bytes) ? "text" : "binary";
    return {
      kind,
      hash: hashBytes(bytes),
      size: bytes.byteLength,
      content: kind === "text" ? bytes.toString("utf8") : null,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
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
    const inspected = await inspectFile(absPath, config.maxFileSizeBytes);
    if (!inspected) continue;
    const snapshot = snapshots[relPath];
    if (!snapshot) {
      changes.push({
        relPath,
        absPath,
        event: "add",
        kind: inspected.kind,
        oldContent: null,
        newContent: inspected.content,
        hash: inspected.hash,
        size: inspected.size,
      });
    } else if (snapshot.hash !== inspected.hash || snapshot.kind !== inspected.kind) {
      changes.push({
        relPath,
        absPath,
        event: "change",
        kind: inspected.kind,
        oldContent: snapshot.content,
        newContent: inspected.content,
        hash: inspected.hash,
        size: inspected.size,
      });
    }
  }

  for (const [relPath, snapshot] of Object.entries(snapshots)) {
    if (!matcher.matches(relPath) || currentPaths.has(relPath)) continue;
    changes.push({
      relPath,
      absPath: join(root, ...relPath.split("/")),
      event: "unlink",
      kind: snapshot.kind,
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
  getPreviousSnapshot?: (relPath: string) => FileSnapshot | undefined;
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

      const previous = this.opts.getPreviousSnapshot?.(relPath);
      const inspected =
        event === "unlink" ? null : await inspectFile(absPath, this.opts.config.maxFileSizeBytes);
      if (event !== "unlink" && !inspected) return;
      if (event === "unlink" && this.opts.getPreviousSnapshot && !previous) return;
      if (
        inspected &&
        previous &&
        inspected.hash === previous.hash &&
        inspected.kind === previous.kind
      ) {
        return;
      }
      const change: FileChange = {
        relPath,
        absPath,
        event,
        kind: inspected?.kind ?? previous?.kind ?? "text",
        oldContent: previous?.content ?? null,
        newContent: inspected?.content ?? null,
        hash: inspected?.hash ?? null,
        size: inspected?.size ?? null,
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
