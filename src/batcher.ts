import type { BatchingStrategy, HypervigilantConfig } from "./config.ts";
import type { FileChange } from "./watcher.ts";

/* ──────────────────────────── Types ─────────────────────────────── */

export type FlushCallback = (changes: FileChange[]) => void | Promise<void>;

export interface BatcherOptions {
  strategy: BatchingStrategy;
  delayMs: number;
  maxWaitMs: number;
  windowMs: number;
  onFlush: FlushCallback;
}

/* ──────────────────────── Base interface ─────────────────────────── */

export interface Batcher {
  /** Add a file change to the current batch. */
  add(change: FileChange): void;
  /** Force flush the current batch immediately. */
  flush(): Promise<void>;
  /** Stop the batcher and flush any pending changes. */
  close(): Promise<void>;
}

/* ──────────────────── Collapse helper ────────────────────────────── */

/**
 * Collapse repeated saves of the same file to the newest content.
 * If a file appears multiple times, only the last change is kept.
 * If the last event is "unlink", the file was deleted.
 */
export function collapseChanges(changes: FileChange[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const change of changes) {
    const existing = map.get(change.relPath);
    if (existing) {
      // Update with newest content/state
      map.set(change.relPath, {
        ...change,
        // Preserve oldContent from the first occurrence if available
        oldContent: existing.oldContent ?? change.oldContent,
      });
    } else {
      map.set(change.relPath, change);
    }
  }
  return [...map.values()];
}

/* ──────────────────── Debounce batcher ──────────────────────────── */

/**
 * Debounce batching: wait for `delayMs` of inactivity before flushing.
 * Also enforces a `maxWaitMs` to ensure changes are eventually delivered.
 * Repeated saves of the same file collapse to the newest content.
 */
export class DebounceBatcher implements Batcher {
  private pending: FileChange[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: BatcherOptions;
  private closed = false;

  constructor(opts: BatcherOptions) {
    this.opts = opts;
  }

  add(change: FileChange): void {
    if (this.closed) return;
    this.pending.push(change);
    this.resetDebounce();
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        void this.flush();
      }, this.opts.maxWaitMs);
    }
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.opts.delayMs);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
    if (this.pending.length === 0) return;

    const collapsed = collapseChanges(this.pending);
    this.pending = [];
    await this.opts.onFlush(collapsed);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

/* ──────────────── Fixed-window batcher ──────────────────────────── */

/**
 * Fixed-window batching: collect changes for `windowMs` then flush.
 * Repeated saves of the same file collapse to the newest content.
 */
export class FixedWindowBatcher implements Batcher {
  private pending: FileChange[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: BatcherOptions;
  private closed = false;

  constructor(opts: BatcherOptions) {
    this.opts = opts;
  }

  add(change: FileChange): void {
    if (this.closed) return;
    this.pending.push(change);
    if (!this.windowTimer) {
      this.windowTimer = setTimeout(() => {
        void this.flush();
      }, this.opts.windowMs);
    }
  }

  async flush(): Promise<void> {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.pending.length === 0) return;

    const collapsed = collapseChanges(this.pending);
    this.pending = [];
    await this.opts.onFlush(collapsed);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

/* ──────────────── Immediate batcher ─────────────────────────────── */

/**
 * Immediate batching: flush on the next tick after any change.
 * Still collapses multiple changes received in the same tick.
 */
export class ImmediateBatcher implements Batcher {
  private pending: FileChange[] = [];
  private flushScheduled = false;
  private readonly opts: BatcherOptions;
  private closed = false;

  constructor(opts: BatcherOptions) {
    this.opts = opts;
  }

  add(change: FileChange): void {
    if (this.closed) return;
    this.pending.push(change);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        void this.flush();
      });
    }
  }

  async flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;

    const collapsed = collapseChanges(this.pending);
    this.pending = [];
    await this.opts.onFlush(collapsed);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

/* ──────────────────────── Factory ───────────────────────────────── */

export function createBatcher(
  config: Pick<HypervigilantConfig, "batching">,
  onFlush: FlushCallback,
): Batcher {
  const batching = config.batching;
  const opts: BatcherOptions = {
    strategy: batching.strategy,
    delayMs: batching.delayMs,
    maxWaitMs: batching.maxWaitMs,
    windowMs: batching.windowMs,
    onFlush,
  };

  switch (batching.strategy) {
    case "debounce":
      return new DebounceBatcher(opts);
    case "fixed-window":
      return new FixedWindowBatcher(opts);
    case "immediate":
      return new ImmediateBatcher(opts);
  }
}
