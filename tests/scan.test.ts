import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LettaAgentClient,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { loadConfig } from "../src/config.ts";
import { StateStore, setProjectConversation, setSnapshot } from "../src/state.ts";
import { establishBaseline, scanCommand } from "../src/watch.ts";
import { cleanupIsolatedWorktree, getWorktreeStatus } from "../src/worktree.ts";

interface SessionCall {
  kind: "create" | "resume";
  id: string;
  options: LettaCodeClientSessionOptions;
  messages: string[];
}

function fakeClient(
  fail = false,
  mutation?: { filePath: string; content: string },
): { client: LettaAgentClient; calls: SessionCall[] } {
  const calls: SessionCall[] = [];
  let nextConversation = 1;
  const makeSession = (call: SessionCall, conversationId: string): LettaCodeSession =>
    ({
      agentId: "agent-test",
      sessionId: "session-test",
      conversationId,
      async send(message: string) {
        call.messages.push(message);
      },
      async *stream() {
        if (mutation) {
          const approval = await call.options.canUseTool?.(
            "Write",
            { file_path: mutation.filePath, content: mutation.content },
            { requestId: "request-1", toolCallId: "tool-1" },
          );
          if (approval?.behavior !== "allow") throw new Error("Test mutation was not approved.");
          await writeFile(mutation.filePath, mutation.content);
          yield {
            type: "tool_result",
            toolCallId: "tool-1",
            content: "wrote file",
            isError: false,
          };
        }
        yield {
          type: "result",
          success: !fail,
          result: fail ? undefined : "reviewed",
          errorDetail: fail ? "scan failed" : undefined,
          durationMs: 1,
          conversationId,
        } as SDKResultMessage;
      },
      async recoverPendingApprovals() {
        return { recovered: true, unsupported: false };
      },
      close() {},
    }) as unknown as LettaCodeSession;
  const client = {
    createSession(agentId: string, options: LettaCodeClientSessionOptions) {
      const conversationId = `conv-new-${nextConversation++}`;
      const call: SessionCall = { kind: "create", id: agentId, options, messages: [] };
      calls.push(call);
      return makeSession(call, conversationId);
    },
    resumeSession(conversationId: string, options: LettaCodeClientSessionOptions) {
      const call: SessionCall = {
        kind: "resume",
        id: conversationId,
        options,
        messages: [],
      };
      calls.push(call);
      return makeSession(call, conversationId);
    },
  } as unknown as LettaAgentClient;
  return { client, calls };
}

async function run(cwd: string, command: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  }
}

describe("scan command", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hypervigilant-scan-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(extra = "", mode: "review" | "edit" = "review"): Promise<string> {
    const path = join(root, "hypervigilant.toml");
    await writeFile(
      path,
      `version = 1\nproject = "scan-test"\nagent_id = "agent-test"\nmode = "${mode}"\n${extra}`,
    );
    return path;
  }

  async function scan(client: LettaAgentClient, statuses: string[] = []): Promise<void> {
    await scanCommand(
      {
        path: root,
        runtimeEnv: { LETTA_API_KEY: "test-key" },
        validateAgent: async () => {},
        onStatus: (message) => statuses.push(message),
      },
      client,
    );
  }

  it("sends existing text files once and persists their snapshots", async () => {
    await writeConfig();
    await writeFile(join(root, "README.md"), "# Existing project\n");
    const { client, calls } = fakeClient();
    const statuses: string[] = [];

    await scan(client, statuses);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("create");
    expect(calls[0]?.messages[0]).toContain('Hypervigilant scan for project "scan-test"');
    expect(calls[0]?.messages[0]).toContain("Review these existing files.");
    expect(calls[0]?.messages[0]).toContain("b/README.md");
    expect(calls[0]?.messages[0]).toContain("# Existing project");
    expect(statuses).toContain("Sending 1 existing file to the agent: README.md");
    expect(statuses).toContain("Scan complete.");

    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots["README.md"]?.content).toBe("# Existing project\n");
    expect(state?.projectConversation.conversationId).toBe("conv-new-1");
  });

  it("persists the final state of an agent-edited scanned file", async () => {
    await writeConfig("", "edit");
    const filePath = join(root, "README.md");
    await writeFile(filePath, "before agent\n");
    const { client } = fakeClient(false, { filePath, content: "after agent\n" });

    await scanCommand(
      {
        path: root,
        runtimeEnv: { LETTA_API_KEY: "test-key" },
        onToolApproval: async () => ({ behavior: "allow" }),
      },
      client,
    );

    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots["README.md"]?.content).toBe("after agent\n");
    expect(await readFile(filePath, "utf8")).toBe("after agent\n");
  });

  it("resends files from an existing baseline and resumes the route", async () => {
    const configPath = await writeConfig();
    await writeFile(join(root, "README.md"), "already baselined\n");
    const config = await loadConfig(configPath);
    const store = new StateStore({ stateDir: join(root, config.stateDir) });
    const baseline = setSnapshot(
      setProjectConversation(await establishBaseline(root, config), "conv-existing"),
      "removed.md",
      "old-hash",
      3,
      "old",
    );
    await store.save(baseline);
    const { client, calls } = fakeClient();

    await scan(client);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("resume");
    expect(calls[0]?.id).toBe("conv-existing");
    expect(calls[0]?.messages[0]).toContain("already baselined");
    const scannedState = await new StateStore({ stateDir: join(root, config.stateDir) }).load();
    expect(scannedState?.snapshots["removed.md"]).toBeUndefined();
  });

  it("treats scanned files as additions for prompt rules", async () => {
    await writeConfig(
      '\n[[prompt_rules]]\nname = "added"\nmatch = ["**/*.md"]\nevents = ["add"]\nprompt = "INITIAL ADD PROMPT"\n\n[[prompt_rules]]\nname = "changed"\nmatch = ["**/*.md"]\nevents = ["change"]\nprompt = "CHANGE PROMPT"\n',
    );
    await writeFile(join(root, "README.md"), "prompt target\n");
    const { client, calls } = fakeClient();

    await scan(client);

    expect(calls[0]?.messages[0]).toContain("INITIAL ADD PROMPT");
    expect(calls[0]?.messages[0]).not.toContain("CHANGE PROMPT");
  });

  it("keeps binary bytes and hashes out of delivery messages", async () => {
    await writeConfig('\ninclude = ["**/*.png"]\n');
    await writeFile(
      join(root, "photo.png"),
      Buffer.from([0x53, 0x45, 0x43, 0x00, 0x52, 0x45, 0x54]),
    );
    const { client, calls } = fakeClient();

    await scan(client);

    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    const snapshot = state?.snapshots["photo.png"];
    expect(snapshot).toMatchObject({ kind: "binary", content: null, size: 7 });
    expect(snapshot?.hash).toHaveLength(64);
    expect(calls[0]?.messages[0]).toContain("Binary file added: photo.png (7 bytes)");
    expect(calls[0]?.messages[0]).not.toContain(snapshot?.hash ?? "missing-hash");
    expect(await readFile(join(root, "photo.png"))).toEqual(
      Buffer.from([0x53, 0x45, 0x43, 0x00, 0x52, 0x45, 0x54]),
    );
  });

  it("enforces exclusions, size limits, and symbolic-link rejection", async () => {
    await writeConfig(
      '\ninclude = ["**/*.md"]\nexclude = ["private/**", ".hypervigilant/**"]\nmax_file_size_bytes = 20\n',
    );
    await writeFile(join(root, "kept.md"), "kept\n");
    await writeFile(join(root, "large.md"), "x".repeat(21));
    await writeFile(join(root, "target.txt"), "outside include\n");
    await symlink("target.txt", join(root, "linked.md"));
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private", "secret.md"), "secret\n");
    const { client, calls } = fakeClient();

    await scan(client);

    const message = calls[0]?.messages[0] ?? "";
    expect(message).toContain("kept.md");
    expect(message).not.toContain("large.md");
    expect(message).not.toContain("linked.md");
    expect(message).not.toContain("secret.md");
  });

  it("scans an isolated worktree and releases its process lock", async () => {
    await writeFile(join(root, ".gitignore"), ".hypervigilant/\nhypervigilant.toml\n");
    await writeFile(join(root, "README.md"), "worktree input\n");
    await run(root, ["git", "init", "-b", "main"]);
    await run(root, ["git", "config", "user.name", "Hypervigilant Test"]);
    await run(root, ["git", "config", "user.email", "hypervigilant@example.com"]);
    await run(root, ["git", "add", "."]);
    await run(root, ["git", "commit", "-m", "initial"]);
    const configPath = await writeConfig(
      '\n[worktree]\nenabled = true\nauto_commit = true\nbranch_prefix = "hv/scans"\n',
    );
    const config = await loadConfig(configPath);
    const { client, calls } = fakeClient();

    await scan(client);

    expect(calls[0]?.messages[0]).toContain("worktree input");
    const status = await getWorktreeStatus(root, config);
    expect(status.watcherActive).toBe(false);
    expect(status.merged).toBe(true);
    await cleanupIsolatedWorktree(root, config);
  });

  it("does not advance a failed scan", async () => {
    await writeConfig();
    await writeFile(join(root, "README.md"), "not delivered\n");
    const { client } = fakeClient(true);

    await expect(scan(client)).rejects.toThrow("Delivery stopped");

    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots).toEqual({});
    expect(state?.projectConversation.conversationId).toBe("conv-new-1");
  });

  it("removes stale matching snapshots when no files remain", async () => {
    const configPath = await writeConfig();
    const config = await loadConfig(configPath);
    const store = new StateStore({ stateDir: join(root, ".hypervigilant") });
    const baseline = await establishBaseline(root, config);
    await store.save(setSnapshot(baseline, "removed.md", "old-hash", 3, "old"));
    const { client, calls } = fakeClient();

    await scan(client);

    expect(calls).toHaveLength(0);
    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots).toEqual({});
  });

  it("creates empty state and exits when no files match", async () => {
    await writeConfig();
    const { client, calls } = fakeClient();
    const statuses: string[] = [];

    await scan(client, statuses);

    expect(calls).toHaveLength(0);
    expect(statuses).toContain("No matching files found. Nothing was sent.");
    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots).toEqual({});
  });
});
