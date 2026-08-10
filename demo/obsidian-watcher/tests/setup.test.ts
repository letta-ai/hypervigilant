import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentOptions } from "@letta-ai/letta-agent-sdk";
import {
  autoAgentOptions,
  parseSetupArguments,
  setupObsidianWatcher,
} from "../scripts/setup.ts";

const packageRoot = resolve(import.meta.dir, "..", "..", "..");

async function runPrompts(args: string[]): Promise<string> {
  const sourceCli = join(packageRoot, "src", "cli.ts");
  const command = existsSync(sourceCli)
    ? ["bun", "run", sourceCli, "prompts", ...args]
    : ["bun", join(packageRoot, "dist", "cli.js"), "prompts", ...args];
  const child = Bun.spawn(command, { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `prompts exited ${exitCode}`);
  return stdout;
}

describe("Obsidian watcher demo", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hypervigilant-obsidian-watcher-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a dedicated Letta Auto worker and a valid multi-listener config", async () => {
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
    expect(await Bun.file(join(root, "VAULT.md")).exists()).toBe(true);

    const parsed = Bun.TOML.parse(await readFile(result.configPath, "utf8"));
    expect(parsed.mode).toBe("edit");
    expect(parsed.routing).toBe("project");
    expect(parsed.include).toEqual(["**/*.md"]);
    expect(parsed.prompt_rules.map((rule: { conversation: string }) => rule.conversation)).toEqual([
      "connections",
      "claims",
      "continuity",
    ]);

    const list = await runPrompts(["list", root]);
    expect(list).toContain("connections (persistent filesystem-read-only)");
    expect(list).toContain("claims (persistent filesystem-read-only)");
    expect(list).toContain("continuity (persistent filesystem-read-only)");

    const concept = await runPrompts([
      "test",
      "concepts/shipping-is-done.md",
      "--event",
      "add",
      "--project",
      root,
    ]);
    expect(concept).toContain('Conversation: "connections"');
    expect(concept).toContain('Conversation: "claims"');
    expect(concept).not.toContain('Conversation: "continuity"');

    const capitalizedConcept = await runPrompts([
      "test",
      "Concepts/Shipping is done.md",
      "--event",
      "add",
      "--project",
      root,
    ]);
    expect(capitalizedConcept).toContain('Conversation: "claims"');

    const project = await runPrompts([
      "test",
      "projects/field-guide.md",
      "--event",
      "change",
      "--project",
      root,
    ]);
    expect(project).toContain('Conversation: "connections"');
    expect(project).toContain('Conversation: "continuity"');
    expect(project).not.toContain('Conversation: "claims"');

    const arbitrary = await runPrompts([
      "test",
      "Whatever/Someone Else's Layout.md",
      "--event",
      "change",
      "--project",
      root,
    ]);
    expect(arbitrary).toContain('Conversation: "connections"');
    expect(arbitrary).not.toContain('Conversation: "claims"');
    expect(arbitrary).not.toContain('Conversation: "continuity"');

    const capitalizedProject = await runPrompts([
      "test",
      "Projects/Field guide.md",
      "--event",
      "change",
      "--project",
      root,
    ]);
    expect(capitalizedProject).toContain('Conversation: "continuity"');
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

  it("rewrites listener rules with force without creating or changing the agent", async () => {
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
