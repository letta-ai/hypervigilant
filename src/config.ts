import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { PROHIBITED_LOCAL_TOOLS, RESERVED_LOCAL_TOOLS } from "./client-tools.ts";

export const CONFIG_FILENAME = "hypervigilant.toml";
export const LEGACY_CONFIG_FILENAME = "hypervigilant.json";
export const DEFAULT_STATE_DIR = ".hypervigilant";
export const STATE_FILENAME = "state.json";

export const BATCHING_STRATEGIES = ["debounce", "fixed-window", "immediate"] as const;
export type BatchingStrategy = (typeof BATCHING_STRATEGIES)[number];

export const AGENT_MODES = ["review", "edit"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const CONVERSATION_ROUTING = ["project", "per-file"] as const;
export type ConversationRouting = (typeof CONVERSATION_ROUTING)[number];

export const PROMPT_RULE_EVENTS = ["add", "change", "delete"] as const;
export type PromptRuleEvent = (typeof PROMPT_RULE_EVENTS)[number];

const batchingStrategySchema = z.enum(BATCHING_STRATEGIES);

const clientToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Use a client tool name containing letters, numbers, '.', '_', ':', or '-'.",
  );

const toolsConfigSchema = z
  .object({
    autoAllow: z.array(clientToolNameSchema).default([]),
    ask: z.array(clientToolNameSchema).default([]),
  })
  .strict()
  .superRefine((tools, context) => {
    const reserved = new Set<string>([...RESERVED_LOCAL_TOOLS, ...PROHIBITED_LOCAL_TOOLS]);
    const seen = new Set<string>();
    for (const [policy, names] of [
      ["autoAllow", tools.autoAllow],
      ["ask", tools.ask],
    ] as const) {
      for (const [index, name] of names.entries()) {
        if (reserved.has(name)) {
          context.addIssue({
            code: "custom",
            path: [policy, index],
            message: `Client tool ${JSON.stringify(name)} is managed or prohibited by Hypervigilant.`,
          });
        }
        if (seen.has(name)) {
          context.addIssue({
            code: "custom",
            path: [policy, index],
            message: `Client tool ${JSON.stringify(name)} is configured more than once.`,
          });
        }
        seen.add(name);
      }
    }
  });

const batchingConfigSchema = z
  .object({
    strategy: batchingStrategySchema.default("debounce"),
    delayMs: z.number().int().min(0).default(500),
    maxWaitMs: z.number().int().min(0).default(5000),
    windowMs: z.number().int().min(0).default(2000),
  })
  .strict();

const worktreeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoCommit: z.boolean().default(true),
    branchPrefix: z
      .string()
      .min(1)
      .default("hypervigilant")
      .refine(
        (value) =>
          /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
          !value.includes("..") &&
          !value.includes("@{") &&
          !value.includes("//") &&
          !value.endsWith("/") &&
          !value.endsWith("."),
        { message: "Use a safe Git branch prefix without spaces, '..', '@{', or empty segments." },
      ),
  })
  .strict();

const promptRuleSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "Name cannot be blank."),
    match: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0, "Glob cannot be blank."),
      )
      .min(1),
    events: z
      .array(z.enum(PROMPT_RULE_EVENTS))
      .min(1)
      .default([...PROMPT_RULE_EVENTS]),
    prompt: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "Prompt cannot be blank."),
    conversation: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        "Use a logical conversation name containing letters, numbers, '.', '_', or '-'.",
      )
      .optional(),
  })
  .strict();

const agentModeSchema = z.enum(AGENT_MODES);
const conversationRoutingSchema = z.enum(CONVERSATION_ROUTING);

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().min(1),
    agentId: z
      .string()
      .min(1)
      .refine((value) => value !== "agent-REPLACE-ME", {
        message: "Replace agent-REPLACE-ME with a real Letta agent ID.",
      }),
    include: z.array(z.string().min(1)).default(["**/*.md", "**/*.txt"]),
    exclude: z
      .array(z.string().min(1))
      .default(["**/node_modules/**", "**/.git/**", ".hypervigilant/**", "**/.hypervigilant/**"]),
    maxFileSizeBytes: z.number().int().min(1).default(1_048_576),
    batching: batchingConfigSchema.default(() => ({
      strategy: "debounce" as const,
      delayMs: 500,
      maxWaitMs: 5000,
      windowMs: 2000,
    })),
    mode: agentModeSchema.default("edit"),
    routing: conversationRoutingSchema.default("project"),
    stateDir: z.string().min(1).default(".hypervigilant"),
    instructions: z.string().default(""),
    tools: toolsConfigSchema.default(() => ({ autoAllow: [], ask: [] })),
    worktree: worktreeConfigSchema.default(() => ({
      enabled: false,
      autoCommit: true,
      branchPrefix: "hypervigilant",
    })),
    promptRules: z.array(promptRuleSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const names = new Set<string>();
    for (const [index, rule] of config.promptRules.entries()) {
      if (names.has(rule.name)) {
        context.addIssue({
          code: "custom",
          path: ["promptRules", index, "name"],
          message: `Prompt rule name ${JSON.stringify(rule.name)} is duplicated.`,
        });
      }
      names.add(rule.name);
    }
  });

export type HypervigilantConfig = z.infer<typeof configSchema>;
export type ClientTools = HypervigilantConfig["tools"];
export type PromptRule = HypervigilantConfig["promptRules"][number];

export type ConfigParseResult =
  | { ok: true; config: HypervigilantConfig }
  | { ok: false; errors: string[] };

export interface ResolvedConfigPath {
  path: string;
  legacy: boolean;
}

const TOML_TOP_LEVEL_KEYS: Record<string, keyof HypervigilantConfig> = {
  version: "version",
  project: "project",
  agent_id: "agentId",
  include: "include",
  exclude: "exclude",
  max_file_size_bytes: "maxFileSizeBytes",
  batching: "batching",
  mode: "mode",
  routing: "routing",
  state_dir: "stateDir",
  instructions: "instructions",
  tools: "tools",
  worktree: "worktree",
  prompt_rules: "promptRules",
};

const TOML_BATCHING_KEYS: Record<string, keyof HypervigilantConfig["batching"]> = {
  strategy: "strategy",
  delay_ms: "delayMs",
  max_wait_ms: "maxWaitMs",
  window_ms: "windowMs",
};

const TOML_TOOLS_KEYS: Record<string, keyof HypervigilantConfig["tools"]> = {
  auto_allow: "autoAllow",
  ask: "ask",
};

const TOML_WORKTREE_KEYS: Record<string, keyof HypervigilantConfig["worktree"]> = {
  enabled: "enabled",
  auto_commit: "autoCommit",
  branch_prefix: "branchPrefix",
};

const TOML_PROMPT_RULE_KEYS: Record<string, keyof HypervigilantConfig["promptRules"][number]> = {
  name: "name",
  match: "match",
  events: "events",
  prompt: "prompt",
  conversation: "conversation",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTomlConfig(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = TOML_TOP_LEVEL_KEYS[key];
    if (!target) throw new Error(`Unknown TOML key ${JSON.stringify(key)}.`);
    if (key === "batching" && isRecord(value)) {
      const batching: Record<string, unknown> = {};
      for (const [batchingKey, batchingValue] of Object.entries(value)) {
        const batchingTarget = TOML_BATCHING_KEYS[batchingKey];
        if (!batchingTarget) {
          throw new Error(`Unknown TOML key ${JSON.stringify(`batching.${batchingKey}`)}.`);
        }
        batching[batchingTarget] = batchingValue;
      }
      normalized.batching = batching;
      continue;
    }
    if (key === "tools" && isRecord(value)) {
      const tools: Record<string, unknown> = {};
      for (const [toolsKey, toolsValue] of Object.entries(value)) {
        const toolsTarget = TOML_TOOLS_KEYS[toolsKey];
        if (!toolsTarget) {
          throw new Error(`Unknown TOML key ${JSON.stringify(`tools.${toolsKey}`)}.`);
        }
        tools[toolsTarget] = toolsValue;
      }
      normalized.tools = tools;
      continue;
    }
    if (key === "worktree" && isRecord(value)) {
      const worktree: Record<string, unknown> = {};
      for (const [worktreeKey, worktreeValue] of Object.entries(value)) {
        const worktreeTarget = TOML_WORKTREE_KEYS[worktreeKey];
        if (!worktreeTarget) {
          throw new Error(`Unknown TOML key ${JSON.stringify(`worktree.${worktreeKey}`)}.`);
        }
        worktree[worktreeTarget] = worktreeValue;
      }
      normalized.worktree = worktree;
      continue;
    }
    if (key === "prompt_rules" && Array.isArray(value)) {
      normalized.promptRules = value.map((rule, index) => {
        if (!isRecord(rule)) return rule;
        const promptRule: Record<string, unknown> = {};
        for (const [ruleKey, ruleValue] of Object.entries(rule)) {
          const ruleTarget = TOML_PROMPT_RULE_KEYS[ruleKey];
          if (!ruleTarget) {
            throw new Error(
              `Unknown TOML key ${JSON.stringify(`prompt_rules.${index}.${ruleKey}`)}.`,
            );
          }
          promptRule[ruleTarget] = ruleValue;
        }
        return promptRule;
      });
      continue;
    }
    normalized[target] = value;
  }
  return normalized;
}

export function validateConfig(raw: unknown): ConfigParseResult {
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}

export function resolveConfigPath(projectRoot: string, explicitPath?: string): ResolvedConfigPath {
  if (explicitPath) {
    const path = resolve(explicitPath);
    return { path, legacy: extname(path).toLowerCase() === ".json" };
  }
  const tomlPath = join(projectRoot, CONFIG_FILENAME);
  if (existsSync(tomlPath)) return { path: tomlPath, legacy: false };
  const jsonPath = join(projectRoot, LEGACY_CONFIG_FILENAME);
  if (existsSync(jsonPath)) return { path: jsonPath, legacy: true };
  return { path: tomlPath, legacy: false };
}

export async function loadConfig(configPath: string): Promise<HypervigilantConfig> {
  const absPath = resolve(configPath);
  let rawText: string;
  try {
    rawText = await readFile(absPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file at ${absPath}: ${(error as Error).message}`);
  }

  const extension = extname(absPath).toLowerCase();
  let raw: unknown;
  if (extension === ".toml") {
    try {
      raw = Bun.TOML.parse(rawText);
    } catch (error) {
      throw new Error(`Config file ${absPath} is not valid TOML: ${(error as Error).message}`);
    }
    try {
      raw = normalizeTomlConfig(raw);
    } catch (error) {
      throw new Error(`Invalid configuration in ${absPath}:\n  ${(error as Error).message}`);
    }
  } else if (extension === ".json") {
    try {
      raw = JSON.parse(rawText);
    } catch {
      throw new Error(`Config file ${absPath} is not valid JSON.`);
    }
  } else {
    throw new Error(`Config file ${absPath} must use a .toml or .json extension.`);
  }

  const result = validateConfig(raw);
  if (!result.ok) {
    throw new Error(`Invalid configuration in ${absPath}:\n${result.errors.join("\n")}`);
  }
  return result.config;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function serializeConfigToml(config: HypervigilantConfig): string {
  const lines = [
    "# Hypervigilant project configuration.",
    "version = 1",
    `project = ${tomlString(config.project)}`,
    `agent_id = ${tomlString(config.agentId)}`,
    `include = ${tomlStringArray(config.include)}`,
    `exclude = ${tomlStringArray(config.exclude)}`,
    `max_file_size_bytes = ${config.maxFileSizeBytes}`,
    `mode = ${tomlString(config.mode)}`,
    `routing = ${tomlString(config.routing)}`,
    `state_dir = ${tomlString(config.stateDir)}`,
  ];
  if (config.instructions) lines.push(`instructions = ${tomlString(config.instructions)}`);
  lines.push(
    "",
    "[batching]",
    `strategy = ${tomlString(config.batching.strategy)}`,
    `delay_ms = ${config.batching.delayMs}`,
    `max_wait_ms = ${config.batching.maxWaitMs}`,
    `window_ms = ${config.batching.windowMs}`,
    "",
    "[tools]",
    `auto_allow = ${tomlStringArray(config.tools.autoAllow)}`,
    `ask = ${tomlStringArray(config.tools.ask)}`,
    "",
    "[worktree]",
    `enabled = ${config.worktree.enabled}`,
    `auto_commit = ${config.worktree.autoCommit}`,
    `branch_prefix = ${tomlString(config.worktree.branchPrefix)}`,
    "",
  );
  for (const rule of config.promptRules) {
    lines.push(
      "[[prompt_rules]]",
      `name = ${tomlString(rule.name)}`,
      `match = ${tomlStringArray(rule.match)}`,
      `events = ${tomlStringArray(rule.events)}`,
      `prompt = ${tomlString(rule.prompt)}`,
    );
    if (rule.conversation) lines.push(`conversation = ${tomlString(rule.conversation)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface GlobMatcher {
  matches(relPath: string): boolean;
  isIncluded(relPath: string): boolean;
  isExcluded(relPath: string): boolean;
}

export function createGlobMatcher(
  config: Pick<HypervigilantConfig, "include" | "exclude">,
): GlobMatcher {
  const includeMatchers = config.include.map((glob) => picomatch(glob, { dot: true }));
  const excludeMatchers = config.exclude.map((glob) => picomatch(glob, { dot: true }));

  return {
    isIncluded(relPath: string): boolean {
      return includeMatchers.some((matcher) => matcher(relPath));
    },
    isExcluded(relPath: string): boolean {
      return excludeMatchers.some((matcher) => matcher(relPath));
    },
    matches(relPath: string): boolean {
      const normalized = relPath.replace(/\\/g, "/");
      return this.isIncluded(normalized) && !this.isExcluded(normalized);
    },
  };
}
