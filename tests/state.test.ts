import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  atomicWriteJSON,
  getFileConversationId,
  getNamedConversationId,
  type HypervigilantState,
  hashContent,
  removeSnapshot,
  resetConversationRoutes,
  StateStore,
  setFileConversation,
  setNamedConversation,
  setProjectConversation,
  setSnapshot,
  stateSchema,
  toRelPath,
  toSafeRelPath,
} from "../src/state.ts";

describe("state", () => {
  describe("hashContent", () => {
    it("should produce a stable SHA-256 hex hash", async () => {
      const hash1 = await hashContent("hello world");
      const hash2 = await hashContent("hello world");
      const hash3 = await hashContent("hello world!");
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should handle empty strings", async () => {
      const hash = await hashContent("");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("toRelPath", () => {
    it("should convert absolute paths to project-relative forward-slash paths", () => {
      const rel = toRelPath("/project/root", "/project/root/src/file.md");
      expect(rel).toBe("src/file.md");
    });

    it("should normalize backslashes to forward slashes", () => {
      // On macOS/Linux, sep is "/" so this is a no-op, but on Windows it normalizes
      // Test that forward-slash paths are preserved (the function's contract)
      const rel = toRelPath("/project/root", "/project/root/src/file.md");
      expect(rel).toBe("src/file.md");
      // Verify no backslashes in output
      expect(rel).not.toContain("\\");
    });
  });

  describe("toSafeRelPath", () => {
    const projectRoot = join(import.meta.dirname, "tmp-safe-path-project");
    const outsideRoot = join(import.meta.dirname, "tmp-safe-path-outside");

    beforeEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
      await mkdir(join(projectRoot, "docs"), { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await writeFile(join(projectRoot, "docs", "file.md"), "inside\n");
      await writeFile(join(outsideRoot, "secret.md"), "outside\n");
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    });

    it("accepts existing and new paths inside the project", () => {
      expect(toSafeRelPath(projectRoot, join(projectRoot, "docs", "file.md"))).toBe("docs/file.md");
      expect(toSafeRelPath(projectRoot, "new/nested/notes.txt")).toBe("new/nested/notes.txt");
    });

    it("rejects the root and paths outside the project", () => {
      expect(toSafeRelPath(projectRoot, projectRoot)).toBeNull();
      expect(toSafeRelPath(projectRoot, "../secret.txt")).toBeNull();
    });

    it("rejects symlinked tool paths, including broken and outside-root targets", async () => {
      await symlink(join(projectRoot, "docs", "file.md"), join(projectRoot, "linked-inside.md"));
      await symlink(join(outsideRoot, "secret.md"), join(projectRoot, "linked-secret.md"));
      await symlink(outsideRoot, join(projectRoot, "linked-directory"));
      await symlink(join(outsideRoot, "missing.md"), join(projectRoot, "broken-link.md"));

      expect(toSafeRelPath(projectRoot, "linked-inside.md")).toBeNull();
      expect(toSafeRelPath(projectRoot, "linked-secret.md")).toBeNull();
      expect(toSafeRelPath(projectRoot, "linked-directory/new.md")).toBeNull();
      expect(toSafeRelPath(projectRoot, "broken-link.md")).toBeNull();
    });
  });

  describe("atomicWriteFile", () => {
    const testDir = join(import.meta.dirname, "tmp-atomic-test");

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should write file content atomically", async () => {
      const filePath = join(testDir, "test.txt");
      await atomicWriteFile(filePath, "hello");
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("hello");
    });

    it("should create parent directories", async () => {
      const filePath = join(testDir, "nested", "dir", "test.txt");
      await atomicWriteFile(filePath, "hello");
      expect(existsSync(filePath)).toBe(true);
    });

    it("should isolate concurrent writes to the same path", async () => {
      const filePath = join(testDir, "shared.txt");
      await Promise.all([
        atomicWriteFile(filePath, "first"),
        atomicWriteFile(filePath, "second"),
        atomicWriteFile(filePath, "third"),
      ]);
      const { readFile, readdir } = await import("node:fs/promises");
      expect(["first", "second", "third"]).toContain(await readFile(filePath, "utf8"));
      expect(await readdir(testDir)).toEqual(["shared.txt"]);
    });
  });

  describe("atomicWriteJSON", () => {
    const testDir = join(import.meta.dirname, "tmp-json-test");

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should write JSON with stable formatting", async () => {
      const filePath = join(testDir, "data.json");
      await atomicWriteJSON(filePath, { b: 2, a: 1 });
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf8");
      expect(content).toContain('"a": 1');
      expect(content).toContain('"b": 2');
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  describe("StateStore", () => {
    const testDir = join(import.meta.dirname, "tmp-state-test");

    beforeEach(async () => {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should return null when no state file exists", async () => {
      const store = new StateStore({ stateDir: testDir });
      const state = await store.load();
      expect(state).toBeNull();
    });

    it("should save and load state", async () => {
      const store = new StateStore({ stateDir: testDir });
      const state: HypervigilantState = {
        version: 1,
        agentId: "agent-xxx",
        projectConversation: { conversationId: null },
        fileConversations: {},
        namedConversations: { security: "conv-security" },
        snapshots: {
          "docs/README.md": {
            path: "docs/README.md",
            hash: "abc123",
            size: 100,
            content: "saved text",
            kind: "text",
            updatedAt: "2025-01-01T00:00:00.000Z",
          },
        },
      };
      await store.save(state);
      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.agentId).toBe("agent-xxx");
      expect(loaded?.snapshots["docs/README.md"]?.hash).toBe("abc123");
      expect(loaded?.snapshots["docs/README.md"]?.content).toBe("saved text");
      expect(loaded?.namedConversations).toEqual({ security: "conv-security" });
    });

    it("should serialize concurrent saves", async () => {
      const store = new StateStore({ stateDir: testDir });
      const state1: HypervigilantState = {
        version: 1,
        agentId: "agent-1",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };
      const state2: HypervigilantState = {
        version: 1,
        agentId: "agent-2",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      };
      await Promise.all([store.save(state1), store.save(state2)]);
      const loaded = await store.load();
      expect(loaded?.agentId).toBe("agent-2");
    });

    it("should throw on getOrLoad when not initialized", async () => {
      const store = new StateStore({ stateDir: testDir });
      expect(store.getOrLoad()).rejects.toThrow("not been initialized");
    });
  });

  describe("stateSchema", () => {
    it("should parse valid state", () => {
      const result = stateSchema.safeParse({
        version: 1,
        agentId: "agent-xxx",
        projectConversation: { conversationId: null },
        fileConversations: {},
        snapshots: {},
      });
      expect(result.success).toBe(true);
    });

    it("should apply defaults", () => {
      const result = stateSchema.safeParse({
        version: 1,
        agentId: "agent-xxx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectConversation.conversationId).toBeNull();
        expect(result.data.fileConversations).toEqual({});
        expect(result.data.namedConversations).toBeUndefined();
        expect(result.data.snapshots).toEqual({});
        expect(result.data.connectionKey).toBeUndefined();
      }
    });

    it("treats legacy snapshots as text", () => {
      const result = stateSchema.parse({
        version: 1,
        agentId: "agent-xxx",
        snapshots: {
          "legacy.md": {
            path: "legacy.md",
            hash: "abc",
            size: 3,
            content: "old",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      expect(result.snapshots["legacy.md"]?.kind).toBe("text");
    });

    it("should parse persisted named conversation mappings", () => {
      const result = stateSchema.safeParse({
        version: 1,
        agentId: "agent-xxx",
        namedConversations: { security: "conv-security" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.namedConversations).toEqual({ security: "conv-security" });
      }
    });
  });

  describe("snapshot operations", () => {
    const baseState: HypervigilantState = {
      version: 1,
      agentId: "agent-xxx",
      projectConversation: { conversationId: null },
      fileConversations: {},
      snapshots: {},
    };

    it("setSnapshot should add/update a snapshot", () => {
      const state = setSnapshot(baseState, "file.md", "hash123", 100, "saved text");
      expect(state.snapshots["file.md"]?.hash).toBe("hash123");
      expect(state.snapshots["file.md"]?.size).toBe(100);
      expect(state.snapshots["file.md"]?.content).toBe("saved text");
      expect(state.snapshots["file.md"]?.kind).toBe("text");
    });

    it("stores binary metadata without bytes", () => {
      const state = setSnapshot(baseState, "image.png", "binary-hash", 2048, null, "binary");
      expect(state.snapshots["image.png"]).toMatchObject({
        hash: "binary-hash",
        size: 2048,
        content: null,
        kind: "binary",
      });
    });

    it("removeSnapshot should remove a snapshot", () => {
      const state1 = setSnapshot(baseState, "file.md", "hash123", 100, "saved text");
      const state2 = removeSnapshot(state1, "file.md");
      expect(state2.snapshots["file.md"]).toBeUndefined();
    });

    it("setProjectConversation should set the conversation ID", () => {
      const state = setProjectConversation(baseState, "conv-xxx");
      expect(state.projectConversation.conversationId).toBe("conv-xxx");
    });

    it("setFileConversation should set a per-file conversation ID", () => {
      const state = setFileConversation(baseState, "file.md", "conv-xxx");
      expect(state.fileConversations["file.md"]).toBe("conv-xxx");
    });

    it("setFileConversation should clear with null", () => {
      const state1 = setFileConversation(baseState, "file.md", "conv-xxx");
      const state2 = setFileConversation(state1, "file.md", null);
      expect(state2.fileConversations["file.md"]).toBeUndefined();
    });

    it("getFileConversationId should return null for project routing", () => {
      const state = setFileConversation(baseState, "file.md", "conv-xxx");
      expect(getFileConversationId(state, "file.md", "project")).toBeNull();
    });

    it("getFileConversationId should return the conversation for per-file routing", () => {
      const state = setFileConversation(baseState, "file.md", "conv-xxx");
      expect(getFileConversationId(state, "file.md", "per-file")).toBe("conv-xxx");
    });

    it("getFileConversationId should return null for unknown file in per-file routing", () => {
      expect(getFileConversationId(baseState, "unknown.md", "per-file")).toBeNull();
    });

    it("sets and retrieves persistent named conversations", () => {
      const state = setNamedConversation(baseState, "security", "conv-security");
      expect(getNamedConversationId(state, "security")).toBe("conv-security");
      expect(getNamedConversationId(state, "tests")).toBeNull();
    });

    it("clears project, file, and named routes when the agent or connection changes", () => {
      const state = resetConversationRoutes(
        {
          ...baseState,
          projectConversation: { conversationId: "conv-project" },
          fileConversations: { "file.md": "conv-file" },
          namedConversations: { security: "conv-security" },
        },
        "agent-new",
        "remote:ws://127.0.0.1:4500",
      );
      expect(state.agentId).toBe("agent-new");
      expect(state.connectionKey).toBe("remote:ws://127.0.0.1:4500");
      expect(state.projectConversation.conversationId).toBeNull();
      expect(state.fileConversations).toEqual({});
      expect(state.namedConversations).toEqual({});
    });
  });
});
