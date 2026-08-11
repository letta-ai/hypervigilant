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

export const LETTA_BACKENDS = ["cloud", "local", "remote"] as const;
export type LettaBackend = (typeof LETTA_BACKENDS)[number];

export const PROMPT_RULE_EVENTS = ["add", "change", "delete"] as const;
export type PromptRuleEvent = (typeof PROMPT_RULE_EVENTS)[number];

const batchingStrategySchema = z.enum(BATCHING_STRATEGIES);

const positiveIntegerSchema = z.number().int().min(1);
const environmentVariableSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a valid environment variable name.");
const appServerUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Use an http, https, ws, or wss App Server URL.");

const httpEventUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Use an http or https event destination URL.");

function isLoopbackAppServerUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

export const httpEventDestinationSchema = z
  .object({
    url: httpEventUrlSchema,
    authTokenEnv: environmentVariableSchema
      .refine((value) => value !== "LETTA_API_KEY", {
        message: "Use a dedicated event token variable instead of LETTA_API_KEY.",
      })
      .optional(),
    requestTimeoutMs: positiveIntegerSchema.default(10_000),
  })
  .strict()
  .superRefine((destination, context) => {
    let url: URL | null = null;
    try {
      url = new URL(destination.url);
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: "custom",
          path: ["url"],
          message:
            "HTTP event destination URLs cannot contain credentials, query parameters, or fragments.",
        });
      }
    } catch {
      // The field schema reports invalid URLs.
    }
    if (!isLoopbackAppServerUrl(destination.url)) {
      if (!destination.authTokenEnv) {
        context.addIssue({
          code: "custom",
          path: ["authTokenEnv"],
          message: "Non-loopback HTTP event destinations require auth_token_env.",
        });
      }
      if (url && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["url"],
          message: "Non-loopback HTTP event destinations require an https URL.",
        });
      }
    }
  });

export type HttpEventDestinationConfig = z.infer<typeof httpEventDestinationSchema>;
export type HttpEventDestinationInput = z.input<typeof httpEventDestinationSchema>;

const destinationsConfigSchema = z
  .object({
    agent: z.boolean().default(true),
    http: httpEventDestinationSchema.optional(),
  })
  .strict()
  .superRefine((destinations, context) => {
    if (!destinations.agent && !destinations.http) {
      context.addIssue({
        code: "custom",
        message: "Enable agent delivery, configure an HTTP destination, or both.",
      });
    }
  });

export const connectionConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("cloud") }).strict(),
  z
    .object({
      backend: z.literal("local"),
      requestTimeoutMs: positiveIntegerSchema.optional(),
      startupTimeoutMs: positiveIntegerSchema.optional(),
    })
    .strict(),
  z
    .object({
      backend: z.literal("remote"),
      url: appServerUrlSchema,
      authTokenEnv: environmentVariableSchema.optional(),
      requestTimeoutMs: positiveIntegerSchema.optional(),
      sharedFilesystem: z.boolean().default(false),
    })
    .strict()
    .superRefine((connection, context) => {
      let url: URL | null = null;
      try {
        url = new URL(connection.url);
        if (url.username || url.password || url.search || url.hash) {
          context.addIssue({
            code: "custom",
            path: ["url"],
            message:
              "Remote App Server URLs cannot contain credentials, query parameters, or fragments.",
          });
        }
      } catch {
        // The field schema reports invalid URLs.
      }
      if (!isLoopbackAppServerUrl(connection.url)) {
        if (!connection.authTokenEnv) {
          context.addIssue({
            code: "custom",
            path: ["authTokenEnv"],
            message: "Non-loopback remote App Servers require auth_token_env.",
          });
        }
        if (url && url.protocol !== "https:" && url.protocol !== "wss:") {
          context.addIssue({
            code: "custom",
            path: ["url"],
            message: "Non-loopback remote App Servers require an https or wss URL.",
          });
        }
      }
    }),
]);

export type LettaConnectionConfig = z.infer<typeof connectionConfigSchema>;

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
      })
      .optional(),
    model: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "Model cannot be blank.")
      .optional(),
    connection: connectionConfigSchema.default({ backend: "cloud" }),
    destinations: destinationsConfigSchema.default(() => ({ agent: true })),
    include: z.array(z.string().min(1)).default(["**/*.md", "**/*.txt"]),
    exclude: z
      .array(z.string().min(1))
      .default(["**/node_modules/**", "**/.git/**", ".hypervigilant/**", "**/.hypervigilant/**"]),
    maxFileSizeBytes: z.number().int().min(1).default(1_048_576),
    maxScanFiles: z.number().int().min(1).default(100),
    maxScanTextBytes: z.number().int().min(1).default(65_536),
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
    if (config.destinations.agent && !config.agentId) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "Agent delivery requires agent_id.",
      });
    }
    if (!config.destinations.agent && config.worktree.enabled) {
      context.addIssue({
        code: "custom",
        path: ["worktree", "enabled"],
        message: "HTTP-only delivery cannot use an agent edit worktree.",
      });
    }
    if (!config.destinations.agent) {
      const inertAgentSettings: Array<[boolean, (string | number)[], string]> = [
        [config.model !== undefined, ["model"], "HTTP-only delivery cannot select an agent model."],
        [
          config.instructions.length > 0,
          ["instructions"],
          "HTTP-only delivery cannot configure agent instructions.",
        ],
        [
          config.promptRules.length > 0,
          ["promptRules"],
          "HTTP-only delivery cannot configure agent prompt rules.",
        ],
        [
          config.tools.autoAllow.length + config.tools.ask.length > 0,
          ["tools"],
          "HTTP-only delivery cannot configure agent tools.",
        ],
        [
          config.connection.backend !== "cloud",
          ["connection"],
          "HTTP-only delivery cannot configure an inert agent connection.",
        ],
      ];
      for (const [invalid, path, message] of inertAgentSettings) {
        if (invalid) context.addIssue({ code: "custom", path, message });
      }
    }
    if (
      config.destinations.agent &&
      config.connection.backend === "remote" &&
      !config.connection.sharedFilesystem
    ) {
      if (config.mode !== "review") {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "Remote App Server connections without shared_filesystem must use review mode.",
        });
      }
      if (config.worktree.enabled) {
        context.addIssue({
          code: "custom",
          path: ["worktree", "enabled"],
          message:
            "Remote App Server connections without shared_filesystem cannot use an isolated worktree.",
        });
      }
    }
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
  model: "model",
  connection: "connection",
  destinations: "destinations",
  include: "include",
  exclude: "exclude",
  max_file_size_bytes: "maxFileSizeBytes",
  max_scan_files: "maxScanFiles",
  max_scan_text_bytes: "maxScanTextBytes",
  batching: "batching",
  mode: "mode",
  routing: "routing",
  state_dir: "stateDir",
  instructions: "instructions",
  tools: "tools",
  worktree: "worktree",
  prompt_rules: "promptRules",
};

type ConnectionConfigKey =
  | "backend"
  | "url"
  | "authTokenEnv"
  | "requestTimeoutMs"
  | "startupTimeoutMs"
  | "sharedFilesystem";

const TOML_CONNECTION_KEYS: Record<string, ConnectionConfigKey> = {
  backend: "backend",
  url: "url",
  auth_token_env: "authTokenEnv",
  request_timeout_ms: "requestTimeoutMs",
  startup_timeout_ms: "startupTimeoutMs",
  shared_filesystem: "sharedFilesystem",
};

const TOML_DESTINATIONS_KEYS = {
  agent: "agent",
  http: "http",
} as const;

const TOML_HTTP_DESTINATION_KEYS: Record<
  string,
  keyof NonNullable<HypervigilantConfig["destinations"]["http"]>
> = {
  url: "url",
  auth_token_env: "authTokenEnv",
  request_timeout_ms: "requestTimeoutMs",
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
    if (key === "connection" && isRecord(value)) {
      const connection: Record<string, unknown> = {};
      for (const [connectionKey, connectionValue] of Object.entries(value)) {
        const connectionTarget = TOML_CONNECTION_KEYS[connectionKey];
        if (!connectionTarget) {
          throw new Error(`Unknown TOML key ${JSON.stringify(`connection.${connectionKey}`)}.`);
        }
        connection[connectionTarget] = connectionValue;
      }
      normalized.connection = connection;
      continue;
    }
    if (key === "destinations" && isRecord(value)) {
      const destinations: Record<string, unknown> = {};
      for (const [destinationKey, destinationValue] of Object.entries(value)) {
        const destinationTarget =
          TOML_DESTINATIONS_KEYS[destinationKey as keyof typeof TOML_DESTINATIONS_KEYS];
        if (!destinationTarget) {
          throw new Error(`Unknown TOML key ${JSON.stringify(`destinations.${destinationKey}`)}.`);
        }
        if (destinationKey === "http" && isRecord(destinationValue)) {
          const http: Record<string, unknown> = {};
          for (const [httpKey, httpValue] of Object.entries(destinationValue)) {
            const httpTarget = TOML_HTTP_DESTINATION_KEYS[httpKey];
            if (!httpTarget) {
              throw new Error(
                `Unknown TOML key ${JSON.stringify(`destinations.http.${httpKey}`)}.`,
              );
            }
            http[httpTarget] = httpValue;
          }
          destinations.http = http;
          continue;
        }
        destinations[destinationTarget] = destinationValue;
      }
      normalized.destinations = destinations;
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
  ];
  if (config.agentId) lines.push(`agent_id = ${tomlString(config.agentId)}`);
  if (config.destinations.agent && config.model) lines.push(`model = ${tomlString(config.model)}`);
  lines.push(
    `include = ${tomlStringArray(config.include)}`,
    `exclude = ${tomlStringArray(config.exclude)}`,
    `max_file_size_bytes = ${config.maxFileSizeBytes}`,
    `max_scan_files = ${config.maxScanFiles}`,
    `max_scan_text_bytes = ${config.maxScanTextBytes}`,
    `state_dir = ${tomlString(config.stateDir)}`,
  );
  if (config.destinations.agent) {
    lines.push(`mode = ${tomlString(config.mode)}`, `routing = ${tomlString(config.routing)}`);
    if (config.instructions) lines.push(`instructions = ${tomlString(config.instructions)}`);
  }
  lines.push("", "[destinations]", `agent = ${config.destinations.agent}`);
  if (config.destinations.http) {
    lines.push("", "[destinations.http]", `url = ${tomlString(config.destinations.http.url)}`);
    if (config.destinations.http.authTokenEnv) {
      lines.push(`auth_token_env = ${tomlString(config.destinations.http.authTokenEnv)}`);
    }
    lines.push(`request_timeout_ms = ${config.destinations.http.requestTimeoutMs}`);
  }
  if (config.destinations.agent) {
    lines.push("", "[connection]", `backend = ${tomlString(config.connection.backend)}`);
  }
  if (config.destinations.agent && config.connection.backend === "local") {
    if (config.connection.requestTimeoutMs !== undefined) {
      lines.push(`request_timeout_ms = ${config.connection.requestTimeoutMs}`);
    }
    if (config.connection.startupTimeoutMs !== undefined) {
      lines.push(`startup_timeout_ms = ${config.connection.startupTimeoutMs}`);
    }
  }
  if (config.destinations.agent && config.connection.backend === "remote") {
    lines.push(`url = ${tomlString(config.connection.url)}`);
    if (config.connection.authTokenEnv !== undefined) {
      lines.push(`auth_token_env = ${tomlString(config.connection.authTokenEnv)}`);
    }
    if (config.connection.requestTimeoutMs !== undefined) {
      lines.push(`request_timeout_ms = ${config.connection.requestTimeoutMs}`);
    }
    lines.push(`shared_filesystem = ${config.connection.sharedFilesystem}`);
  }
  lines.push(
    "",
    "[batching]",
    `strategy = ${tomlString(config.batching.strategy)}`,
    `delay_ms = ${config.batching.delayMs}`,
    `max_wait_ms = ${config.batching.maxWaitMs}`,
    `window_ms = ${config.batching.windowMs}`,
  );
  if (config.destinations.agent) {
    lines.push(
      "",
      "[tools]",
      `auto_allow = ${tomlStringArray(config.tools.autoAllow)}`,
      `ask = ${tomlStringArray(config.tools.ask)}`,
      "",
      "[worktree]",
      `enabled = ${config.worktree.enabled}`,
      `auto_commit = ${config.worktree.autoCommit}`,
      `branch_prefix = ${tomlString(config.worktree.branchPrefix)}`,
    );
  }
  lines.push("");
  for (const rule of config.destinations.agent ? config.promptRules : []) {
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
