import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CONFIG_FILENAME,
  configSchema,
  type HypervigilantConfig,
  resolveConfigPath,
  serializeConfigToml,
} from "./config.ts";
import { atomicWriteFile } from "./state.ts";

/* ──────────────────────────── Types ─────────────────────────────── */

export interface InitOptions {
  /** Project path (defaults to cwd). */
  path?: string;
  /** Agent ID to use (skip agent creation). */
  agentId?: string;
  /** Create a new agent instead of using an existing one. */
  createAgent?: boolean;
  /** Project name. */
  project?: string;
  /** Include globs. */
  include?: string[];
  /** Exclude globs. */
  exclude?: string[];
  /** Mode: review or edit. */
  mode?: "review" | "edit";
  /** Routing: project or per-file. */
  routing?: "project" | "per-file";
  /** Batching strategy. */
  batching?: "debounce" | "fixed-window" | "immediate";
  /** State directory. */
  stateDir?: string;
  /** Create and watch an isolated Git worktree. */
  worktree?: boolean;
  /** Non-interactive mode (use flags only). */
  nonInteractive?: boolean;
}

export interface InitResult {
  configPath: string;
  config: HypervigilantConfig;
  agentId: string;
}

export interface InitDependencies {
  createAgent?: (options: Record<string, unknown>) => Promise<string>;
  prompt?: (question: string, defaultValue?: string) => Promise<string>;
}

/* ──────────────────── Interactive helpers ───────────────────────── */

/** Minimal interactive prompt for when Bun's readline is available. */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const { default: readline } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question, {});
    return answer.trim() || (defaultValue ?? "");
  } finally {
    rl.close();
  }
}

async function promptYesNo(
  question: string,
  defaultValue: boolean,
  ask: (question: string, defaultValue?: string) => Promise<string> = prompt,
): Promise<boolean> {
  const answer = await ask(`${question} (${defaultValue ? "Y/n" : "y/N"}): `);
  if (answer === "") return defaultValue;
  return answer.toLowerCase().startsWith("y");
}

/* ────────────────────────── Init command ────────────────────────── */

function safeAgentName(projectName: string): string {
  const normalized = projectName
    .toLowerCase()
    .replace(/[()/\\]/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "hypervigilant-agent";
}

/**
 * Run the init command.
 * Creates a configuration file and optionally creates a Letta agent.
 */
export async function initCommand(
  opts: InitOptions,
  dependencies: InitDependencies = {},
): Promise<InitResult> {
  const projectRoot = resolve(opts.path ?? process.cwd());
  const ask = dependencies.prompt ?? prompt;
  if (opts.agentId && opts.createAgent) {
    throw new Error("Use either --agent-id or --create-agent, not both.");
  }

  // Check for either the primary TOML config or a legacy JSON config.
  const configPath = join(projectRoot, CONFIG_FILENAME);
  const existingConfigPath = resolveConfigPath(projectRoot).path;
  if (existsSync(existingConfigPath)) {
    if (opts.nonInteractive) {
      throw new Error(`Config file already exists at ${existingConfigPath}.`);
    }
    const overwrite = await promptYesNo(
      `Config file already exists at ${existingConfigPath}. Write ${configPath}?`,
      false,
      ask,
    );
    if (!overwrite) throw new Error("Init cancelled.");
  }

  // Gather configuration
  let agentId = opts.agentId ?? "";
  let createAgent = opts.createAgent ?? false;
  let projectName = opts.project ?? "";
  const include = opts.include;
  const exclude = opts.exclude;
  let mode = opts.mode;
  let routing = opts.routing;
  const batching = opts.batching;
  const stateDir = opts.stateDir;
  let worktreeEnabled = opts.worktree;

  if (!opts.nonInteractive) {
    // Interactive prompts
    if (!agentId && !createAgent) {
      const useExisting = await promptYesNo("Do you have an existing agent ID?", true, ask);
      if (useExisting) {
        agentId = await ask("Enter agent ID (agent-xxx): ");
        if (!agentId) {
          throw new Error("Agent ID is required.");
        }
      } else {
        createAgent = await promptYesNo("Create a new agent?", true, ask);
        if (!createAgent) {
          throw new Error("Either an existing agent ID or agent creation is required.");
        }
      }
    }

    if (!projectName) {
      const defaultProjectName = basename(projectRoot) || "my-project";
      projectName = await ask(`Project name [${defaultProjectName}]: `, defaultProjectName);
    }

    if (!mode) {
      const isEdit = await promptYesNo(
        "Use edit mode (agent changes still require approval)?",
        true,
        ask,
      );
      mode = isEdit ? "edit" : "review";
    }

    if (worktreeEnabled === undefined) {
      worktreeEnabled = await promptYesNo(
        "Use an isolated Git worktree for watched changes and agent repairs?",
        false,
        ask,
      );
    }

    if (!routing) {
      const isPerFile = await promptYesNo("Use per-file conversations?", false, ask);
      routing = isPerFile ? "per-file" : "project";
    }
  }

  // Validate required fields
  if (!agentId && !createAgent) {
    throw new Error(
      "An agent ID is required. Provide --agent-id or --create-agent, or run interactively.",
    );
  }

  // Create agent if requested
  if (createAgent) {
    if (!dependencies.createAgent) {
      throw new Error(
        "Agent creation requires a LettaAgentClient. Provide --agent-id instead or ensure client is available.",
      );
    }
    agentId = await dependencies.createAgent({
      name: safeAgentName(projectName || "hypervigilant-agent"),
      description: "Reviews saved file diffs for a Hypervigilant project.",
      memfs: false,
      memory: [
        {
          label: "persona",
          value:
            "You review incremental text-file diffs. Be concise, preserve project context across conversations, and only edit files when the user enables edit mode.",
        },
        { label: "project", value: `Project: ${projectName || "unnamed"}` },
      ],
    });
  }

  if (!agentId) {
    throw new Error("Failed to obtain an agent ID.");
  }

  // Build config with defaults
  const configData: Record<string, unknown> = {
    version: 1,
    project: projectName || "my-project",
    agentId,
    include: include ?? ["**/*.md", "**/*.txt"],
    exclude: exclude ?? [
      "**/node_modules/**",
      "**/.git/**",
      ".hypervigilant/**",
      "**/.hypervigilant/**",
    ],
    maxFileSizeBytes: 1_048_576,
    batching: {
      strategy: batching ?? "debounce",
      delayMs: 500,
      maxWaitMs: 5000,
      windowMs: 2000,
    },
    mode: mode ?? "edit",
    routing: routing ?? "project",
    stateDir: stateDir ?? ".hypervigilant",
    worktree: {
      enabled: worktreeEnabled ?? false,
      autoCommit: true,
      branchPrefix: "hypervigilant",
    },
  };

  // Validate through schema
  const parsed = configSchema.safeParse(configData);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
  }

  const config = parsed.data;

  // Ensure state directory exists
  const stateDirAbs = resolve(projectRoot, config.stateDir);
  if (!existsSync(stateDirAbs)) {
    mkdirSync(stateDirAbs, { recursive: true });
  }

  // Write the human-owned TOML config atomically.
  await atomicWriteFile(configPath, serializeConfigToml(config));

  return { configPath, config, agentId };
}
