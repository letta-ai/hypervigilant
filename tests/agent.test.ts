import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CanUseToolContext,
  CanUseToolResponse,
  LettaAgentClient,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import {
  createApprovalCallback,
  deliverBatch,
  EDIT_TOOLS,
  hasUnresolvedApproval,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  REVIEW_TOOLS,
  resolveConversationId,
  TurnSerializer,
  updateConversationState,
} from "../src/agent.ts";
import { PROHIBITED_LOCAL_TOOLS } from "../src/client-tools.ts";
import type { HypervigilantState } from "../src/state.ts";
import type { FileChange } from "../src/watcher.ts";

describe("agent", () => {
  const approvalRoot = join(import.meta.dirname, "tmp-agent-approval");

  beforeAll(() => mkdirSync(approvalRoot, { recursive: true }));
  afterAll(() => rmSync(approvalRoot, { recursive: true, force: true }));

  describe("tool allowlists", () => {
    it("REVIEW_TOOLS should only contain read-only tools", () => {
      expect(REVIEW_TOOLS).toEqual(["Read", "LS", "Glob", "Grep"]);
      expect(REVIEW_TOOLS).not.toContain("Bash");
      expect(REVIEW_TOOLS).not.toContain("Edit");
      expect(REVIEW_TOOLS).not.toContain("Write");
    });

    it("EDIT_TOOLS should contain read + write tools but not Bash", () => {
      expect(EDIT_TOOLS).toEqual(["Read", "LS", "Glob", "Grep", "Edit", "Write"]);
      expect(EDIT_TOOLS).not.toContain("Bash");
    });

    it("READ_ONLY_TOOLS should match REVIEW_TOOLS", () => {
      for (const tool of REVIEW_TOOLS) {
        expect(READ_ONLY_TOOLS.has(tool)).toBe(true);
      }
      expect(READ_ONLY_TOOLS.has("Edit")).toBe(false);
      expect(READ_ONLY_TOOLS.has("Write")).toBe(false);
    });

    it("MUTATING_TOOLS should only contain Edit and Write", () => {
      expect(MUTATING_TOOLS.has("Edit")).toBe(true);
      expect(MUTATING_TOOLS.has("Write")).toBe(true);
      expect(MUTATING_TOOLS.has("Bash")).toBe(false);
      expect(MUTATING_TOOLS.has("Read")).toBe(false);
    });
  });

  describe("createApprovalCallback", () => {
    it("should auto-allow read-only tools", async () => {
      const onApproval = mock((_toolName: string, _input: Record<string, unknown>) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const result = await callback("Read", { file_path: join(approvalRoot, "file.md") });
      expect(result.behavior).toBe("allow");
      expect(onApproval).not.toHaveBeenCalled();
      expect(onMutation).not.toHaveBeenCalled();
    });

    it("should require approval for Edit", async () => {
      const onApproval = mock((_toolName: string, _input: Record<string, unknown>) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const result = await callback("Edit", { file_path: join(approvalRoot, "file.md") });
      expect(result.behavior).toBe("allow");
      expect(onApproval).toHaveBeenCalledTimes(1);
      expect(onMutation).toHaveBeenCalledWith({ relPath: "file.md" });
    });

    it("should require approval for Write", async () => {
      const onApproval = mock((_toolName: string, _input: Record<string, unknown>) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const result = await callback("Write", { file_path: join(approvalRoot, "new.md") });
      expect(result.behavior).toBe("allow");
      expect(onApproval).toHaveBeenCalledTimes(1);
      expect(onMutation).toHaveBeenCalledWith({ relPath: "new.md" });
    });

    it("should not call onMutation when approval is denied", async () => {
      const onApproval = mock((_toolName: string, _input: Record<string, unknown>) =>
        Promise.resolve({
          behavior: "deny",
          message: "no",
        } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const result = await callback("Edit", { file_path: join(approvalRoot, "file.md") });
      expect(result.behavior).toBe("deny");
      expect(onMutation).not.toHaveBeenCalled();
    });

    it("should deny Bash and unknown tools", async () => {
      const onApproval = mock((_toolName: string, _input: Record<string, unknown>) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const bashResult = await callback("Bash", { command: "rm -rf /" });
      expect(bashResult.behavior).toBe("deny");

      const unknownResult = await callback("UnknownTool", {});
      expect(unknownResult.behavior).toBe("deny");
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("should auto-allow explicitly configured client tools", async () => {
      const onApproval = mock(() => Promise.resolve({ behavior: "deny" } as CanUseToolResponse));
      const onMutation = mock((_mutation: unknown) => {});
      const onClientToolApproval = mock(() =>
        Promise.resolve({ behavior: "deny" } as CanUseToolResponse),
      );
      const callback = createApprovalCallback(
        onApproval,
        onMutation,
        approvalRoot,
        [],
        { autoAllow: ["ViewImage"], ask: [] },
        onClientToolApproval,
      );

      expect((await callback("ViewImage", { query: "private query" })).behavior).toBe("allow");
      expect(onApproval).not.toHaveBeenCalled();
      expect(onClientToolApproval).not.toHaveBeenCalled();
    });

    it("should ask for configured client tools without exposing tool input", async () => {
      const onApproval = mock(() => Promise.resolve({ behavior: "deny" } as CanUseToolResponse));
      const onMutation = mock((_mutation: unknown) => {});
      const onClientToolApproval = mock((_toolName: string) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const callback = createApprovalCallback(
        onApproval,
        onMutation,
        approvalRoot,
        [],
        { autoAllow: [], ask: ["TodoWrite"] },
        onClientToolApproval,
      );

      const result = await callback("TodoWrite", {
        target: "private",
        token: "secret-that-must-not-reach-the-callback",
      });
      expect(result.behavior).toBe("allow");
      expect(onClientToolApproval.mock.calls).toEqual([["TodoWrite"]]);
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("should preserve a denial from the configured client-tool callback", async () => {
      const callback = createApprovalCallback(
        undefined,
        () => {},
        approvalRoot,
        [],
        { autoAllow: [], ask: ["TodoWrite"] },
        async () => ({ behavior: "deny", message: "No" }),
      );
      const result = await callback("TodoWrite", { secret: "hidden" });
      expect(result).toEqual({ behavior: "deny", message: "No" });
    });

    it("should deny ask tools without an interactive callback", async () => {
      const callback = createApprovalCallback(undefined, () => {}, approvalRoot, [], {
        autoAllow: [],
        ask: ["TodoWrite"],
      });
      const result = await callback("TodoWrite", { token: "secret" });
      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("requires interactive approval");
    });

    it("should deny prohibited tools even if an invalid config reaches runtime", async () => {
      const callback = createApprovalCallback(undefined, () => {}, approvalRoot, [], {
        autoAllow: [...PROHIBITED_LOCAL_TOOLS],
        ask: [],
      });
      for (const toolName of PROHIBITED_LOCAL_TOOLS) {
        expect((await callback(toolName, { secret: "hidden" })).behavior).toBe("deny");
      }
    });

    it("should deny edits outside the watched project", async () => {
      const onApproval = mock(() => Promise.resolve({ behavior: "allow" } as CanUseToolResponse));
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);
      const result = await callback("Write", {
        file_path: join(dirname(approvalRoot), "outside.md"),
      });
      expect(result.behavior).toBe("deny");
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("should deny edits to protected control paths before any policy callback", async () => {
      const onApproval = mock(() => Promise.resolve({ behavior: "allow" } as CanUseToolResponse));
      const onMutation = mock((_mutation: unknown) => {});
      const protectedState = join(approvalRoot, ".hypervigilant");
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot, [
        protectedState,
        join(approvalRoot, "hypervigilant.toml"),
        join(approvalRoot, ".git"),
      ]);

      for (const filePath of [
        join(protectedState, "permissions.json"),
        join(approvalRoot, "hypervigilant.toml"),
        join(approvalRoot, ".git", "config"),
      ]) {
        expect((await callback("Write", { file_path: filePath })).behavior).toBe("deny");
      }
      expect(onApproval).not.toHaveBeenCalled();
      expect(onMutation).not.toHaveBeenCalled();
    });

    it("should pass context to onApproval", async () => {
      const onApproval = mock(
        (_toolName: string, _input: Record<string, unknown>, _context?: CanUseToolContext) =>
          Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      const onMutation = mock((_mutation: unknown) => {});
      const callback = createApprovalCallback(onApproval, onMutation, approvalRoot);

      const context: CanUseToolContext = {
        requestId: "req-1",
        toolCallId: "tc-1",
      };
      await callback("Edit", { file_path: join(approvalRoot, "file.md") }, context);
      expect(onApproval.mock.calls[0]?.[2]).toBe(context);
    });
  });

  describe("resolveConversationId", () => {
    const state: HypervigilantState = {
      version: 1,
      agentId: "agent-xxx",
      projectConversation: { conversationId: "conv-project" },
      fileConversations: { "file.md": "conv-file" },
      snapshots: {},
    };

    it("should return project conversation for project routing", () => {
      expect(resolveConversationId(state, "file.md", "project")).toBe("conv-project");
    });

    it("should return file conversation for per-file routing", () => {
      expect(resolveConversationId(state, "file.md", "per-file")).toBe("conv-file");
    });

    it("should return null for unknown file in per-file routing", () => {
      expect(resolveConversationId(state, "unknown.md", "per-file")).toBeNull();
    });

    it("should return project conversation when relPath is null for project routing", () => {
      expect(resolveConversationId(state, null, "project")).toBe("conv-project");
    });
  });

  describe("updateConversationState", () => {
    const baseState: HypervigilantState = {
      version: 1,
      agentId: "agent-xxx",
      projectConversation: { conversationId: null },
      fileConversations: {},
      snapshots: {},
    };

    it("should update project conversation for project routing", () => {
      const newState = updateConversationState(baseState, "file.md", "project", "conv-xxx");
      expect(newState.projectConversation.conversationId).toBe("conv-xxx");
    });

    it("should update file conversation for per-file routing", () => {
      const newState = updateConversationState(baseState, "file.md", "per-file", "conv-xxx");
      expect(newState.fileConversations["file.md"]).toBe("conv-xxx");
    });

    it("should not change state for null conversation in per-file routing", () => {
      const newState = updateConversationState(baseState, "file.md", "per-file", null);
      expect(newState.fileConversations["file.md"]).toBeUndefined();
    });
  });

  describe("hasUnresolvedApproval", () => {
    it("allows a successful recovery that omits pendingApproval", () => {
      expect(hasUnresolvedApproval({ recovered: true, unsupported: false })).toBe(false);
    });

    it("blocks explicit, unsupported, and indeterminate recovery states", () => {
      expect(
        hasUnresolvedApproval({
          recovered: true,
          pendingApproval: true,
          unsupported: false,
        }),
      ).toBe(true);
      expect(hasUnresolvedApproval({ recovered: false, unsupported: true })).toBe(true);
      expect(hasUnresolvedApproval({ recovered: false, unsupported: false })).toBe(true);
    });
  });

  describe("deliverBatch", () => {
    type SessionCall = {
      kind: "create" | "resume";
      id: string;
      options: LettaCodeClientSessionOptions;
      messages: string[];
    };

    function fakeClient(
      pendingApproval: boolean | undefined = undefined,
      recovered = pendingApproval === undefined,
      unsupported = false,
      failedCallIndex: number | null = null,
      transportFailureCallIndex: number | null = null,
    ): {
      client: LettaAgentClient;
      calls: SessionCall[];
    } {
      const calls: SessionCall[] = [];
      let nextConversation = 1;
      const makeSession = (
        call: SessionCall,
        conversationId: string,
        callIndex: number,
      ): LettaCodeSession =>
        ({
          agentId: "agent-xxx",
          sessionId: "session-test",
          conversationId,
          async send(message: string) {
            call.messages.push(message);
          },
          async *stream() {
            if (callIndex === transportFailureCallIndex) {
              throw new Error("transport disconnected");
            }
            if (callIndex === failedCallIndex) {
              yield {
                type: "result",
                success: false,
                errorDetail: "named review failed",
                durationMs: 1,
                conversationId,
              } as unknown as SDKResultMessage;
              return;
            }
            yield {
              type: "result",
              success: true,
              result: "reviewed",
              durationMs: 1,
              conversationId,
            } satisfies SDKResultMessage;
          },
          async recoverPendingApprovals() {
            return {
              recovered,
              pendingApproval,
              unsupported,
            };
          },
          close() {},
        }) as unknown as LettaCodeSession;

      const client = {
        createSession(id: string, options: LettaCodeClientSessionOptions) {
          const callIndex = calls.length;
          const call: SessionCall = { kind: "create", id, options, messages: [] };
          calls.push(call);
          return makeSession(call, `conv-new-${nextConversation++}`, callIndex);
        },
        resumeSession(id: string, options: LettaCodeClientSessionOptions) {
          const callIndex = calls.length;
          const call: SessionCall = { kind: "resume", id, options, messages: [] };
          calls.push(call);
          return makeSession(call, id, callIndex);
        },
      } as unknown as LettaAgentClient;
      return { client, calls };
    }

    function change(relPath: string): FileChange {
      return {
        relPath,
        absPath: `/project/${relPath}`,
        event: "change",
        oldContent: "old",
        newContent: "new",
        hash: "new-hash",
        size: 3,
      };
    }

    const options = {
      agentId: "agent-xxx",
      projectName: "test-project",
      projectRoot: "/project",
      routing: "project" as const,
      mode: "review" as const,
      runtimeEnv: {
        LETTA_API_KEY: "test-key",
      },
    };

    it("creates one project conversation with local read-only session options", async () => {
      const { client, calls } = fakeClient();
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md"), change("b.md")],
        { ...options, instructions: "Compare changes with SPEC.md." },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.kind).toBe("create");
      expect(calls[0]?.options.cwd).toBe("/project");
      expect(calls[0]?.options.allowedTools).toEqual([...REVIEW_TOOLS]);
      expect(calls[0]?.options.toolset).toEqual({
        base: "none",
        include: [...REVIEW_TOOLS],
      });
      expect(calls[0]?.options.env).toEqual(options.runtimeEnv);
      expect(calls[0]?.messages[0]).toContain("a.md");
      expect(calls[0]?.messages[0]).toContain("b.md");
      expect(calls[0]?.messages[0]).toContain("Compare changes with SPEC.md.");
      expect(calls[0]?.messages[0]).not.toContain(
        "Canned prompt rules activated for this delivery:",
      );
      expect(calls[0]?.messages[0]).not.toContain("Configured local client tools:");
      expect(delivery.newState.projectConversation.conversationId).toBe("conv-new-1");
      expect(delivery.deliveredPaths).toEqual(["a.md", "b.md"]);
    });

    it("adds configured client tools and preserves their approval policies", async () => {
      const { client, calls } = fakeClient();
      const onClientToolApproval = mock((_toolName: string) =>
        Promise.resolve({ behavior: "allow" } as CanUseToolResponse),
      );
      await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md")],
        {
          ...options,
          clientTools: {
            autoAllow: ["ViewImage"],
            ask: ["TodoWrite"],
          },
          onClientToolApproval,
        },
      );

      const sessionOptions = calls[0]?.options;
      expect(sessionOptions?.allowedTools).toEqual([...REVIEW_TOOLS, "ViewImage", "TodoWrite"]);
      expect(sessionOptions?.toolset).toEqual({
        base: "none",
        include: [...REVIEW_TOOLS, "ViewImage", "TodoWrite"],
      });
      expect(
        (await sessionOptions?.canUseTool?.("ViewImage", { secret: "hidden" }))?.behavior,
      ).toBe("allow");
      expect(
        (await sessionOptions?.canUseTool?.("TodoWrite", { secret: "hidden" }))?.behavior,
      ).toBe("allow");
      expect(onClientToolApproval.mock.calls).toEqual([["TodoWrite"]]);
      expect(
        (await sessionOptions?.canUseTool?.("Edit", { file_path: "/project/a.md" }))?.behavior,
      ).toBe("deny");
      const message = calls[0]?.messages[0] ?? "";
      expect(message).toContain("Configured local client tools:");
      expect(message).toContain("Auto-approved: ViewImage");
      expect(message).toContain("Approval required for every call: TodoWrite");
    });

    it("filters reserved and prohibited tools if invalid runtime options bypass config validation", async () => {
      const { client, calls } = fakeClient();
      await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md")],
        {
          ...options,
          clientTools: {
            autoAllow: ["Read", "Edit", "Bash", "ViewImage"],
            ask: [],
          },
        },
      );

      expect(calls[0]?.options.allowedTools).toEqual([...REVIEW_TOOLS, "ViewImage"]);
      expect(calls[0]?.options.toolset).toEqual({
        base: "none",
        include: [...REVIEW_TOOLS, "ViewImage"],
      });
    });

    it("places ordered matching canned prompts between global instructions and diffs", async () => {
      const { client, calls } = fakeClient();
      await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("specs/SPEC.md"), change("specs/notes.md"), change("src/app.ts")],
        {
          ...options,
          instructions: "Global instruction.",
          promptRules: [
            {
              name: "spec-change",
              match: ["specs/**"],
              events: ["change"],
              prompt: "Apply the changed specification.",
            },
            {
              name: "source-review",
              match: ["src/**/*.ts"],
              events: ["change"],
              prompt: "Check source against the contract.",
            },
          ],
        },
      );

      const message = calls[0]?.messages[0] ?? "";
      expect(calls[0]?.options.allowedTools).toEqual([...REVIEW_TOOLS]);
      expect(
        (await calls[0]?.options.canUseTool?.("Edit", { file_path: "/project/file.ts" }))?.behavior,
      ).toBe("deny");
      expect(message.match(/Rule "spec-change"/g)).toHaveLength(1);
      expect(message).toContain("change: specs/SPEC.md, change: specs/notes.md");
      expect(message.indexOf("Global instruction.")).toBeLessThan(
        message.indexOf("Canned prompt rules activated for this delivery:"),
      );
      expect(message.indexOf('Rule "spec-change"')).toBeLessThan(
        message.indexOf('Rule "source-review"'),
      );
      expect(message.indexOf('Rule "source-review"')).toBeLessThan(
        message.indexOf("The following 3 files changed"),
      );
    });

    it("states when configured canned prompts do not match the current delivery", async () => {
      const { client, calls } = fakeClient();
      await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("README.md")],
        {
          ...options,
          promptRules: [
            {
              name: "source-only",
              match: ["src/**"],
              events: ["change"],
              prompt: "Source prompt.",
            },
          ],
        },
      );

      expect(calls[0]?.messages[0]).toContain(
        "Canned prompt rules activated for this delivery: none.",
      );
      expect(calls[0]?.messages[0]).not.toContain("Source prompt.");
    });

    it("creates one distinct conversation for each new file", async () => {
      const { client, calls } = fakeClient();
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md"), change("b.md")],
        { ...options, routing: "per-file" },
      );

      expect(calls.map((call) => call.kind)).toEqual(["create", "create"]);
      expect(calls[0]?.messages[0]).toContain("a.md");
      expect(calls[0]?.messages[0]).not.toContain("b.md");
      expect(calls[1]?.messages[0]).toContain("b.md");
      expect(delivery.newState.fileConversations).toEqual({
        "a.md": "conv-new-1",
        "b.md": "conv-new-2",
      });
    });

    it("matches canned prompts independently for per-file routing", async () => {
      const { client, calls } = fakeClient();
      await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("SPEC.md"), change("src/app.ts")],
        {
          ...options,
          routing: "per-file",
          promptRules: [
            {
              name: "spec",
              match: ["SPEC.md"],
              events: ["change"],
              prompt: "Spec prompt.",
            },
            {
              name: "source",
              match: ["src/**"],
              events: ["change"],
              prompt: "Source prompt.",
            },
          ],
        },
      );

      expect(calls[0]?.messages[0]).toContain("Spec prompt.");
      expect(calls[0]?.messages[0]).not.toContain("Source prompt.");
      expect(calls[1]?.messages[0]).toContain("Source prompt.");
      expect(calls[1]?.messages[0]).not.toContain("Spec prompt.");
    });

    it("dispatches one change to several persistent filesystem-read-only conversations", async () => {
      const { client, calls } = fakeClient();
      const interactiveApproval = mock(async () => ({ behavior: "allow" as const }));
      const clientToolApproval = mock(async (_toolName: string) => ({
        behavior: "allow" as const,
      }));
      const namedRoutes: string[] = [];
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("src/auth/login.ts")],
        {
          ...options,
          mode: "edit",
          permissionPolicy: "yolo",
          onToolApproval: interactiveApproval,
          onClientToolApproval: clientToolApproval,
          clientTools: { autoAllow: ["ViewImage"], ask: ["TodoWrite"] },
          onNamedConversation: (name) => namedRoutes.push(name),
          promptRules: [
            {
              name: "default-source",
              match: ["src/**"],
              events: ["change"],
              prompt: "Primary implementation prompt.",
            },
            {
              name: "security-review",
              match: ["src/auth/**"],
              events: ["change"],
              prompt: "Review authentication boundaries.",
              conversation: "security",
            },
            {
              name: "test-review",
              match: ["src/**"],
              events: ["change"],
              prompt: "Review test coverage.",
              conversation: "tests",
            },
          ],
        },
      );

      expect(calls).toHaveLength(3);
      expect(calls[0]?.options.allowedTools).toEqual([...EDIT_TOOLS, "ViewImage", "TodoWrite"]);
      expect(calls[0]?.messages[0]).toContain("Primary implementation prompt.");
      expect(calls[0]?.messages[0]).not.toContain("Review authentication boundaries.");
      expect(calls[1]?.options.allowedTools).toEqual([...REVIEW_TOOLS, "ViewImage", "TodoWrite"]);
      expect(
        (
          await calls[1]?.options.canUseTool?.("Edit", {
            file_path: join(approvalRoot, "src", "auth", "login.ts"),
          })
        )?.behavior,
      ).toBe("deny");
      expect(calls[1]?.messages[0]).toContain('Conversation: "security" (filesystem read-only)');
      expect(calls[1]?.messages[0]).toContain("Review authentication boundaries.");
      expect(calls[1]?.messages[0]).not.toContain("Primary implementation prompt.");
      expect(calls[2]?.options.allowedTools).toEqual([...REVIEW_TOOLS, "ViewImage", "TodoWrite"]);
      expect(calls[2]?.messages[0]).toContain('Conversation: "tests" (filesystem read-only)');
      expect(delivery.newState.namedConversations).toEqual({
        security: "conv-new-2",
        tests: "conv-new-3",
      });
      expect(delivery.deliveredPaths).toEqual(["src/auth/login.ts"]);
      expect(namedRoutes).toEqual(["security", "tests"]);
      expect((await calls[1]?.options.canUseTool?.("ViewImage", { query: "auth" }))?.behavior).toBe(
        "allow",
      );
      expect(
        (await calls[1]?.options.canUseTool?.("TodoWrite", { secret: "hidden" }))?.behavior,
      ).toBe("allow");
      expect(clientToolApproval.mock.calls).toEqual([["TodoWrite"]]);
      expect(interactiveApproval).not.toHaveBeenCalled();
    });

    it("combines rules sharing one named conversation and resumes its stored ID", async () => {
      const { client, calls } = fakeClient();
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: "conv-project" },
          fileConversations: {},
          namedConversations: { quality: "conv-quality" },
          snapshots: {},
        },
        [change("src/app.ts"), change("tests/app.test.ts")],
        {
          ...options,
          promptRules: [
            {
              name: "source-quality",
              match: ["src/**"],
              events: ["change"],
              prompt: "Review source quality.",
              conversation: "quality",
            },
            {
              name: "test-quality",
              match: ["tests/**"],
              events: ["change"],
              prompt: "Review test quality.",
              conversation: "quality",
            },
          ],
        },
      );

      expect(calls).toHaveLength(2);
      expect(calls[0]?.kind).toBe("resume");
      expect(calls[0]?.id).toBe("conv-project");
      expect(calls[1]?.kind).toBe("resume");
      expect(calls[1]?.id).toBe("conv-quality");
      const namedMessage = calls[1]?.messages[0] ?? "";
      expect(namedMessage.indexOf("Review source quality.")).toBeLessThan(
        namedMessage.indexOf("Review test quality."),
      );
      expect(namedMessage).toContain("src/app.ts");
      expect(namedMessage).toContain("tests/app.test.ts");
      expect(delivery.deliveredPaths).toEqual(["src/app.ts", "tests/app.test.ts"]);
    });

    it("does not mark a path delivered until all matching named conversations succeed", async () => {
      const { client } = fakeClient(undefined, true, false, 1);
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("src/auth.ts"), change("README.md")],
        {
          ...options,
          promptRules: [
            {
              name: "security",
              match: ["src/**"],
              events: ["change"],
              prompt: "Review security.",
              conversation: "security",
            },
          ],
        },
      );

      expect(delivery.result.success).toBe(false);
      expect(delivery.deliveredPaths).toEqual(["README.md"]);
      expect(delivery.newState.namedConversations).toEqual({ security: "conv-new-2" });
    });

    it("preserves a new named conversation ID after a transport failure", async () => {
      const { client } = fakeClient(undefined, true, false, null, 1);
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [change("src/auth.ts"), change("README.md")],
        {
          ...options,
          promptRules: [
            {
              name: "security",
              match: ["src/**"],
              events: ["change"],
              prompt: "Review security.",
              conversation: "security",
            },
          ],
        },
      );

      expect(delivery.result.success).toBe(false);
      expect(delivery.result.errorCode).toBe("delivery_error");
      expect(delivery.deliveredPaths).toEqual(["README.md"]);
      expect(delivery.newState.namedConversations).toEqual({ security: "conv-new-2" });
    });

    it("skips an empty per-file diff when another file changed", async () => {
      const { client, calls } = fakeClient();
      const unchanged = { ...change("same.md"), newContent: "old" };
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: null },
          fileConversations: {},
          snapshots: {},
        },
        [unchanged, change("changed.md")],
        { ...options, routing: "per-file" },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.messages[0]).toContain("changed.md");
      expect(calls[0]?.messages[0]).not.toContain("same.md");
      expect(delivery.deliveredPaths).toEqual(["changed.md"]);
    });

    it("continues a resumed conversation after successful recovery with no pending field", async () => {
      const { client, calls } = fakeClient();
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: "conv-existing" },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md")],
        options,
      );

      expect(calls[0]?.kind).toBe("resume");
      expect(calls[0]?.messages).toHaveLength(1);
      expect(delivery.result.success).toBe(true);
      expect(delivery.deliveredPaths).toEqual(["a.md"]);
    });

    it("does not send into a resumed conversation with an unresolved approval", async () => {
      const { client, calls } = fakeClient(true);
      const delivery = await deliverBatch(
        client,
        {
          version: 1,
          agentId: "agent-xxx",
          projectConversation: { conversationId: "conv-existing" },
          fileConversations: {},
          snapshots: {},
        },
        [change("a.md")],
        options,
      );

      expect(calls[0]?.kind).toBe("resume");
      expect(calls[0]?.messages).toEqual([]);
      expect(delivery.result.success).toBe(false);
      expect(delivery.result.errorCode).toBe("pending_approval");
    });
  });

  describe("TurnSerializer", () => {
    it("should serialize async operations", async () => {
      const serializer = new TurnSerializer();
      const order: number[] = [];

      const p1 = serializer.run(async () => {
        await sleep(20);
        order.push(1);
      });

      const p2 = serializer.run(async () => {
        order.push(2);
      });

      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
    });

    it("should propagate return values", async () => {
      const serializer = new TurnSerializer();
      const result = await serializer.run(async () => 42);
      expect(result).toBe(42);
    });

    it("should propagate errors", async () => {
      const serializer = new TurnSerializer();
      expect(
        serializer.run(async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
