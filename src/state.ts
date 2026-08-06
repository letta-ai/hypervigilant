import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

/* ──────────────────────────── Schema ────────────────────────────── */

export type FileKind = "text" | "binary";

const fileSnapshotSchema = z.object({
  /** Project-relative path with forward slashes. */
  path: z.string(),
  /** SHA-256 content hash, or null for deleted files. */
  hash: z.string().nullable(),
  /** Size in bytes at last snapshot, or null for deleted files. */
  size: z.number().int().nullable(),
  /** Last delivered text. Binary bytes are never persisted. */
  content: z.string().nullable(),
  /** Old state files contain text snapshots only. */
  kind: z.enum(["text", "binary"]).default("text"),
  /** ISO timestamp of last snapshot update. */
  updatedAt: z.string(),
});

const conversationStateSchema = z.object({
  conversationId: z.string().nullable(),
});

export const stateSchema = z.object({
  version: z.literal(1).default(1),
  agentId: z.string(),
  projectConversation: conversationStateSchema.default({
    conversationId: null,
  }),
  /** Per-file conversation IDs keyed by project-relative path. */
  fileConversations: z.record(z.string(), z.string()).default({}),
  /** Named specialist conversation IDs keyed by logical prompt-route name. */
  namedConversations: z.record(z.string(), z.string()).optional(),
  /** File snapshots keyed by project-relative path. */
  snapshots: z.record(z.string(), fileSnapshotSchema).default({}),
  /** Missing in state written before metadata-only binary events existed. */
  binaryBaselineEstablished: z.boolean().optional(),
});

export type FileSnapshot = z.input<typeof fileSnapshotSchema>;
type ParsedState = z.infer<typeof stateSchema>;
export type HypervigilantState = Omit<ParsedState, "snapshots"> & {
  snapshots: Record<string, FileSnapshot>;
};

/* ────────────────────────── Utilities ────────────────────────────── */

/** Compute a SHA-256 hash without retaining the input. */
export function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Compute the SHA-256 hash of UTF-8 text. */
export async function hashContent(content: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(content));
}

/** Normalize a filesystem path to a project-relative forward-slash path. */
export function toRelPath(projectRoot: string, absPath: string): string {
  const rel = relative(resolve(projectRoot), resolve(absPath));
  return rel.split(sep).join("/");
}

/** Resolve a tool-supplied path to a safe project-relative path. */
export function toSafeRelPath(projectRoot: string, inputPath: string): string | null {
  const root = resolve(projectRoot);
  const target = resolve(root, inputPath);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  try {
    let lexicalAncestor = root;
    for (const segment of rel.split(sep)) {
      lexicalAncestor = join(lexicalAncestor, segment);
      try {
        if (lstatSync(lexicalAncestor).isSymbolicLink()) return null;
      } catch {
        break;
      }
    }
    const realRoot = realpathSync(root);
    let existingAncestor = target;
    while (true) {
      try {
        lstatSync(existingAncestor);
        break;
      } catch {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) return null;
        existingAncestor = parent;
      }
    }
    const realAncestor = realpathSync(existingAncestor);
    const realRel = relative(realRoot, realAncestor);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      return null;
    }
  } catch {
    // Broken or unreadable symlinks fail closed.
    return null;
  }
  return rel.split(sep).join("/");
}

/* ──────────────────── Atomic file operations ──────────────────────── */

/**
 * Write a file atomically by writing to a temp file then renaming.
 * Uses standard Node fs APIs for testability.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * Write a JSON file atomically with stable formatting.
 */
export async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/* ──────────────────────── State persistence ──────────────────────── */

export interface StateStoreOptions {
  stateDir: string;
}

export class StateStore {
  private readonly statePath: string;
  private state: HypervigilantState | null = null;
  private readonly lock: { current: Promise<unknown> } = {
    current: Promise.resolve(),
  };

  constructor(opts: StateStoreOptions) {
    this.statePath = join(opts.stateDir, "state.json");
  }

  /** Load state from disk, or return null if not yet created. */
  async load(): Promise<HypervigilantState | null> {
    if (this.state) return this.state;
    if (!existsSync(this.statePath)) return null;
    const raw = await readFile(this.statePath, "utf8");
    const parsed = stateSchema.parse(JSON.parse(raw));
    this.state = parsed;
    return parsed;
  }

  /** Save state to disk atomically. Serializes concurrent calls. */
  async save(state: HypervigilantState): Promise<void> {
    // Chain saves to prevent interleaving
    const previous = this.lock.current.catch(() => {});
    this.lock.current = previous.then(async () => {
      this.state = state;
      await atomicWriteJSON(this.statePath, state);
    });
    await this.lock.current;
  }

  /** Get the current in-memory state, loading from disk if needed. */
  async getOrLoad(): Promise<HypervigilantState> {
    const loaded = await this.load();
    if (loaded) return loaded;
    throw new Error("State has not been initialized. Run `hypervigilant init` first.");
  }

  /** Check if state file exists. */
  exists(): boolean {
    return existsSync(this.statePath);
  }

  /** Get the state file path. */
  get path(): string {
    return this.statePath;
  }
}

/* ──────────────────── Snapshot operations ────────────────────────── */

/**
 * Create or update a snapshot for a file.
 */
export function setSnapshot(
  state: HypervigilantState,
  relPath: string,
  hash: string | null,
  size: number | null,
  content: string | null,
  kind: FileKind = "text",
): HypervigilantState {
  return {
    ...state,
    snapshots: {
      ...state.snapshots,
      [relPath]: {
        path: relPath,
        hash,
        size,
        content,
        kind,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

/**
 * Remove a snapshot for a deleted file.
 */
export function removeSnapshot(state: HypervigilantState, relPath: string): HypervigilantState {
  const newSnapshots = { ...state.snapshots };
  delete newSnapshots[relPath];
  return { ...state, snapshots: newSnapshots };
}

/**
 * Set the project conversation ID.
 */
export function setProjectConversation(
  state: HypervigilantState,
  conversationId: string | null,
): HypervigilantState {
  return {
    ...state,
    projectConversation: { conversationId },
  };
}

/** Reset every conversation route when the configured agent changes. */
export function resetConversationRoutes(
  state: HypervigilantState,
  agentId: string,
): HypervigilantState {
  return {
    ...state,
    agentId,
    projectConversation: { conversationId: null },
    fileConversations: {},
    namedConversations: {},
  };
}

/**
 * Set or clear a per-file conversation ID.
 */
export function setFileConversation(
  state: HypervigilantState,
  relPath: string,
  conversationId: string | null,
): HypervigilantState {
  const newFileConversations = { ...state.fileConversations };
  if (conversationId === null) {
    delete newFileConversations[relPath];
  } else {
    newFileConversations[relPath] = conversationId;
  }
  return { ...state, fileConversations: newFileConversations };
}

/** Set a persistent named specialist conversation ID. */
export function setNamedConversation(
  state: HypervigilantState,
  name: string,
  conversationId: string,
): HypervigilantState {
  return {
    ...state,
    namedConversations: {
      ...(state.namedConversations ?? {}),
      [name]: conversationId,
    },
  };
}

/**
 * Get the conversation ID for a file based on routing mode.
 * Returns null for project routing (use project conversation).
 */
export function getFileConversationId(
  state: HypervigilantState,
  relPath: string,
  routing: "project" | "per-file",
): string | null {
  if (routing === "project") return null;
  return state.fileConversations[relPath] ?? null;
}

/** Get a persistent named specialist conversation ID. */
export function getNamedConversationId(state: HypervigilantState, name: string): string | null {
  return state.namedConversations?.[name] ?? null;
}
