import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HypervigilantConfig, serializeConfigToml } from "../src/config.ts";
import { type HypervigilantState, hashContent, StateStore, setSnapshot } from "../src/state.ts";
import { statusCommand } from "../src/status.ts";

function makeConfig(o: Partial<HypervigilantConfig> = {}): HypervigilantConfig {
  return {
    version: 1,
    project: "test-project",
    agentId: "agent-test-id",
    include: ["**/*.md", "**/*.txt"],
    exclude: ["**/node_modules/**", "**/.git/**", ".hypervigilant/**", "**/.hypervigilant/**"],
    maxFileSizeBytes: 1_048_576,
    maxScanFiles: 100,
    maxScanTextBytes: 65_536,
    batching: {
      strategy: "debounce",
      delayMs: 500,
      maxWaitMs: 5000,
      windowMs: 2000,
    },
    mode: "edit",
    routing: "project",
    stateDir: ".hypervigilant",
    instructions: "",
    worktree: {
      enabled: false,
      autoCommit: true,
      branchPrefix: "hypervigilant",
    },
    ...o,
    connection: o.connection ?? { backend: "cloud" },
    destinations: o.destinations ?? { agent: true },
    promptRules: o.promptRules ?? [],
    tools: o.tools ?? { autoAllow: [], ask: [] },
  };
}

const writeConfig = (root: string, c: HypervigilantConfig) =>
  writeFile(join(root, "hypervigilant.toml"), serializeConfigToml(c));
const saveState = (root: string, dir: string, s: HypervigilantState) =>
  new StateStore({ stateDir: join(root, dir) }).save(s);
const hasLine = (lines: string[], frag: string) => lines.some((l) => l.includes(frag));
const baseState = (agentId: string): HypervigilantState => ({
  version: 1,
  agentId,
  projectConversation: { conversationId: null },
  fileConversations: {},
  snapshots: {},
});

describe("status", () => {
  let testRoot: string;
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "hv-status-"));
  });
  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("shows no-state overview with all files new and project route not yet created", async () => {
    await writeFile(join(testRoot, "README.md"), "# Hello\n");
    await writeConfig(testRoot, makeConfig());
    const { lines } = await statusCommand({ path: testRoot });
    expect(hasLine(lines, "Project: test-project")).toBe(true);
    expect(hasLine(lines, "Agent: agent-test-id")).toBe(true);
    expect(hasLine(lines, "Connection: cloud")).toBe(true);
    expect(hasLine(lines, "Managed filesystem: shared")).toBe(true);
    expect(hasLine(lines, "Persisted snapshots: 0")).toBe(true);
    expect(hasLine(lines, "New: 1")).toBe(true);
    expect(hasLine(lines, "1 current file -> not yet created")).toBe(true);
    expect(hasLine(lines, "Worktree: disabled")).toBe(true);
  });

  it("classifies indexed, changed, new, and stale files with binary totals", async () => {
    await writeFile(join(testRoot, "indexed.md"), "unchanged\n");
    await writeFile(join(testRoot, "changed.md"), "modified\n");
    await writeFile(join(testRoot, "new.md"), "brand new\n");
    await writeFile(join(testRoot, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const config = makeConfig({ include: ["**/*.md", "**/*.png"] });
    await writeConfig(testRoot, config);
    let state = baseState(config.agentId ?? "agent-test-id");
    state = setSnapshot(state, "indexed.md", await hashContent("unchanged\n"), 10, "unchanged\n");
    state = setSnapshot(state, "changed.md", await hashContent("original\n"), 9, "original\n");
    state = setSnapshot(state, "stale.md", await hashContent("gone\n"), 6, "gone\n");
    await saveState(testRoot, config.stateDir, state);
    const { lines } = await statusCommand({ path: testRoot });
    expect(hasLine(lines, "Indexed: 1")).toBe(true);
    expect(hasLine(lines, "Changed: 1")).toBe(true);
    expect(hasLine(lines, "New: 2")).toBe(true);
    expect(hasLine(lines, "Stale/missing: 1")).toBe(true);
    expect(hasLine(lines, "Persisted snapshots: 3")).toBe(true);
    expect(hasLine(lines, "Text: 3 files")).toBe(true);
    expect(hasLine(lines, "Binary: 1 file")).toBe(true);
  });

  it("shows per-file and named routes, and detects agent mismatch", async () => {
    await writeFile(join(testRoot, "a.md"), "a\n");
    await writeFile(join(testRoot, "b.md"), "b\n");
    const config = makeConfig({
      routing: "per-file",
      promptRules: [
        {
          name: "security-review",
          match: ["src/auth/**"],
          events: ["add", "change"],
          prompt: "x",
          conversation: "security",
        },
        {
          name: "test-review",
          match: ["src/**"],
          events: ["change", "delete"],
          prompt: "x",
          conversation: "tests",
        },
      ],
    });
    await writeConfig(testRoot, config);
    let state: HypervigilantState = {
      ...baseState("agent-DIFFERENT"),
      fileConversations: {
        "a.md": "conv-a",
        "b.md": "conv-b",
        "gone.md": "conv-gone",
      },
      namedConversations: { security: "conv-sec-123" },
    };
    state = setSnapshot(state, "a.md", await hashContent("a\n"), 2, "a\n");
    await saveState(testRoot, config.stateDir, state);
    const { lines } = await statusCommand({ path: testRoot });
    expect(hasLine(lines, "State belongs to agent agent-DIFFERENT")).toBe(true);
    expect(hasLine(lines, "Conversation routes ignored (agent or connection mismatch).")).toBe(
      true,
    );
    expect(hasLine(lines, "Named prompt-rule routes:")).toBe(true);
    expect(hasLine(lines, "security: not yet created")).toBe(true);
    expect(hasLine(lines, "tests: not yet created")).toBe(true);
    expect(
      hasLine(lines, "File mapping depends on add/change/delete events; status is static."),
    ).toBe(true);

    state = { ...state, agentId: config.agentId };
    await saveState(testRoot, config.stateDir, state);
    const matching = await statusCommand({ path: testRoot });
    expect(hasLine(matching.lines, "Current files: 2 with route, 0 without")).toBe(true);
    expect(hasLine(matching.lines, "a.md -> conv-a")).toBe(true);
    expect(hasLine(matching.lines, "gone.md -> conv-gone")).toBe(false);
    expect(hasLine(matching.lines, "security-review: src/auth/** [add, change]")).toBe(true);
  });

  it("shows remote connection safety and ignores routes from another backend", async () => {
    await writeFile(join(testRoot, "a.md"), "a\n");
    const config = makeConfig({
      mode: "review",
      connection: {
        backend: "remote",
        url: "ws://127.0.0.1:4500",
        sharedFilesystem: false,
      },
    });
    await writeConfig(testRoot, config);
    await saveState(testRoot, config.stateDir, {
      ...baseState(config.agentId ?? "agent-test-id"),
      connectionKey: "local",
      projectConversation: { conversationId: "local-conversation" },
    });
    const { lines } = await statusCommand({ path: testRoot });
    expect(hasLine(lines, "Connection: remote (ws://127.0.0.1:4500)")).toBe(true);
    expect(hasLine(lines, "Managed filesystem: diff-only")).toBe(true);
    expect(hasLine(lines, "State belongs to connection local")).toBe(true);
    expect(hasLine(lines, "local-conversation")).toBe(false);
  });

  it("bounds output, never prints contents/hashes, does not mutate state, needs no API key", async () => {
    for (let i = 0; i < 8; i++) await writeFile(join(testRoot, `file${i}.md`), `secret-${i}\n`);
    const config = makeConfig();
    await writeConfig(testRoot, config);
    let state: HypervigilantState = {
      ...baseState(config.agentId ?? "agent-test-id"),
      projectConversation: { conversationId: "conv-orig" },
    };
    state = setSnapshot(state, "file0.md", await hashContent("secret-0\n"), 9, "secret-0\n");
    await saveState(testRoot, config.stateDir, state);
    const statePath = join(testRoot, config.stateDir, "state.json");
    const beforeStat: Stats = await stat(statePath);
    const originalKey = process.env.LETTA_API_KEY;
    delete process.env.LETTA_API_KEY;
    let result: { lines: string[] };
    try {
      result = await statusCommand({ path: testRoot });
    } finally {
      if (originalKey !== undefined) process.env.LETTA_API_KEY = originalKey;
    }
    const output = result.lines.join("\n");
    expect(hasLine(result.lines, "New: 7")).toBe(true);
    expect(hasLine(result.lines, "Indexed: 1")).toBe(true);
    const newSectionStart = result.lines.findIndex((l) => l.includes("New: 7"));
    const newExampleLines = result.lines
      .slice(newSectionStart + 1)
      .filter((l) => l.trim().startsWith("file") && l.includes(".md"));
    expect(newExampleLines.length).toBeLessThanOrEqual(5);
    expect(hasLine(result.lines, "...and 2 more")).toBe(true);
    expect(output).not.toContain("secret-");
    expect(output).not.toMatch(/[0-9a-f]{64}/);
    expect(output).not.toContain('"snapshots"');
    expect(output).not.toContain('"agentId"');
    const afterStat: Stats = await stat(statePath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("throws on corrupt state instead of treating it as empty", async () => {
    await writeFile(join(testRoot, "file.md"), "content\n");
    const config = makeConfig();
    await writeConfig(testRoot, config);
    const stateDir = join(testRoot, config.stateDir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "state.json"), "{ not valid json ");
    await expect(statusCommand({ path: testRoot })).rejects.toThrow();
  });
});
