import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CanUseToolContext,
  CanUseToolResponse,
  LettaAgentClient,
  LettaCodeClientSessionOptions,
  LettaCodeSession,
  RecoverPendingApprovalsResult,
  SDKErrorMessage,
  SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { extractStreamTextDelta } from "@letta-ai/letta-agent-sdk";
import {
  type ClientToolsConfig,
  configuredClientToolNames,
  configuredClientToolPolicy,
  LOCAL_MUTATION_TOOLS,
  LOCAL_READ_TOOLS,
  PROHIBITED_LOCAL_TOOLS,
} from "./client-tools.ts";
import type { AgentMode, ClientTools, ConversationRouting, PromptRule } from "./config.ts";
import { formatDiffMessage } from "./diff.ts";
import type { PermissionPolicy } from "./permissions.ts";
import { formatPromptRuleSection, matchPromptRules, toPromptRuleEvent } from "./prompts.ts";
import type { HypervigilantState } from "./state.ts";
import {
  getFileConversationId,
  getNamedConversationId,
  setFileConversation,
  setNamedConversation,
  setProjectConversation,
  toSafeRelPath,
} from "./state.ts";
import type { FileChange } from "./watcher.ts";

export type { HypervigilantState };

export interface AgentDeliveryOptions {
  agentId: string;
  projectName: string;
  projectRoot: string;
  instructions?: string;
  promptRules?: PromptRule[];
  clientTools?: ClientTools;
  routing: ConversationRouting;
  mode: AgentMode;
  permissionPolicy?: PermissionPolicy;
  deliveryKind?: "update" | "scan";
  protectedPaths?: string[];
  runtimeEnv: Record<string, string>;
  onAssistantText?: (text: string) => void;
  onNamedConversation?: (name: string) => void;
  onToolApproval?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: CanUseToolContext,
  ) => Promise<CanUseToolResponse>;
  onClientToolApproval?: (toolName: string) => Promise<CanUseToolResponse>;
  onAgentMutation?: (relPath: string) => void;
}

export interface DeliveryResult {
  success: boolean;
  conversationId: string | null;
  error?: string;
  errorCode?: string;
  errorDetail?: string;
  recoverable?: boolean;
  runIds?: string[];
  result?: SDKResultMessage;
}

export interface BatchDeliveryResult {
  result: DeliveryResult;
  newState: HypervigilantState;
  deliveredPaths: string[];
}

export const REVIEW_TOOLS = LOCAL_READ_TOOLS;
export const EDIT_TOOLS = [...REVIEW_TOOLS, ...LOCAL_MUTATION_TOOLS] as const;
export const READ_ONLY_TOOLS = new Set<string>(REVIEW_TOOLS);
export const MUTATING_TOOLS = new Set<string>(LOCAL_MUTATION_TOOLS);
const PROHIBITED_TOOLS = new Set<string>(PROHIBITED_LOCAL_TOOLS);
const EMPTY_CLIENT_TOOLS: ClientToolsConfig = { autoAllow: [], ask: [] };

type ApprovedMutation = {
  relPath: string;
  toolCallId?: string;
};

/** Build the client-tool policy. File guards run before the selected write policy. */
export function createApprovalCallback(
  onApproval:
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
        context?: CanUseToolContext,
      ) => Promise<CanUseToolResponse>)
    | undefined,
  onApprovedMutation: (mutation: ApprovedMutation) => void,
  projectRoot: string,
  protectedPaths: string[] = [],
  clientTools: ClientToolsConfig = EMPTY_CLIENT_TOOLS,
  onClientToolApproval?: (toolName: string) => Promise<CanUseToolResponse>,
  allowFileMutations = true,
): (
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: CanUseToolContext,
) => Promise<CanUseToolResponse> {
  return async (toolName, toolInput, context) => {
    if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow" };

    if (MUTATING_TOOLS.has(toolName)) {
      if (!allowFileMutations || !onApproval) {
        return {
          behavior: "deny",
          message: "Hypervigilant review mode does not permit local file changes.",
        };
      }

      const rawPath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
      const relPath = rawPath ? toSafeRelPath(projectRoot, rawPath) : null;
      if (!rawPath || !relPath) {
        return {
          behavior: "deny",
          message: "Hypervigilant only permits edits to files inside the watched project.",
        };
      }
      const absolutePath = resolve(projectRoot, rawPath);
      if (protectedPaths.some((path) => isPathWithin(resolve(projectRoot, path), absolutePath))) {
        return {
          behavior: "deny",
          message: "Hypervigilant control and Git metadata files cannot be modified by the agent.",
        };
      }

      const response = await onApproval(toolName, toolInput, context);
      if (response.behavior === "allow") {
        onApprovedMutation({ relPath, toolCallId: context?.toolCallId });
      }
      return response;
    }

    if (PROHIBITED_TOOLS.has(toolName)) {
      return { behavior: "deny", message: `Tool "${toolName}" is prohibited.` };
    }

    const configuredPolicy = configuredClientToolPolicy(clientTools, toolName);
    if (configuredPolicy === "auto_allow") return { behavior: "allow" };
    if (configuredPolicy === "ask") {
      if (!onClientToolApproval) {
        return {
          behavior: "deny",
          message: `Tool "${toolName}" requires interactive approval, but no callback is available.`,
        };
      }
      return onClientToolApproval(toolName);
    }

    return { behavior: "deny", message: `Tool "${toolName}" is not available.` };
  };
}

function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveConversationId(
  state: HypervigilantState,
  relPath: string | null,
  routing: ConversationRouting,
): string | null {
  if (routing === "project") return state.projectConversation.conversationId;
  return relPath ? getFileConversationId(state, relPath, routing) : null;
}

export function updateConversationState(
  state: HypervigilantState,
  relPath: string | null,
  routing: ConversationRouting,
  conversationId: string | null,
): HypervigilantState {
  if (routing === "project") return setProjectConversation(state, conversationId);
  return relPath && conversationId ? setFileConversation(state, relPath, conversationId) : state;
}

type DeliveryGroup = {
  relPath: string | null;
  conversationId: string | null;
  changes: FileChange[];
  promptRules: PromptRule[];
  namedConversation?: string;
};

function defaultDeliveryGroups(
  changes: FileChange[],
  routing: ConversationRouting,
  state: HypervigilantState,
  promptRules: PromptRule[],
): DeliveryGroup[] {
  const defaultPromptRules = promptRules.filter((rule) => !rule.conversation);
  if (routing === "project") {
    return [
      {
        relPath: null,
        conversationId: state.projectConversation.conversationId,
        changes,
        promptRules: defaultPromptRules,
      },
    ];
  }
  return changes.map((change) => ({
    relPath: change.relPath,
    conversationId: getFileConversationId(state, change.relPath, routing),
    changes: [change],
    promptRules: defaultPromptRules,
  }));
}

function namedDeliveryGroups(
  changes: FileChange[],
  state: HypervigilantState,
  promptRules: PromptRule[],
): DeliveryGroup[] {
  const rulesByConversation = new Map<string, PromptRule[]>();
  for (const rule of promptRules) {
    if (!rule.conversation) continue;
    const existing = rulesByConversation.get(rule.conversation) ?? [];
    existing.push(rule);
    rulesByConversation.set(rule.conversation, existing);
  }

  const promptChanges = changes.map((change) => ({
    relPath: change.relPath,
    event: toPromptRuleEvent(change.event),
  }));
  return [...rulesByConversation.entries()].flatMap(([name, rules]) => {
    const matches = matchPromptRules(rules, promptChanges);
    if (matches.length === 0) return [];
    const matchingPaths = new Set(
      matches.flatMap((match) => match.changes.map((change) => change.relPath)),
    );
    return [
      {
        relPath: null,
        conversationId: getNamedConversationId(state, name),
        changes: changes.filter((change) => matchingPaths.has(change.relPath)),
        promptRules: rules,
        namedConversation: name,
      },
    ];
  });
}

function deliveryGroups(
  changes: FileChange[],
  opts: AgentDeliveryOptions,
  state: HypervigilantState,
): DeliveryGroup[] {
  const promptRules = opts.promptRules ?? [];
  return [
    ...defaultDeliveryGroups(changes, opts.routing, state, promptRules),
    ...namedDeliveryGroups(changes, state, promptRules),
  ];
}

export async function deliverBatch(
  client: LettaAgentClient,
  state: HypervigilantState,
  changes: FileChange[],
  opts: AgentDeliveryOptions,
): Promise<BatchDeliveryResult> {
  if (changes.length === 0 || !formatDiffMessage(changes)) {
    return {
      result: { success: true, conversationId: null },
      newState: state,
      deliveredPaths: [],
    };
  }

  let currentState = state;
  const deliveredPaths: string[] = [];
  const groups = deliveryGroups(changes, opts, currentState);
  const pendingDeliveries = new Map<string, number>();
  for (const group of groups) {
    for (const relPath of new Set(group.changes.map((change) => change.relPath))) {
      pendingDeliveries.set(relPath, (pendingDeliveries.get(relPath) ?? 0) + 1);
    }
  }

  for (const group of groups) {
    const diffMessage = formatDiffMessage(group.changes);
    if (!diffMessage) continue;
    const groupOptions: AgentDeliveryOptions = group.namedConversation
      ? {
          ...opts,
          mode: "review",
          permissionPolicy: "review",
          promptRules: group.promptRules,
          onToolApproval: undefined,
          onAgentMutation: undefined,
        }
      : { ...opts, promptRules: group.promptRules };
    if (group.namedConversation) opts.onNamedConversation?.(group.namedConversation);
    const result = await deliverToConversation(
      client,
      groupOptions,
      group.conversationId,
      formatAgentMessage(groupOptions, diffMessage, group.changes),
    );
    if (result.conversationId) {
      currentState = group.namedConversation
        ? setNamedConversation(currentState, group.namedConversation, result.conversationId)
        : updateConversationState(currentState, group.relPath, opts.routing, result.conversationId);
    }
    if (!result.success) return { result, newState: currentState, deliveredPaths };
    for (const relPath of new Set(group.changes.map((change) => change.relPath))) {
      const remaining = (pendingDeliveries.get(relPath) ?? 1) - 1;
      pendingDeliveries.set(relPath, remaining);
      if (remaining === 0) deliveredPaths.push(relPath);
    }
  }

  return {
    result: { success: true, conversationId: null },
    newState: currentState,
    deliveredPaths,
  };
}

function formatAgentMessage(
  opts: AgentDeliveryOptions,
  diffMessage: string,
  changes: FileChange[],
): string {
  const reviewTarget =
    opts.deliveryKind === "scan" ? "these existing files" : "these saved changes";
  const instruction =
    opts.mode === "edit"
      ? opts.permissionPolicy === "yolo"
        ? `Inspect ${reviewTarget}. Use your available tools when useful. Fix clear file problems with Edit or Write. Hypervigilant has enabled scoped automatic approval for those local file tools. Do not ask for permission in prose. Summarize what you reviewed and any action you took.`
        : `Inspect ${reviewTarget}. Use your available tools when useful. Fix clear file problems with Edit or Write. Hypervigilant will request human approval for those local file tools. Do not ask for permission in prose. Summarize what you reviewed and any action you took.`
      : `Review ${reviewTarget}. Use your available tools when useful, but do not modify local files. Return concise, specific findings and state clearly when no action is needed.`;
  const clientTools = opts.clientTools ?? EMPTY_CLIENT_TOOLS;
  const clientToolLines = [
    clientTools.autoAllow.length > 0 ? `Auto-approved: ${clientTools.autoAllow.join(", ")}` : null,
    clientTools.ask.length > 0
      ? `Approval required for every call: ${clientTools.ask.join(", ")}`
      : null,
  ].filter((line): line is string => line !== null);
  const clientToolInstructions =
    clientToolLines.length > 0
      ? `\n\nConfigured local client tools:\n${clientToolLines.join("\n")}`
      : "";
  const projectInstructions = opts.instructions?.trim()
    ? `\n\nProject-specific review instructions:\n${opts.instructions.trim()}`
    : "";
  const promptRuleMatches = matchPromptRules(
    opts.promptRules ?? [],
    changes.map((change) => ({
      relPath: change.relPath,
      event: toPromptRuleEvent(change.event),
    })),
  );
  const promptRuleSection =
    formatPromptRuleSection(promptRuleMatches) ||
    ((opts.promptRules?.length ?? 0) > 0
      ? "Canned prompt rules activated for this delivery: none."
      : "");
  const cannedPrompts = promptRuleSection ? `\n\n${promptRuleSection}` : "";
  const opening =
    opts.deliveryKind === "scan"
      ? `Hypervigilant scan for project ${JSON.stringify(opts.projectName)}. Current files are shown as additions.`
      : `Hypervigilant update for project ${JSON.stringify(opts.projectName)}.`;
  return `${opening}\n\n${instruction}${clientToolInstructions}${projectInstructions}${cannedPrompts}\n\n${diffMessage}`;
}

export function hasUnresolvedApproval(recovery: RecoverPendingApprovalsResult): boolean {
  if (recovery.unsupported || recovery.pendingApproval === true) return true;
  if (recovery.pendingApproval === false) return false;
  return !recovery.recovered;
}

async function deliverToConversation(
  client: LettaAgentClient,
  opts: AgentDeliveryOptions,
  conversationId: string | null,
  message: string,
): Promise<DeliveryResult> {
  // This allowlist controls only tools executed by the local Agent SDK runtime.
  // Tools attached to the Letta agent remain available under their server-side tool rules.
  const clientTools = opts.clientTools ?? EMPTY_CLIENT_TOOLS;
  const fileTools = opts.mode === "edit" ? [...EDIT_TOOLS] : [...REVIEW_TOOLS];
  const configuredTools = configuredClientToolNames(clientTools).filter(
    (toolName) =>
      !READ_ONLY_TOOLS.has(toolName) &&
      !MUTATING_TOOLS.has(toolName) &&
      !PROHIBITED_TOOLS.has(toolName),
  );
  const allowedTools = [...new Set([...fileTools, ...configuredTools])];
  const approvedMutations = new Map<string, string>();
  const uncorrelatedMutations = new Set<string>();
  const approval = createApprovalCallback(
    opts.mode === "edit" ? opts.onToolApproval : undefined,
    (mutation) => {
      if (mutation.toolCallId) {
        approvedMutations.set(mutation.toolCallId, mutation.relPath);
      } else {
        uncorrelatedMutations.add(mutation.relPath);
      }
    },
    opts.projectRoot,
    opts.protectedPaths,
    clientTools,
    opts.onClientToolApproval,
    opts.mode === "edit",
  );

  const sessionOptions: LettaCodeClientSessionOptions = {
    allowedTools,
    toolset: { base: "none", include: allowedTools },
    permissionMode: "standard",
    canUseTool: approval,
    cwd: opts.projectRoot,
    env: opts.runtimeEnv,
    skillSources: [],
    maxApprovalRecoveryAttempts: 0,
  };

  let session: LettaCodeSession;
  try {
    session = conversationId
      ? client.resumeSession(conversationId, sessionOptions)
      : client.createSession(opts.agentId, sessionOptions);
  } catch (error) {
    return failure("session_error", `Failed to create session: ${errorMessage(error)}`);
  }

  try {
    if (conversationId) {
      const recovery = await session.recoverPendingApprovals({ timeoutMs: 5_000 });
      if (hasUnresolvedApproval(recovery)) {
        return failure(
          "pending_approval",
          recovery.detail ?? "The conversation may still have a pending approval.",
          conversationId,
        );
      }
    }

    await session.send(message);
    let resultMessage: SDKResultMessage | null = null;
    let lastError: SDKErrorMessage | null = null;
    let assistantText = "";
    let sawAssistantDelta = false;

    for await (const sdkMessage of session.stream()) {
      if (sdkMessage.type === "stream_event") {
        const delta = extractStreamTextDelta(sdkMessage.event);
        if (delta?.kind === "assistant" && delta.text) {
          sawAssistantDelta = true;
          assistantText += delta.text;
          opts.onAssistantText?.(delta.text);
        }
        continue;
      }
      if (sdkMessage.type === "assistant" && sdkMessage.content && !sawAssistantDelta) {
        assistantText += sdkMessage.content;
        opts.onAssistantText?.(sdkMessage.content);
        continue;
      }
      if (sdkMessage.type === "tool_result" && !sdkMessage.isError) {
        const relPath = approvedMutations.get(sdkMessage.toolCallId);
        if (relPath) {
          opts.onAgentMutation?.(relPath);
          approvedMutations.delete(sdkMessage.toolCallId);
        }
        continue;
      }
      if (sdkMessage.type === "error") lastError = sdkMessage;
      if (sdkMessage.type === "result") resultMessage = sdkMessage;
    }

    if (!resultMessage) return failure("no_result", "The agent stream ended without a result.");
    if (resultMessage.success) {
      for (const relPath of approvedMutations.values()) opts.onAgentMutation?.(relPath);
      for (const relPath of uncorrelatedMutations) opts.onAgentMutation?.(relPath);
      if (!assistantText && resultMessage.result) opts.onAssistantText?.(resultMessage.result);
      return {
        success: true,
        conversationId: resultMessage.conversationId,
        runIds: resultMessage.runIds,
        result: resultMessage,
      };
    }

    return {
      success: false,
      conversationId: resultMessage.conversationId,
      error:
        resultMessage.errorDetail ??
        lastError?.errorDetail ??
        resultMessage.error ??
        lastError?.message ??
        resultMessage.stopReason ??
        "The agent turn failed.",
      errorCode: resultMessage.errorCode ?? lastError?.errorCode ?? "agent_error",
      errorDetail: resultMessage.errorDetail ?? lastError?.errorDetail,
      recoverable: resultMessage.recoverable ?? lastError?.recoverable,
      runIds: resultMessage.runIds,
      result: resultMessage,
    };
  } catch (error) {
    // session.send() may have succeeded before the transport failed. Do not retry here.
    return failure(
      "delivery_error",
      `Delivery failed: ${errorMessage(error)}`,
      session.conversationId ?? conversationId,
    );
  } finally {
    session.close();
  }
}

function failure(
  errorCode: string,
  error: string,
  conversationId: string | null = null,
): DeliveryResult {
  return { success: false, conversationId, errorCode, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TurnSerializer {
  private current: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.current;
    let release = () => {};
    this.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
