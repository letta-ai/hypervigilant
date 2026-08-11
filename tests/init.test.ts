import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { initCommand } from "../src/init.ts";

describe("initCommand", () => {
  const root = join(import.meta.dirname, "tmp-init");

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a validated config for an existing agent", async () => {
    const result = await initCommand({
      path: root,
      agentId: "agent-existing",
      project: "docs",
      nonInteractive: true,
    });
    const source = await readFile(result.configPath, "utf8");
    const saved = await loadConfig(result.configPath);
    expect(result.configPath.endsWith("hypervigilant.toml")).toBe(true);
    expect(source).toContain('agent_id = "agent-existing"');
    expect(saved.agentId).toBe("agent-existing");
    expect(saved.connection).toEqual({ backend: "cloud" });
    expect(saved.routing).toBe("project");
    expect(saved.mode).toBe("edit");
    expect(saved.worktree.enabled).toBe(false);
    expect(saved.batching.strategy).toBe("debounce");
    expect(saved.exclude).toContain(".hypervigilant/**");
  });

  it("persists a fully local agent connection without Cloud configuration", async () => {
    const result = await initCommand({
      path: root,
      agentId: "agent-local-existing",
      connection: { backend: "local", requestTimeoutMs: 90_000 },
      project: "local-docs",
      nonInteractive: true,
    });
    expect((await loadConfig(result.configPath)).connection).toEqual({
      backend: "local",
      requestTimeoutMs: 90_000,
    });
    expect(await readFile(result.configPath, "utf8")).toContain('backend = "local"');
  });

  it("defaults a non-shared remote App Server to diff-only review", async () => {
    const result = await initCommand({
      path: root,
      agentId: "agent-local-remote",
      connection: {
        backend: "remote",
        url: "ws://127.0.0.1:4500",
        sharedFilesystem: false,
      },
      project: "remote-docs",
      nonInteractive: true,
    });
    expect(result.config.mode).toBe("review");
    expect(result.config.connection).toEqual({
      backend: "remote",
      url: "ws://127.0.0.1:4500",
      sharedFilesystem: false,
    });
  });

  it("creates a worker agent without MemFS and sanitizes its name", async () => {
    let createOptions: Record<string, unknown> | undefined;
    const result = await initCommand(
      {
        path: root,
        createAgent: true,
        project: "Docs / Review (Demo)",
        nonInteractive: true,
      },
      {
        async createAgent(options) {
          createOptions = options;
          return "agent-created";
        },
      },
    );
    expect(result.agentId).toBe("agent-created");
    expect(createOptions?.name).toBe("docs-review-demo");
    expect(createOptions?.memfs).toBe(false);
    expect(createOptions?.systemInfoReminder).toBeUndefined();
    expect(createOptions?.skillSources).toBeUndefined();
  });

  it("creates an agent when interactive setup accepts the default create choice", async () => {
    const questions: string[] = [];
    const result = await initCommand(
      { path: root },
      {
        async prompt(question, defaultValue) {
          questions.push(question);
          if (question.startsWith("Do you have")) return "n";
          if (question.startsWith("Create a new agent")) return "";
          if (question.startsWith("Project name")) return defaultValue ?? "";
          if (question.startsWith("Use edit mode")) return "";
          if (question.startsWith("Use an isolated Git worktree")) return "y";
          if (question.startsWith("Use per-file")) return "";
          throw new Error(`Unexpected prompt: ${question}`);
        },
        async createAgent() {
          return "agent-interactive";
        },
      },
    );

    expect(result.agentId).toBe("agent-interactive");
    expect(result.config.project).toBe("tmp-init");
    expect(result.config.mode).toBe("edit");
    expect(result.config.worktree.enabled).toBe(true);
    expect(questions).toContain("Project name [tmp-init]: ");
  });

  it("does not offer unsafe edit or worktree choices for a non-shared remote server", async () => {
    const questions: string[] = [];
    const result = await initCommand(
      {
        path: root,
        agentId: "agent-remote",
        project: "remote-project",
        connection: {
          backend: "remote",
          url: "ws://127.0.0.1:4500",
          sharedFilesystem: false,
        },
      },
      {
        async prompt(question) {
          questions.push(question);
          if (question.startsWith("Use per-file")) return "";
          throw new Error(`Unexpected prompt: ${question}`);
        },
      },
    );
    expect(result.config.mode).toBe("review");
    expect(result.config.worktree.enabled).toBe(false);
    expect(questions).toEqual(["Use per-file conversations? (y/N): "]);
  });

  it("rejects ambiguous agent selection", async () => {
    expect(
      initCommand({
        path: root,
        agentId: "agent-existing",
        createAgent: true,
        project: "docs",
        nonInteractive: true,
      }),
    ).rejects.toThrow("either --agent-id or --create-agent");
  });

  it("does not overwrite an existing config in non-interactive mode", async () => {
    await writeFile(join(root, "hypervigilant.json"), "{}\n");
    expect(
      initCommand({
        path: root,
        agentId: "agent-existing",
        project: "docs",
        nonInteractive: true,
      }),
    ).rejects.toThrow("already exists");
  });
});
