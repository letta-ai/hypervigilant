#!/usr/bin/env bun
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CanUseToolContext, CanUseToolResponse } from "@letta-ai/letta-agent-sdk";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { renderDiffPreviews } from "./approval-diff.ts";
import { resolveCloudApiKey } from "./auth.ts";
import {
  loadConfig,
  PROMPT_RULE_EVENTS,
  type PromptRuleEvent,
  resolveConfigPath,
} from "./config.ts";
import { initCommand } from "./init.ts";
import {
  getPermissionStatus,
  PERMISSION_POLICIES,
  resetPermissionPolicy,
  setPermissionPolicy,
} from "./permissions.ts";
import { formatPromptRuleSection, matchPromptRules } from "./prompts.ts";
import { StateStore } from "./state.ts";
import { statusCommand } from "./status.ts";
import { watchCommand } from "./watch.ts";
import { cleanupIsolatedWorktree, getWorktreeStatus, mergeIsolatedWorktree } from "./worktree.ts";

/* ──────────────────────────── Helpers ────────────────────────────── */

function log(message: string): void {
  console.log(`[hypervigilant] ${message}`);
}

function logError(message: string): void {
  console.error(`[hypervigilant] ERROR: ${message}`);
}

/**
 * Interactive tool approval callback for edit mode.
 * Shows the tool name, input, and diff (when available), then asks for y/n.
 */
async function interactiveApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: CanUseToolContext,
): Promise<CanUseToolResponse> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Tool: ${toolName}`);
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "(unknown)";
  console.log(`  File: ${filePath}`);

  if (context?.diffs && context.diffs.length > 0) {
    console.log("  Diff preview:");
    const rendered = renderDiffPreviews(context.diffs, process.stdout.isTTY);
    if (rendered.length > 0) {
      console.log(rendered.join("\n\n"));
    } else {
      console.log("  No renderable diff preview was provided.");
    }
  }

  console.log("─".repeat(60));

  const { default: readline } = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question("Allow this change? (y/N): ", {});
    if (answer.trim().toLowerCase().startsWith("y")) {
      return { behavior: "allow", message: "Approved" };
    }
    return { behavior: "deny", message: "Change denied by user" };
  } finally {
    rl.close();
  }
}

/** Approve a configured local client tool without printing its potentially sensitive input. */
async function interactiveClientToolApproval(toolName: string): Promise<CanUseToolResponse> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Configured client tool: ${toolName}`);
  console.log("  Tool input is hidden.");
  console.log("─".repeat(60));

  const { default: readline } = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question("Allow this tool call? (y/N): ", {});
    if (answer.trim().toLowerCase().startsWith("y")) {
      return { behavior: "allow", message: "Approved" };
    }
    return { behavior: "deny", message: "Tool call denied by user" };
  } finally {
    rl.close();
  }
}

/* ──────────────────────────── Init ───────────────────────────────── */

async function runInit(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "agent-id": { type: "string" },
      "create-agent": { type: "boolean" },
      project: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      mode: { type: "string" },
      routing: { type: "string" },
      batching: { type: "string" },
      "state-dir": { type: "string" },
      worktree: { type: "boolean" },
      "non-interactive": { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });

  const path = positionals[0];
  const projectRoot = resolve(path ?? process.cwd());

  // Validate mode
  if (values.mode && !["review", "edit"].includes(values.mode)) {
    throw new Error(`Invalid mode: ${values.mode}. Use "review" or "edit".`);
  }
  if (values.routing && !["project", "per-file"].includes(values.routing)) {
    throw new Error(`Invalid routing: ${values.routing}. Use "project" or "per-file".`);
  }
  if (values.batching && !["debounce", "fixed-window", "immediate"].includes(values.batching)) {
    throw new Error(
      `Invalid batching: ${values.batching}. Use "debounce", "fixed-window", or "immediate".`,
    );
  }

  // Create the SDK client only if setup actually creates an agent.
  const agentCreator = {
    createAgent: (options: Record<string, unknown>) =>
      createManagementClient(projectRoot).createAgent(options),
  };

  const result = await initCommand(
    {
      path,
      agentId: values["agent-id"],
      createAgent: values["create-agent"],
      project: values.project,
      include: values.include,
      exclude: values.exclude,
      mode: values.mode as "review" | "edit" | undefined,
      routing: values.routing as "project" | "per-file" | undefined,
      batching: values.batching as "debounce" | "fixed-window" | "immediate" | undefined,
      stateDir: values["state-dir"],
      worktree: values.worktree,
      nonInteractive: values["non-interactive"],
    },
    agentCreator,
  );

  log(`Configuration written to ${result.configPath}`);
  log(`Agent ID: ${result.agentId}`);
  log(`Project: ${result.config.project}`);
  log(`Mode: ${result.config.mode}`);
  log(`Routing: ${result.config.routing}`);
  log(
    `Workspace: ${result.config.worktree.enabled ? "isolated Git worktree" : "project checkout"}`,
  );
  log("Ready to watch. Run `hypervigilant watch` to start.");
}

/* ──────────────────────────── Watch ─────────────────────────────── */

async function runWatch(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const path = positionals[0];
  const projectRoot = resolve(path ?? process.cwd());
  const runtimeEnv = requireRuntimeEnv(projectRoot);
  const managementClient = createManagementClient(projectRoot);
  const client = createRuntimeClient(projectRoot);

  await watchCommand(
    {
      path,
      configPath: values.config,
      runtimeEnv,
      validateAgent: async (agentId) => {
        await managementClient.agents.retrieve(agentId);
      },
      onAssistantText: (text: string) => {
        process.stdout.write(text);
      },
      onToolApproval: interactiveApproval,
      onClientToolApproval: interactiveClientToolApproval,
      onStatus: log,
      onError: logError,
    },
    client,
  );
}

/* ─────────────────────────── Worktree ───────────────────────────── */

async function runWorktree(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !["status", "merge", "cleanup"].includes(action)) {
    throw new Error("Use `hypervigilant worktree status|merge|cleanup [path]`.");
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    options: {
      config: { type: "string" },
      discard: { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("Worktree commands accept at most one project path.");
  if (values.discard && action !== "cleanup") {
    throw new Error("--discard is only valid with `worktree cleanup`.");
  }
  const projectRoot = resolve(positionals[0] ?? process.cwd());
  const configPath = resolveConfigPath(projectRoot, values.config).path;
  const config = await loadConfig(configPath);

  if (action === "status") {
    const status = await getWorktreeStatus(projectRoot, config);
    log(`Source checkout: ${status.context.sourceRepoRoot}`);
    log(`Source branch: ${status.sourceBranch ?? "detached HEAD"}`);
    log(`Worktree: ${status.context.worktreeRepoRoot}`);
    log(`Worktree branch: ${status.context.branch}`);
    log(`Commits ahead: ${status.commitsAhead}`);
    log(`Source clean: ${status.sourceClean ? "yes" : "no"}`);
    log(`Worktree clean: ${status.worktreeClean ? "yes" : "no"}`);
    log(`Watcher active: ${status.watcherActive ? "yes" : "no"}`);
    log(`Merged into source HEAD: ${status.merged ? "yes" : "no"}`);
    if (!status.merged) log(`Merge when ready: ${status.mergeCommand}`);
    return;
  }

  if (action === "merge") {
    const result = await mergeIsolatedWorktree(projectRoot, config);
    log(
      result.alreadyMerged
        ? `${result.branch} was already merged into ${result.sourceBranch} at ${result.head}.`
        : `Merged ${result.branch} into ${result.sourceBranch} at ${result.head}.`,
    );
    log("Run `hypervigilant worktree cleanup` when you no longer need the worktree.");
    return;
  }

  const result = await cleanupIsolatedWorktree(projectRoot, config, {
    discard: values.discard,
  });
  log(
    result.discarded
      ? `Discarded ${result.branch} and removed ${result.worktreePath}.`
      : `Removed merged worktree ${result.worktreePath} and deleted ${result.branch}.`,
  );
}

/* ───────────────────────── Permissions ──────────────────────────── */

async function runPermissions(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (!["status", "review", "ask", "yolo", "reset"].includes(action)) {
    throw new Error("Use `hypervigilant permissions status|review|ask|yolo|reset [path]`.");
  }
  const { values, positionals } = parseArgs({
    args: args.slice(args.length > 0 ? 1 : 0),
    options: { config: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1)
    throw new Error("Permission commands accept at most one project path.");
  const projectRoot = resolve(positionals[0] ?? process.cwd());
  const configPath = resolveConfigPath(projectRoot, values.config).path;
  const config = await loadConfig(configPath);

  if (action === "reset") {
    await resetPermissionPolicy(projectRoot, config);
    const status = await getPermissionStatus(projectRoot, config);
    log(`Permission override removed. Effective policy: ${status.effective}.`);
    return;
  }
  if (action !== "status") {
    const policy = PERMISSION_POLICIES.find((candidate) => candidate === action);
    if (!policy) throw new Error(`Invalid permission policy: ${action}`);
    await setPermissionPolicy(projectRoot, config, policy);
  }
  const status = await getPermissionStatus(projectRoot, config);
  log(`Configured policy: ${status.configured}`);
  log(`Runtime override: ${status.override ?? "none"}`);
  log(`Effective policy: ${status.effective}`);
  if (action === "yolo") {
    log(
      config.worktree.enabled
        ? "YOLO enabled. Edit and Write inside the watched root run without prompts; changes remain isolated in the worktree."
        : "YOLO enabled. Edit and Write inside the watched root run without prompts and modify the source checkout.",
    );
    log("Local Bash, unconfigured client tools, and outside-root paths remain denied.");
  } else if (action === "ask") {
    log("Edit and Write require interactive approval.");
  } else if (action === "review") {
    log("Only Read, LS, Glob, and Grep are available.");
  }
  if (action !== "status") log("The new policy applies to the next delivered batch.");
}

/* ─────────────────────────── Prompts ────────────────────────────── */

async function runPrompts(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !["list", "test"].includes(action)) {
    throw new Error("Use `hypervigilant prompts list [project]` or `prompts test <path>`.");
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    options: {
      config: { type: "string" },
      event: { type: "string", default: "change" },
      project: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  const projectRoot = resolve(
    values.project ?? (action === "list" ? positionals[0] : undefined) ?? process.cwd(),
  );
  const config = await loadConfig(resolveConfigPath(projectRoot, values.config).path);

  if (action === "list") {
    if (positionals.length > 1) throw new Error("prompts list accepts at most one project path.");
    if (values.project && positionals.length > 0) {
      throw new Error("Select the prompts list project by positional path or --project, not both.");
    }
    if (config.promptRules.length === 0) {
      log("No canned prompt rules are configured.");
      return;
    }
    const stateDirectory = config.worktree.enabled
      ? resolve(projectRoot, config.stateDir, "worktree-state")
      : resolve(projectRoot, config.stateDir);
    const state = await new StateStore({ stateDir: stateDirectory }).load();
    for (const [index, rule] of config.promptRules.entries()) {
      const conversationId = rule.conversation
        ? state?.namedConversations?.[rule.conversation]
        : undefined;
      const conversation = rule.conversation
        ? `${rule.conversation} (persistent filesystem-read-only${conversationId ? `, ${conversationId}` : ""})`
        : "default";
      log(`${index + 1}. ${rule.name}`);
      log(`   Match: ${rule.match.join(", ")}`);
      log(`   Events: ${rule.events.join(", ")}`);
      log(`   Conversation: ${conversation}`);
    }
    return;
  }

  if (positionals.length !== 1) {
    throw new Error("prompts test requires one project-relative changed path.");
  }
  if (!PROMPT_RULE_EVENTS.includes(values.event as PromptRuleEvent)) {
    throw new Error(`--event must be one of: ${PROMPT_RULE_EVENTS.join(", ")}.`);
  }
  const rawPath = positionals[0] ?? "";
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
  const relPath = relative(projectRoot, absolutePath).replace(/\\/g, "/");
  if (!relPath || relPath === ".." || relPath.startsWith("../")) {
    throw new Error("The tested path must be inside the selected project.");
  }
  const event = values.event as PromptRuleEvent;
  const section = formatPromptRuleSection(
    matchPromptRules(config.promptRules, [{ relPath, event }]),
  );
  if (!section) {
    log(`No canned prompt rules match ${event}: ${relPath}.`);
    return;
  }
  log(`Matched canned prompts for ${event}: ${relPath}`);
  console.log(section);
}

/* ─────────────────────────── Status ─────────────────────────────── */

async function runStatus(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("Status accepts at most one project path.");
  const result = await statusCommand({ path: positionals[0], configPath: values.config });
  for (const line of result.lines) console.log(line);
}

/* ──────────────────────────── Client ────────────────────────────── */

/**
 * Read the API key for Cloud-backed local execution.
 * The Agent SDK defaults to the Letta Cloud API URL.
 */
function requireRuntimeEnv(projectRoot: string): Record<string, string> {
  return { LETTA_API_KEY: resolveCloudApiKey([projectRoot, process.cwd()]) };
}

function createManagementClient(projectRoot: string): LettaAgentClient {
  const env = requireRuntimeEnv(projectRoot);
  return new LettaAgentClient({
    backend: "cloud",
    apiKey: env.LETTA_API_KEY,
  });
}

function createRuntimeClient(projectRoot: string): LettaAgentClient {
  // Desktop can inject its internal local-server URL. Remove it so the spawned
  // App Server uses the Agent SDK's default Letta Cloud URL with the project key.
  delete process.env.LETTA_BASE_URL;
  requireRuntimeEnv(projectRoot);
  return new LettaAgentClient({
    backend: "local",
    appServer: { harnessBackend: "api", pinGlobalAgent: false },
  });
}

/* ──────────────────────────── Main ───────────────────────────────── */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const restArgs = args.slice(1);
  if (!command) {
    printHelp();
    return;
  }

  switch (command) {
    case "init":
      await runInit(restArgs);
      break;
    case "status":
      await runStatus(restArgs);
      break;
    case "watch":
      await runWatch(restArgs);
      break;
    case "worktree":
      await runWorktree(restArgs);
      break;
    case "permissions":
      await runPermissions(restArgs);
      break;
    case "prompts":
      await runPrompts(restArgs);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log("hypervigilant 0.1.0");
      break;
    default:
      if (command) {
        logError(`Unknown command: ${command}`);
      }
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
hypervigilant — Trigger persistent Letta agents from file changes.

Usage:
  hypervigilant init [path] [options]
  hypervigilant status [path] [options]
  hypervigilant watch [path] [options]
  hypervigilant worktree status|merge|cleanup [path] [options]
  hypervigilant permissions status|review|ask|yolo|reset [path] [options]
  hypervigilant prompts list|test [options]
  hypervigilant help

Commands:
  init       Create a configuration file and optionally create a Letta agent.
  status     Show a read-only overview of configuration, state, and routing.
  watch      Start watching files and delivering diffs to the agent.
  worktree   Inspect, merge, or remove the isolated worktree.
  permissions Show or change the runtime edit policy.
  prompts     List prompt rules or test a path without contacting an agent.

Init options:
  --agent-id <id>         Use an existing agent ID.
  --create-agent          Create a new agent instead of using an existing one.
  --project <name>        Project name.
  --include <glob>        Include glob. Repeat this option for more globs.
  --exclude <glob>        Exclude glob. Repeat this option for more globs.
  --mode <mode>           Agent mode: "edit" or "review". Default: edit.
  --routing <routing>     Conversations: "project" or "per-file". Default: project.
  --batching <strategy>   Batching: "debounce", "fixed-window", or "immediate".
  --state-dir <dir>       State directory. Default: .hypervigilant.
  --worktree             Create an isolated Git branch/worktree and auto-commit batches.
  --non-interactive       Skip interactive prompts and use defaults or flags.

Status options:
  --config <path>          TOML or legacy JSON config. Default: <project>/hypervigilant.toml

Watch options:
  --config <path>          TOML or legacy JSON config. Default: <project>/hypervigilant.toml

Worktree options:
  --config <path>          TOML or legacy JSON config.
  --discard                With cleanup, remove an unmerged branch and dirty worktree.

Permission policies:
  review                   Local read tools only. No file mutations.
  ask                      Prompt for every Edit or Write.
  yolo                     Auto-approve scoped Edit and Write calls.
  reset                    Remove the runtime override and use the configured mode.

Configured client tools:
  tools.auto_allow         Local client tools approved without a terminal prompt.
  tools.ask               Local client tools that prompt for every invocation.
  Managed file tools and local shell, subagent, memory, or interactive tools are rejected.

Prompt commands:
  prompts list [project]   List ordered canned prompt rules.
  prompts test <path>      Show rules matching a project-relative path.
  --event <event>          Test add, change, or delete. Default: change.
  --project <path>         Select the project for prompts test.
  Named conversations      Optional persistent filesystem-read-only routes.

Environment:
  LETTA_API_KEY            Required. Your Letta API key.

Examples:
  hypervigilant init /path/to/project --agent-id agent-xxx --non-interactive
  hypervigilant init /path/to/project --create-agent --mode edit
  hypervigilant status /path/to/project
  hypervigilant watch /path/to/project
  hypervigilant worktree status /path/to/project
  hypervigilant worktree merge /path/to/project
  hypervigilant worktree cleanup /path/to/project
  hypervigilant permissions yolo /path/to/project
  hypervigilant prompts test specs/SPEC-0004.md --event change --project /path/to/project
`);
}

main().catch((err: unknown) => {
  logError((err as Error).message);
  process.exit(1);
});
