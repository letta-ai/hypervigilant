import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentOptions } from "@letta-ai/letta-agent-sdk";
import { createGlobMatcher, loadConfig } from "../../../src/config.ts";
import { introduceVaultChange } from "../scripts/introduce-change.ts";
import { resetSampleVault } from "../scripts/reset.ts";
import {
  autoAgentOptions,
  parseSetupArguments,
  setupObsidianWatcher,
} from "../scripts/setup.ts";

describe("Obsidian watcher demo", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hypervigilant-obsidian-watcher-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates one Letta Auto steward with a taxonomy-free config", async () => {
    let options: CreateAgentOptions | undefined;
    const result = await setupObsidianWatcher({
      vaultRoot: root,
      seedSample: true,
      async createAgent(createOptions) {
        options = createOptions;
        return "agent-auto-demo";
      },
    });

    expect(result.createdAgent).toBe(true);
    expect(result.seededSample).toBe(true);
    expect(options?.model).toBe("auto");
    expect(options?.memfs).toBe(false);
    expect(options?.description).toContain("lead steward");
    expect(options?.memory?.map((block) => block.value).join("\n")).not.toContain(
      "specialist conversations",
    );
    expect(await Bun.file(join(root, "VAULT.md")).exists()).toBe(true);
    expect(await Bun.file(join(root, "Watcher Inbox.md")).exists()).toBe(true);

    const config = await loadConfig(result.configPath);
    expect(config.mode).toBe("edit");
    expect(config.routing).toBe("project");
    expect(config.include).toEqual(["**/*.md"]);
    expect(config.promptRules).toEqual([]);
    expect(config.batching.delayMs).toBe(2500);
    expect(config.batching.maxWaitMs).toBe(10000);
    expect(config.instructions).toContain("@watcher");
    expect(config.instructions).toContain("No vault action needed.");

    const matcher = createGlobMatcher(config);
    expect(matcher.matches("Whatever/Someone Else's Layout.md")).toBe(true);
    expect(matcher.matches("Reference/archive.md")).toBe(true);
    expect(matcher.matches(".obsidian/plugins/example/readme.md")).toBe(false);
    expect(matcher.matches(".hypervigilant/private.md")).toBe(false);
    expect(matcher.matches("notes/image.png")).toBe(false);
  });

  it("introduces one evidenced handoff without rewriting source project state", async () => {
    await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-existing",
      seedSample: true,
    });
    await mkdir(join(root, ".hypervigilant"), { recursive: true });
    await writeFile(join(root, ".hypervigilant", "state.json"), "{}\n", "utf8");
    const fieldGuideBefore = await readFile(join(root, "projects", "field-guide.md"), "utf8");
    const inboxBefore = await readFile(join(root, "Watcher Inbox.md"), "utf8");

    const change = await introduceVaultChange(root, new Date("2026-08-10T12:34:56.000Z"));
    expect(change.handoffPath).toBe(join(root, "Inbox", "field-guide-release.md"));
    expect(await readFile(change.publishingLogPath, "utf8")).toContain(
      "Deployment: demo-deploy-1042",
    );
    expect(await readFile(change.publishingLogPath, "utf8")).toContain(
      "Recorded: 2026-08-10T12:34:56.000Z",
    );
    const handoff = await readFile(change.handoffPath, "utf8");
    expect(handoff).toContain("@watcher Propagate the verified publication");
    expect(handoff).toContain("Preserve this handoff as source.");
    expect(await readFile(join(root, "projects", "field-guide.md"), "utf8")).toBe(
      fieldGuideBefore,
    );
    expect(await readFile(join(root, "Watcher Inbox.md"), "utf8")).toBe(inboxBefore);
  });

  it("requires a watcher baseline before introducing the event", async () => {
    await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-existing",
      seedSample: true,
    });
    await expect(introduceVaultChange(root)).rejects.toThrow("wait for its baseline");
  });

  it("resets sample-owned files and removes the synthetic handoff", async () => {
    await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-existing",
      seedSample: true,
    });
    await mkdir(join(root, ".hypervigilant"), { recursive: true });
    await writeFile(join(root, ".hypervigilant", "state.json"), "{}\n", "utf8");
    const change = await introduceVaultChange(root);
    await writeFile(join(root, "projects", "field-guide.md"), "agent edit\n", "utf8");
    await writeFile(join(root, "Watcher Inbox.md"), "agent receipt\n", "utf8");

    await resetSampleVault(root);
    expect(await Bun.file(change.handoffPath).exists()).toBe(false);
    expect(existsSync(join(root, "Inbox"))).toBe(false);
    expect(await readFile(join(root, "projects", "field-guide.md"), "utf8")).toContain(
      "status: pending-publication",
    );
    expect(await readFile(join(root, "projects", "publishing-log.md"), "utf8")).toContain(
      "No deployment receipt exists yet.",
    );
    expect(await readFile(join(root, "Watcher Inbox.md"), "utf8")).toContain(
      "The vault steward appends one receipt here",
    );
  });

  it("uses an existing agent without creating another one", async () => {
    const result = await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-existing",
      seedSample: false,
      createAgent: async () => {
        throw new Error("should not create");
      },
    });
    expect(result.createdAgent).toBe(false);
    expect(result.agentId).toBe("agent-existing");
    expect(await readFile(result.configPath, "utf8")).toContain('agent_id = "agent-existing"');
  });

  it("preserves an existing config unless replacement is explicit", async () => {
    const first = await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-first",
      seedSample: false,
    });
    const second = await setupObsidianWatcher({ vaultRoot: root, seedSample: false });
    expect(second.agentId).toBe("agent-first");
    expect(await readFile(second.configPath, "utf8")).toBe(
      await readFile(first.configPath, "utf8"),
    );
    await expect(
      setupObsidianWatcher({
        vaultRoot: root,
        agentId: "agent-second",
        seedSample: false,
      }),
    ).rejects.toThrow("Use --force");
  });

  it("refreshes steward instructions without creating or changing the agent", async () => {
    await setupObsidianWatcher({
      vaultRoot: root,
      agentId: "agent-first",
      seedSample: false,
    });
    const result = await setupObsidianWatcher({
      vaultRoot: root,
      force: true,
      seedSample: false,
      createAgent: async () => {
        throw new Error("should not create");
      },
    });
    expect(result.agentId).toBe("agent-first");
    expect(result.createdAgent).toBe(false);
    expect((await loadConfig(result.configPath)).promptRules).toEqual([]);
  });

  it("parses setup paths and agent selection", () => {
    expect(
      parseSetupArguments(["--vault", "/tmp/notes", "--agent-id", "agent-existing", "--force"]),
    ).toEqual({ vaultRoot: "/tmp/notes", agentId: "agent-existing", force: true });
    expect(() => parseSetupArguments(["--vault"])).toThrow("--vault requires a value");
    expect(() => parseSetupArguments(["--vualt", "/tmp/notes"])).toThrow("Unknown argument");
  });

  it("uses a non-empty safe name for unusual vault paths", () => {
    expect(autoAgentOptions("/tmp/!!!").name).toBe("obsidian-watcher-demo");
  });
});
