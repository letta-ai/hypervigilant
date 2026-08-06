import { describe, expect, it } from "bun:test";
import {
  collapseChanges,
  createBatcher,
  DebounceBatcher,
  FixedWindowBatcher,
  ImmediateBatcher,
} from "../src/batcher.ts";
import type { FileChange } from "../src/watcher.ts";

// Helper to create a minimal FileChange
function makeChange(
  relPath: string,
  content: string,
  event: "add" | "change" | "unlink" = "change",
): FileChange {
  return {
    relPath,
    absPath: `/project/${relPath}`,
    event,
    kind: "text",
    oldContent: null,
    newContent: event === "unlink" ? null : content,
    hash: event === "unlink" ? null : `hash-${content.length}`,
    size: event === "unlink" ? null : content.length,
  };
}

// Helper to wait for a promise to resolve
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("batcher", () => {
  describe("collapseChanges", () => {
    it("should collapse repeated saves to the newest content", () => {
      const changes = [
        makeChange("file.md", "version 1"),
        makeChange("file.md", "version 2"),
        makeChange("file.md", "version 3"),
      ];
      const collapsed = collapseChanges(changes);
      expect(collapsed.length).toBe(1);
      expect(collapsed[0]?.newContent).toBe("version 3");
    });

    it("should keep separate files separate", () => {
      const changes = [makeChange("file1.md", "a"), makeChange("file2.md", "b")];
      const collapsed = collapseChanges(changes);
      expect(collapsed.length).toBe(2);
    });

    it("should handle deletion as the final state", () => {
      const changes = [
        makeChange("file.md", "content", "change"),
        makeChange("file.md", "", "unlink"),
      ];
      const collapsed = collapseChanges(changes);
      expect(collapsed.length).toBe(1);
      expect(collapsed[0]?.event).toBe("unlink");
      expect(collapsed[0]?.newContent).toBeNull();
    });
  });

  describe("DebounceBatcher", () => {
    it("should batch changes after delayMs of inactivity", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new DebounceBatcher({
        strategy: "debounce",
        delayMs: 50,
        maxWaitMs: 5000,
        windowMs: 2000,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      batcher.add(makeChange("file.md", "v1"));
      batcher.add(makeChange("file.md", "v2"));
      batcher.add(makeChange("file.md", "v3"));

      await sleep(100);
      expect(flushed.length).toBe(1);
      expect(flushed[0]?.length).toBe(1);
      expect(flushed[0]?.[0]?.newContent).toBe("v3");

      await batcher.close();
    });

    it("should enforce maxWaitMs", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new DebounceBatcher({
        strategy: "debounce",
        delayMs: 1000,
        maxWaitMs: 80,
        windowMs: 2000,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      batcher.add(makeChange("file.md", "v1"));
      await sleep(30);
      batcher.add(makeChange("file.md", "v2"));
      await sleep(80);
      expect(flushed.length).toBe(1);

      await batcher.close();
    });

    it("should not flush when empty", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new DebounceBatcher({
        strategy: "debounce",
        delayMs: 10,
        maxWaitMs: 100,
        windowMs: 2000,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      await sleep(50);
      expect(flushed.length).toBe(0);
      await batcher.close();
    });
  });

  describe("FixedWindowBatcher", () => {
    it("should batch changes for windowMs then flush", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new FixedWindowBatcher({
        strategy: "fixed-window",
        delayMs: 500,
        maxWaitMs: 5000,
        windowMs: 50,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      batcher.add(makeChange("file1.md", "a"));
      batcher.add(makeChange("file2.md", "b"));
      await sleep(80);
      expect(flushed.length).toBe(1);
      expect(flushed[0]?.length).toBe(2);

      await batcher.close();
    });
  });

  describe("ImmediateBatcher", () => {
    it("should flush on the next microtask", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new ImmediateBatcher({
        strategy: "immediate",
        delayMs: 500,
        maxWaitMs: 5000,
        windowMs: 2000,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      batcher.add(makeChange("file.md", "a"));
      await sleep(10);
      expect(flushed.length).toBe(1);

      await batcher.close();
    });

    it("should collapse changes in the same tick", async () => {
      const flushed: FileChange[][] = [];
      const batcher = new ImmediateBatcher({
        strategy: "immediate",
        delayMs: 500,
        maxWaitMs: 5000,
        windowMs: 2000,
        onFlush: async (changes) => {
          flushed.push(changes);
        },
      });

      batcher.add(makeChange("file.md", "v1"));
      batcher.add(makeChange("file.md", "v2"));
      batcher.add(makeChange("file.md", "v3"));
      await sleep(10);
      expect(flushed.length).toBe(1);
      expect(flushed[0]?.length).toBe(1);
      expect(flushed[0]?.[0]?.newContent).toBe("v3");

      await batcher.close();
    });
  });

  describe("createBatcher", () => {
    it("should create a DebounceBatcher for debounce strategy", () => {
      const batcher = createBatcher(
        {
          batching: {
            strategy: "debounce",
            delayMs: 100,
            maxWaitMs: 1000,
            windowMs: 500,
          },
        },
        async () => {},
      );
      expect(batcher).toBeInstanceOf(DebounceBatcher);
    });

    it("should create a FixedWindowBatcher for fixed-window strategy", () => {
      const batcher = createBatcher(
        {
          batching: {
            strategy: "fixed-window",
            delayMs: 100,
            maxWaitMs: 1000,
            windowMs: 500,
          },
        },
        async () => {},
      );
      expect(batcher).toBeInstanceOf(FixedWindowBatcher);
    });

    it("should create an ImmediateBatcher for immediate strategy", () => {
      const batcher = createBatcher(
        {
          batching: {
            strategy: "immediate",
            delayMs: 100,
            maxWaitMs: 1000,
            windowMs: 500,
          },
        },
        async () => {},
      );
      expect(batcher).toBeInstanceOf(ImmediateBatcher);
    });
  });
});
