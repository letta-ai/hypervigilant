import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LettaAgentClient,
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
  messages: string[];
}

function fakeClient(fail = false): { client: LettaAgentClient; calls: SessionCall[] } {
  const calls: SessionCall[] = [];
  let nextConversation = 1;
  const makeSession = (call: SessionCall, conversationId: string): LettaCodeSession =>
    ({
      conversationId,
      async send(message: string) {
        call.messages.push(message);
      },
      async *stream() {
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
  const session = (kind: SessionCall["kind"], id: string, conversationId: string) => {
    const call: SessionCall = { kind, id, messages: [] };
    calls.push(call);
    return makeSession(call, conversationId);
  };
  return {
    calls,
    client: {
      createSession(agentId: string) {
        return session("create", agentId, `conv-new-${nextConversation++}`);
      },
      resumeSession(conversationId: string) {
        return session("resume", conversationId, conversationId);
      },
    } as unknown as LettaAgentClient,
  };
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

  async function writeConfig(extra = ""): Promise<string> {
    const path = join(root, "hypervigilant.toml");
    await writeFile(
      path,
      `version = 1\nproject = "scan-test"\nagent_id = "agent-test"\nmode = "review"\n${extra}`,
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

  it("sends existing text files as additions and persists their snapshots", async () => {
    await writeConfig(
      '\n[[prompt_rules]]\nname = "added"\nmatch = ["**/*.md"]\nevents = ["add"]\nprompt = "INITIAL ADD PROMPT"\n\n[[prompt_rules]]\nname = "changed"\nmatch = ["**/*.md"]\nevents = ["change"]\nprompt = "CHANGE PROMPT"\n',
    );
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
    expect(calls[0]?.messages[0]).toContain("INITIAL ADD PROMPT");
    expect(calls[0]?.messages[0]).not.toContain("CHANGE PROMPT");
    expect(statuses).toContain(
      "Scan preflight: 1/100 files. Text: 1 file, 19/65,536 bytes, estimated 5-19 tokens. Binary: 0 files, 0 bytes, metadata only.",
    );
    expect(statuses).toContain("Sending 1 existing file to the agent: README.md");
    expect(statuses).toContain("Scan complete.");

    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots["README.md"]?.content).toBe("# Existing project\n");
    expect(state?.projectConversation.conversationId).toBe("conv-new-1");
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

  it("keeps binary bytes out of the text budget and delivery messages", async () => {
    await writeConfig('\ninclude = ["**/*.png"]\nmax_scan_text_bytes = 1\n');
    await writeFile(
      join(root, "photo.png"),
      Buffer.from([0x53, 0x45, 0x43, 0x00, 0x52, 0x45, 0x54]),
    );
    const { client, calls } = fakeClient();
    const statuses: string[] = [];

    await scan(client, statuses);

    expect(statuses).toContain(
      "Scan preflight: 1/100 files. Text: 0 files, 0/1 bytes, estimated 0-0 tokens. Binary: 1 file, 7 bytes, metadata only.",
    );
    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    const snapshot = state?.snapshots["photo.png"];
    expect(snapshot).toMatchObject({ kind: "binary", content: null, size: 7 });
    expect(snapshot?.hash).toHaveLength(64);
    expect(calls[0]?.messages[0]).toContain("Binary file added: photo.png (7 bytes)");
    expect(calls[0]?.messages[0]).not.toContain(snapshot?.hash ?? "missing-hash");
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

  it("blocks aggregate file and text budgets before delivery", async () => {
    await writeConfig("\nmax_scan_files = 1\nmax_scan_text_bytes = 4\n");
    await writeFile(join(root, "a.md"), "12345");
    await writeFile(join(root, "b.md"), "67890");
    const { client, calls } = fakeClient();
    const statuses: string[] = [];

    await expect(scan(client, statuses)).rejects.toThrow(
      "2 files exceeds max_scan_files 1. 10 text bytes exceeds max_scan_text_bytes 4",
    );

    expect(calls).toHaveLength(0);
    expect(statuses).toContain(
      "Scan preflight: 2/1 files. Text: 2 files, 10/4 bytes, estimated 3-10 tokens. Binary: 0 files, 0 bytes, metadata only.",
    );
    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots).toEqual({});
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
    const statuses: string[] = [];

    await scan(client, statuses);

    expect(calls).toHaveLength(0);
    expect(statuses).toContain("No matching files found. Nothing was sent.");
    const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(state?.snapshots).toEqual({});
  });
});
