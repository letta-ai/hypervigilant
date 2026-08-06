import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { type Batcher, createBatcher } from "../src/batcher.ts";
import { createGlobMatcher, type HypervigilantConfig } from "../src/config.ts";
import {
  type HypervigilantState,
  hashContent,
  removeSnapshot,
  StateStore,
  setSnapshot,
  toRelPath,
} from "../src/state.ts";
import {
  establishBaseline,
  establishBinaryBaseline,
  formatDeliveryStatus,
  watchCommand,
} from "../src/watch.ts";
import {
  checkFileSize,
  detectOfflineChanges,
  type FileChange,
  FileWatcher,
  isTextFile,
  walkProject,
} from "../src/watcher.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

async function rmrf(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("integration", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "hypervigilant-integration-"));
  });

  afterEach(async () => {
    await rmrf(testRoot);
  });

  function makeConfig(overrides: Partial<HypervigilantConfig> = {}): HypervigilantConfig {
    return {
      version: 1,
      project: "test-project",
      agentId: "agent-test",
      include: ["**/*.md", "**/*.txt"],
      exclude: ["**/node_modules/**", "**/.git/**"],
      maxFileSizeBytes: 1_048_576,
      batching: {
        strategy: "immediate",
        delayMs: 10,
        maxWaitMs: 100,
        windowMs: 50,
      },
      mode: "review",
      routing: "project",
      stateDir: ".hypervigilant",
      instructions: "",
      worktree: { enabled: false, autoCommit: true, branchPrefix: "hypervigilant" },
      ...overrides,
      promptRules: overrides.promptRules ?? [],
      tools: overrides.tools ?? { autoAllow: [], ask: [] },
    };
  }

  describe("watch startup", () => {
    it("checks agent availability before creating state", async () => {
      await writeFile(
        join(testRoot, "hypervigilant.toml"),
        'version = 1\nproject = "startup"\nagent_id = "agent-missing"\n',
      );
      let checkedAgentId: string | undefined;
      await expect(
        watchCommand(
          {
            path: testRoot,
            runtimeEnv: { LETTA_API_KEY: "test-key" },
            async validateAgent(agentId) {
              checkedAgentId = agentId;
              throw new Error("404 Agent not found");
            },
          },
          new LettaAgentClient({ backend: "cloud", apiKey: "unused" }),
        ),
      ).rejects.toThrow("Configured agent agent-missing is not available");
      expect(checkedAgentId).toBe("agent-missing");
      expect(existsSync(join(testRoot, ".hypervigilant"))).toBe(false);
    });

    it("fails closed when configured ask tools have no interactive callback", async () => {
      await writeFile(
        join(testRoot, "hypervigilant.toml"),
        'version = 1\nproject = "startup"\nagent_id = "agent-test"\nmode = "review"\n\n[tools]\nask = ["TodoWrite"]\n',
      );
      await expect(
        watchCommand(
          {
            path: testRoot,
            runtimeEnv: { LETTA_API_KEY: "test-key" },
          },
          new LettaAgentClient({ backend: "cloud", apiKey: "unused" }),
        ),
      ).rejects.toThrow(
        "Configured ask tools require an interactive client-tool approval callback",
      );
      expect(existsSync(join(testRoot, ".hypervigilant"))).toBe(false);
    });
  });

  describe("delivery status", () => {
    it("names one changed file", () => {
      expect(formatDeliveryStatus([{ relPath: "src/greeting.ts" }])).toBe(
        "Sending 1 saved change to the agent: src/greeting.ts",
      );
    });

    it("lists several files without making the status unbounded", () => {
      expect(
        formatDeliveryStatus(
          ["a.md", "b.md", "c.md", "d.md", "e.md"].map((relPath) => ({ relPath })),
        ),
      ).toBe("Sending 5 saved changes to the agent: a.md, b.md, c.md, d.md, and 1 more");
    });
  });

  describe("walkProject + glob matching", () => {
    it("should find all matching files", async () => {
      await writeFile(join(testRoot, "README.md"), "# Test", "utf8");
      await writeFile(join(testRoot, "notes.txt"), "notes", "utf8");
      await writeFile(join(testRoot, "index.ts"), "console.log()", "utf8");
      await mkdir(join(testRoot, "docs"), { recursive: true });
      await writeFile(join(testRoot, "docs", "guide.md"), "# Guide", "utf8");
      await mkdir(join(testRoot, "node_modules"), { recursive: true });
      await writeFile(join(testRoot, "node_modules", "pkg.md"), "should be excluded", "utf8");

      const config = makeConfig();
      const matcher = createGlobMatcher(config);
      const files = await walkProject(testRoot, matcher, config);
      const relFiles = files.map((f) => toRelPath(testRoot, f)).sort();

      expect(relFiles).toEqual(["README.md", "docs/guide.md", "notes.txt"]);
    });
  });

  describe("text detection", () => {
    it("should detect text files correctly", async () => {
      const textPath = join(testRoot, "text.md");
      await writeFile(textPath, "This is text content", "utf8");
      expect(await isTextFile(textPath)).toBe(true);
    });

    it("should detect binary files by null bytes", async () => {
      const binPath = join(testRoot, "binary.bin");
      const buffer = Buffer.alloc(100, 0);
      buffer[0] = 0x42;
      await writeFile(binPath, buffer);
      expect(await isTextFile(binPath)).toBe(false);
    });
  });

  describe("file size check", () => {
    it("should allow files under the limit", async () => {
      const filePath = join(testRoot, "small.txt");
      await writeFile(filePath, "small", "utf8");
      const result = await checkFileSize(filePath, 100);
      expect(result.ok).toBe(true);
    });

    it("should reject files over the limit", async () => {
      const filePath = join(testRoot, "large.txt");
      await writeFile(filePath, "x".repeat(200), "utf8");
      const result = await checkFileSize(filePath, 100);
      expect(result.ok).toBe(false);
    });
  });

  describe("baseline safeguards", () => {
    it("stores binary metadata without bytes and skips oversized files", async () => {
      const config = makeConfig({ include: ["**/*"], maxFileSizeBytes: 20 });
      await writeFile(join(testRoot, "safe.txt"), "safe", "utf8");
      await writeFile(join(testRoot, "large.txt"), "x".repeat(21), "utf8");
      await writeFile(join(testRoot, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
      const state = await establishBaseline(testRoot, config);
      expect(Object.keys(state.snapshots).sort()).toEqual(["binary.bin", "safe.txt"]);
      expect(state.snapshots["safe.txt"]?.content).toBe("safe");
      expect(state.snapshots["binary.bin"]).toMatchObject({
        kind: "binary",
        size: 3,
        content: null,
      });
      expect(state.snapshots["binary.bin"]?.hash).toHaveLength(64);
      expect(state.binaryBaselineEstablished).toBe(true);
    });

    it("does not follow matching binary symlinks", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      await writeFile(join(testRoot, "target.data"), Buffer.from([0x41, 0x00, 0x42]));
      await symlink("target.data", join(testRoot, "linked.png"));

      const state = await establishBaseline(testRoot, config);
      expect(state.snapshots).toEqual({});
    });

    it("baselines existing binary files once when old state is upgraded", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      await writeFile(
        join(testRoot, "existing.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      );
      const oldState: HypervigilantState = {
        version: 1,
        agentId: "agent-test",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };

      const upgraded = await establishBinaryBaseline(testRoot, config, oldState);
      expect(upgraded.binaryBaselineEstablished).toBe(true);
      expect(upgraded.snapshots["existing.png"]?.kind).toBe("binary");
      expect(await detectOfflineChanges(testRoot, config, upgraded.snapshots)).toEqual([]);
    });
  });

  describe("offline change detection", () => {
    it("should detect new files added while stopped", async () => {
      const config = makeConfig();
      const store = new StateStore({
        stateDir: join(testRoot, ".hypervigilant"),
      });

      await writeFile(join(testRoot, "file1.md"), "content 1", "utf8");
      let state: HypervigilantState = {
        version: 1,
        agentId: "agent-test",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };
      const content1 = "content 1";
      const hash1 = await hashContent(content1);
      state = setSnapshot(state, "file1.md", hash1, content1.length, content1);
      await store.save(state);

      await writeFile(join(testRoot, "file2.md"), "content 2", "utf8");

      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);
      expect(changes.length).toBe(1);
      expect(changes[0]?.relPath).toBe("file2.md");
      expect(changes[0]?.event).toBe("add");
    });

    it("should detect modified files while stopped", async () => {
      const config = makeConfig();
      const store = new StateStore({
        stateDir: join(testRoot, ".hypervigilant"),
      });

      await writeFile(join(testRoot, "file1.md"), "original", "utf8");
      let state: HypervigilantState = {
        version: 1,
        agentId: "agent-test",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };
      const hash1 = await hashContent("original");
      state = setSnapshot(state, "file1.md", hash1, "original".length, "original");
      await store.save(state);

      await writeFile(join(testRoot, "file1.md"), "modified", "utf8");

      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);
      expect(changes.length).toBe(1);
      expect(changes[0]?.relPath).toBe("file1.md");
      expect(changes[0]?.event).toBe("change");
      expect(changes[0]?.oldContent).toBe("original");
      expect(changes[0]?.newContent).toBe("modified");
    });

    it("detects changed binary files while stopped without retaining bytes", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      const imagePath = join(testRoot, "photo.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const state = await establishBaseline(testRoot, config);

      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        relPath: "photo.png",
        event: "change",
        kind: "binary",
        oldContent: null,
        newContent: null,
        size: 6,
      });
      expect(changes[0]?.hash).not.toBe(state.snapshots["photo.png"]?.hash);
    });

    it("detects deleted binary files while stopped", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      const imagePath = join(testRoot, "photo.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const state = await establishBaseline(testRoot, config);

      await unlink(imagePath);
      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        relPath: "photo.png",
        event: "unlink",
        kind: "binary",
        oldContent: null,
        newContent: null,
      });
    });

    it("should detect deleted files while stopped", async () => {
      const config = makeConfig();
      const store = new StateStore({
        stateDir: join(testRoot, ".hypervigilant"),
      });

      await writeFile(join(testRoot, "file1.md"), "content", "utf8");
      let state: HypervigilantState = {
        version: 1,
        agentId: "agent-test",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };
      const hash1 = await hashContent("content");
      state = setSnapshot(state, "file1.md", hash1, "content".length, "content");
      await store.save(state);

      await unlink(join(testRoot, "file1.md"));

      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);
      expect(changes.length).toBe(1);
      expect(changes[0]?.relPath).toBe("file1.md");
      expect(changes[0]?.event).toBe("unlink");
      expect(changes[0]?.oldContent).toBe("content");
    });

    it("should detect a new file after an empty baseline", async () => {
      const config = makeConfig();
      await writeFile(join(testRoot, "first.md"), "first content", "utf8");
      const changes = await detectOfflineChanges(testRoot, config, {});
      expect(changes).toHaveLength(1);
      expect(changes[0]?.event).toBe("add");
      expect(changes[0]?.oldContent).toBeNull();
    });

    it("should not report changes when nothing changed", async () => {
      const config = makeConfig();
      await writeFile(join(testRoot, "file1.md"), "content", "utf8");
      const hash1 = await hashContent("content");
      const snapshots = {
        "file1.md": {
          path: "file1.md",
          hash: hash1,
          size: "content".length,
          content: "content",
          kind: "text" as const,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      };

      const changes = await detectOfflineChanges(testRoot, config, snapshots);
      expect(changes.length).toBe(0);
    });
  });

  describe("FileWatcher with batching", () => {
    it("should detect file additions and deliver via batcher", async () => {
      const config = makeConfig({
        batching: {
          strategy: "immediate",
          delayMs: 10,
          maxWaitMs: 100,
          windowMs: 50,
        },
      });
      const delivered: FileChange[] = [];

      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });

      await new Promise<void>((resolve) => {
        void watcher.start(() => resolve());
      });
      await sleep(50);

      await writeFile(join(testRoot, "new.md"), "new content", "utf8");
      await sleep(600);

      await watcher.stop();
      await batcher.close();

      expect(delivered.length).toBeGreaterThan(0);
      const newFileChange = delivered.find((c) => c.relPath === "new.md");
      expect(newFileChange).toBeDefined();
      expect(newFileChange?.event).toBe("add");
      expect(newFileChange?.newContent).toBe("new content");
    });

    it("delivers binary arrivals as metadata-only changes", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      const delivered: FileChange[] = [];
      const batcher = createBatcher(config, (changes) => {
        delivered.push(...changes);
      });
      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });
      await new Promise<void>((resolve) => void watcher.start(resolve));
      await sleep(50);

      await writeFile(
        join(testRoot, "photo.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      );
      expect(await waitFor(() => delivered.length === 1)).toBe(true);
      await watcher.stop();
      await batcher.close();

      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        relPath: "photo.png",
        event: "add",
        kind: "binary",
        oldContent: null,
        newContent: null,
        size: 6,
      });
      expect(delivered[0]?.hash).toHaveLength(64);
    });

    it("delivers live binary changes and deletions from snapshot metadata", async () => {
      const config = makeConfig({ include: ["**/*.png"] });
      const imagePath = join(testRoot, "photo.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const state = await establishBaseline(testRoot, config);
      const delivered: FileChange[] = [];
      const batcher = createBatcher(config, (changes) => {
        delivered.push(...changes);
      });
      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        getPreviousSnapshot: (relPath) => state.snapshots[relPath],
        onChange: (change) => batcher.add(change),
      });
      await new Promise<void>((resolve) => void watcher.start(resolve));
      await sleep(50);

      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
      expect(await waitFor(() => delivered.length === 1)).toBe(true);
      await unlink(imagePath);
      expect(await waitFor(() => delivered.length === 2)).toBe(true);
      await watcher.stop();
      await batcher.close();

      expect(delivered.map((change) => [change.event, change.kind])).toEqual([
        ["change", "binary"],
        ["unlink", "binary"],
      ]);
      expect(delivered.every((change) => change.oldContent === null)).toBe(true);
      expect(delivered.every((change) => change.newContent === null)).toBe(true);
    });

    it("should watch matching files in nested directories", async () => {
      const config = makeConfig();
      const delivered: FileChange[] = [];
      await mkdir(join(testRoot, "docs", "nested"), { recursive: true });
      const batcher = createBatcher(config, (changes) => {
        delivered.push(...changes);
      });
      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });
      await new Promise<void>((resolve) => void watcher.start(resolve));
      await writeFile(join(testRoot, "docs", "nested", "guide.md"), "guide", "utf8");
      await sleep(600);
      await watcher.stop();
      await batcher.close();
      expect(delivered.some((change) => change.relPath === "docs/nested/guide.md")).toBe(true);
    });

    it("should detect file modifications and deliver via batcher", async () => {
      const config = makeConfig();
      await writeFile(join(testRoot, "file.md"), "original", "utf8");

      const delivered: FileChange[] = [];
      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        getPreviousContent: () => "original",
        onChange: (change) => batcher.add(change),
      });

      await new Promise<void>((resolve) => {
        void watcher.start(() => resolve());
      });
      await sleep(50);

      await writeFile(join(testRoot, "file.md"), "modified content", "utf8");
      await sleep(600);

      await watcher.stop();
      await batcher.close();

      const change = delivered.find((c) => c.relPath === "file.md");
      expect(change).toBeDefined();
      expect(change?.event).toBe("change");
      expect(change?.oldContent).toBe("original");
      expect(change?.newContent).toBe("modified content");
    });

    it("should detect file deletions", async () => {
      const config = makeConfig();
      await writeFile(join(testRoot, "file.md"), "content", "utf8");

      const delivered: FileChange[] = [];
      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });

      await new Promise<void>((resolve) => {
        void watcher.start(resolve);
      });
      await sleep(50);

      await unlink(join(testRoot, "file.md"));
      expect(await waitFor(() => delivered.some((change) => change.relPath === "file.md"))).toBe(
        true,
      );

      await watcher.stop();
      await batcher.close();

      const change = delivered.find((c) => c.relPath === "file.md");
      expect(change).toBeDefined();
      expect(change?.event).toBe("unlink");
      expect(change?.newContent).toBeNull();
    });

    it("should suppress agent-originated changes", async () => {
      const config = makeConfig();
      await writeFile(join(testRoot, "file.md"), "original", "utf8");

      const delivered: FileChange[] = [];
      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      const suppressedPaths = new Set<string>();
      const suppressedChanges: FileChange[] = [];
      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
        isSuppressed: (relPath) => suppressedPaths.has(relPath),
        onSuppressedChange: (change) => {
          suppressedChanges.push(change);
        },
      });

      await new Promise<void>((resolve) => {
        void watcher.start(resolve);
      });
      await sleep(50);

      suppressedPaths.add("file.md");
      await writeFile(join(testRoot, "file.md"), "agent modified", "utf8");
      expect(
        await waitFor(() => suppressedChanges.some((change) => change.relPath === "file.md")),
      ).toBe(true);

      await watcher.stop();
      await batcher.close();

      const change = delivered.find((c) => c.relPath === "file.md");
      expect(change).toBeUndefined();
      expect(suppressedChanges.some((item) => item.relPath === "file.md")).toBe(true);
    });

    it("should ignore excluded files", async () => {
      const config = makeConfig({
        exclude: ["**/excluded/**", ...makeConfig().exclude],
      });

      const delivered: FileChange[] = [];
      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      await mkdir(join(testRoot, "excluded"), { recursive: true });

      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });

      await new Promise<void>((resolve) => {
        void watcher.start(resolve);
      });
      await sleep(50);

      await writeFile(join(testRoot, "excluded", "file.md"), "should be excluded", "utf8");
      await sleep(200);

      await watcher.stop();
      await batcher.close();

      const change = delivered.find((c) => c.relPath === "excluded/file.md");
      expect(change).toBeUndefined();
    });

    it("should ignore oversized binary files", async () => {
      const config = makeConfig({
        include: ["**/*.bin", ...makeConfig().include],
        maxFileSizeBytes: 50,
      });

      const delivered: FileChange[] = [];
      const batcher: Batcher = createBatcher(config, async (changes) => {
        delivered.push(...changes);
      });

      const watcher = new FileWatcher({
        projectRoot: testRoot,
        config,
        onChange: (change) => batcher.add(change),
      });

      await new Promise<void>((resolve) => {
        void watcher.start(resolve);
      });
      await sleep(50);

      const buffer = Buffer.alloc(100, 0);
      buffer[0] = 0x42;
      await writeFile(join(testRoot, "binary.bin"), buffer);
      await sleep(600);

      await watcher.stop();
      await batcher.close();

      const change = delivered.find((c) => c.relPath === "binary.bin");
      expect(change).toBeUndefined();
    });
  });

  describe("state persistence across restarts", () => {
    it("should persist and reload state", async () => {
      const stateDir = join(testRoot, ".hypervigilant");
      const store = new StateStore({ stateDir });

      const state: HypervigilantState = {
        version: 1,
        agentId: "agent-xxx",
        projectConversation: { conversationId: "conv-123" },
        fileConversations: { "file.md": "conv-file" },
        snapshots: {
          "file.md": {
            path: "file.md",
            hash: "abc",
            size: 10,
            content: "saved text",
            kind: "text",
            updatedAt: "2025-01-01T00:00:00.000Z",
          },
        },
      };

      await store.save(state);

      const store2 = new StateStore({ stateDir });
      const loaded = await store2.load();

      expect(loaded).not.toBeNull();
      expect(loaded?.agentId).toBe("agent-xxx");
      expect(loaded?.projectConversation.conversationId).toBe("conv-123");
      expect(loaded?.fileConversations["file.md"]).toBe("conv-file");
      expect(loaded?.snapshots["file.md"]?.hash).toBe("abc");
    });
  });

  describe("full pipeline: baseline + offline + delivery", () => {
    it("should establish baseline, detect offline changes, and deliver", async () => {
      const config = makeConfig();
      const stateDir = join(testRoot, config.stateDir);
      const store = new StateStore({ stateDir });

      // Phase 1: Establish baseline
      await writeFile(join(testRoot, "file1.md"), "content 1", "utf8");
      await writeFile(join(testRoot, "file2.md"), "content 2", "utf8");

      let state: HypervigilantState = {
        version: 1,
        agentId: config.agentId,
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };

      const matcher = createGlobMatcher(config);
      const files = await walkProject(testRoot, matcher, config);
      for (const absPath of files) {
        const relPath = toRelPath(testRoot, absPath);
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(absPath, "utf8");
        const hash = await hashContent(content);
        state = setSnapshot(state, relPath, hash, Buffer.byteLength(content), content);
      }
      await store.save(state);

      // Phase 2: Offline changes
      await writeFile(join(testRoot, "file3.md"), "new file", "utf8");
      await writeFile(join(testRoot, "file1.md"), "modified 1", "utf8");
      await unlink(join(testRoot, "file2.md"));

      // Phase 3: Detect and deliver
      const changes = await detectOfflineChanges(testRoot, config, state.snapshots);
      expect(changes.length).toBe(3);

      const events = changes.map((c) => `${c.relPath}:${c.event}`).sort();
      expect(events).toContain("file1.md:change");
      expect(events).toContain("file2.md:unlink");
      expect(events).toContain("file3.md:add");

      // Simulate delivery (faked)
      for (const change of changes) {
        if (change.event === "unlink") {
          state = removeSnapshot(state, change.relPath);
        } else {
          state = setSnapshot(state, change.relPath, change.hash, change.size, change.newContent);
        }
      }
      await store.save(state);

      // Verify state advanced
      const loadedState = await store.load();
      expect(loadedState?.snapshots["file1.md"]?.hash).toBe(await hashContent("modified 1"));
      expect(loadedState?.snapshots["file2.md"]).toBeUndefined();
      expect(loadedState?.snapshots["file3.md"]).toBeDefined();

      // Phase 4: No more changes detected
      const changes2 = await detectOfflineChanges(testRoot, config, state.snapshots);
      expect(changes2.length).toBe(0);
    });
  });
});
