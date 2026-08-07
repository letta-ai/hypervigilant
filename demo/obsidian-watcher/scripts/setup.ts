import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CreateAgentOptions } from "@letta-ai/letta-agent-sdk";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const demoRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(demoRoot, "..", "..");
export const defaultWorkspaceRoot = join(demoRoot, "workspace");

export interface ObsidianWatcherSetupOptions {
  vaultRoot?: string;
  agentId?: string;
  force?: boolean;
  seedSample?: boolean;
  createAgent?: (options: CreateAgentOptions) => Promise<string>;
}

export interface ObsidianWatcherSetupResult {
  configPath: string;
  agentId: string;
  createdAgent: boolean;
  seededSample: boolean;
}

export function autoAgentOptions(vaultRoot: string): CreateAgentOptions {
  const vaultName = basename(vaultRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const agentName = (vaultName ? `obsidian-watcher-${vaultName}` : "obsidian-watcher-demo")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return {
    name: agentName || "obsidian-watcher-demo",
    description: "Maintains a Markdown knowledge vault through persistent specialist conversations.",
    model: "auto",
    memfs: false,
    memory: [
      {
        label: "persona",
        value:
          "You maintain a Markdown knowledge vault. Preserve the author's words and uncertainty. Prefer exact file evidence over plausible reconstruction. Apply only unambiguous mechanical repairs; report interpretive issues without rewriting them.",
      },
      {
        label: "project",
        value:
          "Hypervigilant sends saved-file diffs into one default conversation and several named, filesystem-read-only specialist conversations. Keep each conversation focused on its assigned review lane.",
      },
    ],
  };
}

async function createAutoAgent(
  vaultRoot: string,
  options: CreateAgentOptions,
): Promise<string> {
  const apiKey = await resolveCloudApiKey([vaultRoot, packageRoot]);
  const client = new LettaAgentClient({ backend: "cloud", apiKey });
  return client.createAgent(options);
}

async function resolveCloudApiKey(roots: string[]): Promise<string> {
  for (const root of [...new Set(roots)]) {
    const path = join(root, ".env");
    if (!(await Bun.file(path).exists())) continue;
    const source = await readFile(path, "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?LETTA_API_KEY\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[1]?.trim() ?? "";
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      if (value.startsWith("sk-let-")) return value;
      throw new Error(`LETTA_API_KEY in ${path} is not a Letta Cloud key.`);
    }
  }
  const ambient = process.env.LETTA_API_KEY?.trim();
  if (ambient?.startsWith("sk-let-")) return ambient;
  if (ambient) throw new Error("LETTA_API_KEY is not a Letta Cloud key.");
  throw new Error("LETTA_API_KEY is required. Set an sk-let- key in .env or your shell.");
}

async function readConfiguredAgentId(configPath: string): Promise<string> {
  const raw = Bun.TOML.parse(await readFile(configPath, "utf8"));
  const agentId =
    raw && typeof raw === "object" && typeof raw.agent_id === "string" ? raw.agent_id : "";
  assertAgentId(agentId);
  return agentId;
}

export const samplePaths = [
  "VAULT.md",
  "index.md",
  "concepts/delivery-receipts.md",
  "projects/field-guide.md",
  "projects/publishing-log.md",
];

export async function copySampleVault(vaultRoot: string, overwrite = false): Promise<void> {
  const sampleRoot = join(demoRoot, "sample");
  for (const relPath of samplePaths) {
    const target = join(vaultRoot, relPath);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(
        join(sampleRoot, relPath),
        target,
        overwrite ? 0 : constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function assertAgentId(agentId: string): void {
  if (!agentId.startsWith("agent-") || agentId === "agent-REPLACE-ME") {
    throw new Error("Provide a Letta Cloud agent ID beginning with agent-.");
  }
}

export async function setupObsidianWatcher(
  options: ObsidianWatcherSetupOptions = {},
): Promise<ObsidianWatcherSetupResult> {
  const vaultRoot = resolve(options.vaultRoot ?? defaultWorkspaceRoot);
  const configPath = join(vaultRoot, "hypervigilant.toml");
  const seedSample = options.seedSample ?? options.vaultRoot === undefined;
  await mkdir(vaultRoot, { recursive: true });
  if (seedSample) await copySampleVault(vaultRoot);

  const configExists = await Bun.file(configPath).exists();
  let existingAgentId: string | undefined;
  if (configExists) {
    existingAgentId = await readConfiguredAgentId(configPath);
    if (options.force) {
      // Replace listener configuration while preserving the current agent by default.
    } else {
      if (options.agentId) {
        throw new Error("A config already exists. Use --force to replace its agent selection.");
      }
      return {
        configPath,
        agentId: existingAgentId,
        createdAgent: false,
        seededSample: seedSample,
      };
    }
  }

  let agentId = options.agentId ?? existingAgentId;
  let createdAgent = false;
  if (!agentId) {
    const createAgent =
      options.createAgent ?? ((createOptions) => createAutoAgent(vaultRoot, createOptions));
    agentId = await createAgent(autoAgentOptions(vaultRoot));
    createdAgent = true;
  }
  assertAgentId(agentId);

  const template = await readFile(join(demoRoot, "hypervigilant.toml.example"), "utf8");
  const projectName = basename(vaultRoot) || "obsidian-watcher";
  const config = template
    .replace("agent-REPLACE-ME", agentId)
    .replace('project = "obsidian-watcher-demo"', `project = ${JSON.stringify(projectName)}`);
  await writeFile(configPath, config, "utf8");
  await readConfiguredAgentId(configPath);
  return { configPath, agentId, createdAgent, seededSample: seedSample };
}

interface SetupArguments {
  vaultRoot?: string;
  agentId?: string;
  force: boolean;
}

export function parseSetupArguments(args: string[]): SetupArguments {
  let vaultRoot: string | undefined;
  let agentId: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument !== "--vault" && argument !== "--agent-id") {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--vault") vaultRoot = value;
    if (argument === "--agent-id") agentId = value;
    index += 1;
  }
  return { vaultRoot, agentId, force };
}

if (import.meta.main) {
  const args = parseSetupArguments(process.argv.slice(2));
  const result = await setupObsidianWatcher({
    vaultRoot: args.vaultRoot,
    agentId: args.agentId,
    force: args.force,
  });
  console.log(`Configured ${result.configPath}`);
  console.log(
    result.createdAgent
      ? `Created dedicated Letta Auto agent ${result.agentId}`
      : `Using agent ${result.agentId}`,
  );
}
