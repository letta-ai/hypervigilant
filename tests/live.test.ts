/**
 * Opt-in live check for the actual Agent SDK local-runtime boundary.
 *
 * Required:
 *   HYPERVIGILANT_LIVE_TEST=1
 *   HYPERVIGILANT_TEST_AGENT_ID=agent-...
 *   LETTA_API_KEY=...
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractStreamTextDelta, LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const testAgentId = process.env.HYPERVIGILANT_TEST_AGENT_ID;
const isLiveTest = process.env.HYPERVIGILANT_LIVE_TEST === "1" && Boolean(testAgentId);

describe.skipIf(!isLiveTest)("live agent integration", () => {
  const fixtureRoot = join(import.meta.dirname, "tmp-live");
  const probe = `hypervigilant-local-probe-${Date.now()}`;
  let client: LettaAgentClient;
  let conversationId: string | null = null;

  beforeAll(async () => {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey || !testAgentId) {
      throw new Error("Live tests require HYPERVIGILANT_TEST_AGENT_ID and LETTA_API_KEY.");
    }
    process.env.LETTA_API_KEY = apiKey;
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "probe.md"), `fixture\n${probe}\n`, "utf8");
    client = new LettaAgentClient({
      backend: "local",
      appServer: { harnessBackend: "api", pinGlobalAgent: false },
    });
  });

  afterAll(async () => {
    if (conversationId) {
      const cleanupClient = new LettaAgentClient({
        backend: "cloud",
        apiKey: process.env.LETTA_API_KEY,
      });
      await cleanupClient.conversations.update(conversationId, { archived: true }).catch(() => {});
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reads the watched checkout through a local App Server session", async () => {
    const session = client.createSession(testAgentId as string, {
      allowedTools: ["Read"],
      toolset: { base: "none", include: ["Read"] },
      permissionMode: "standard",
      canUseTool: async (toolName) =>
        toolName === "Read"
          ? { behavior: "allow" }
          : { behavior: "deny", message: "Only Read is allowed in this test." },
      cwd: fixtureRoot,
      env: {
        LETTA_API_KEY: process.env.LETTA_API_KEY ?? "",
      },
      skillSources: [],
    });
    try {
      await session.send(
        "Use the Read tool on probe.md. Then reply with the exact file content and no other text.",
      );
      let assistantText = "";
      let toolOutput = "";
      let success = false;
      for await (const message of session.stream()) {
        if (message.type === "assistant") assistantText += message.content;
        if (message.type === "stream_event") {
          const delta = extractStreamTextDelta(message.event);
          if (delta?.kind === "assistant") assistantText += delta.text;
        }
        if (message.type === "tool_result" && !message.isError) {
          toolOutput += message.content;
        }
        if (message.type === "result") {
          conversationId = message.conversationId;
          assistantText ||= message.result ?? "";
          success = message.success;
        }
      }
      expect(success).toBe(true);
      expect(`${toolOutput}\n${assistantText}`).toContain(probe);
    } finally {
      session.close();
    }
  }, 120_000);
});
