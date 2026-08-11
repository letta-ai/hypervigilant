import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const PROOF_FILENAME = "device-only-proof.txt";
const TRIGGER_FILENAME = "trigger.md";

interface DemoConfigOptions {
  agentId: string;
  model: string;
}

interface PersistedState {
  projectConversation?: { conversationId?: string | null };
}

export function renderCloudLocalDeviceConfig(options: DemoConfigOptions): string {
  const instructions = [
    "Prove that this Cloud agent is executing on the local device.",
    `Use the Read tool to read ${PROOF_FILENAME} from the project working directory.`,
    "Return the exact file content. Do not infer or invent it. Take no other action.",
  ].join(" ");
  return `version = 1
project = "cloud-agent-local-device-proof"
agent_id = ${JSON.stringify(options.agentId)}
model = ${JSON.stringify(options.model)}
include = [${JSON.stringify(TRIGGER_FILENAME)}]
exclude = [${JSON.stringify(PROOF_FILENAME)}, ".hypervigilant/**", "**/.hypervigilant/**"]
mode = "review"
routing = "project"
state_dir = ".hypervigilant"
instructions = ${JSON.stringify(instructions)}

[connection]
backend = "cloud"
`;
}

export function assertLocalMarker(output: string, marker: string): void {
  if (!output.includes(marker)) {
    throw new Error(
      "The Cloud agent did not return the local-only marker. Local-device execution was not proved.",
    );
  }
}

function requiredCloudApiKey(): string {
  const apiKey = process.env.LETTA_API_KEY?.trim();
  if (!apiKey?.startsWith("sk-let-")) {
    throw new Error("Export a Letta Cloud key as LETTA_API_KEY before running this demo.");
  }
  return apiKey;
}

async function archiveDemoConversation(statePath: string, apiKey: string): Promise<string | null> {
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(await readFile(statePath, "utf8")) as PersistedState;
  const conversationId = state.projectConversation?.conversationId ?? null;
  if (!conversationId) return null;
  const cloud = new LettaAgentClient({ backend: "cloud", apiKey });
  await cloud.conversations.update(conversationId, { archived: true });
  const archived = await cloud.conversations.retrieve(conversationId);
  if (archived.archived !== true) {
    throw new Error(`Cloud conversation ${conversationId} did not read back as archived.`);
  }
  return conversationId;
}

async function runCli(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (exitCode !== 0) {
    throw new Error(`Hypervigilant scan exited with status ${exitCode}.`);
  }
  return `${stdout}\n${stderr}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "agent-id": { type: "string" },
      model: { type: "string", default: "letta/auto" },
      keep: { type: "boolean", default: false },
    },
    strict: true,
  });
  const agentId = values["agent-id"]?.trim();
  if (!agentId?.startsWith("agent-") || agentId === "agent-REPLACE-ME") {
    throw new Error("Pass a real Cloud agent ID with --agent-id agent-xxx.");
  }
  const model = values.model?.trim();
  if (!model) throw new Error("The model handle cannot be blank.");
  const apiKey = requiredCloudApiKey();

  const repositoryRoot = resolve(import.meta.dir, "..", "..");
  const sourceCliPath = join(repositoryRoot, "src", "cli.ts");
  const cliPath = existsSync(sourceCliPath)
    ? sourceCliPath
    : join(repositoryRoot, "dist", "cli.js");
  const workspace = await mkdtemp(join(tmpdir(), "hypervigilant-cloud-local-device-"));
  const marker = `local-device-${randomUUID()}`;
  const statePath = join(workspace, ".hypervigilant", "state.json");
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let archivedConversationId: string | null = null;

  try {
    await Promise.all([
      writeFile(join(workspace, PROOF_FILENAME), `${marker}\n`, "utf8"),
      writeFile(
        join(workspace, TRIGGER_FILENAME),
        "Run the configured Cloud-agent/local-device execution proof.\n",
        "utf8",
      ),
      writeFile(
        join(workspace, "hypervigilant.toml"),
        renderCloudLocalDeviceConfig({ agentId, model }),
        "utf8",
      ),
    ]);
    const output = await runCli([process.execPath, cliPath, "scan", workspace], repositoryRoot);
    assertLocalMarker(output, marker);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      archivedConversationId = await archiveDemoConversation(statePath, apiKey);
    } catch (error) {
      cleanupError = error;
    }
    if (!values.keep) await rm(workspace, { recursive: true, force: true });
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "Proof and cleanup both failed.");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;

  console.log("\nCloud-agent/local-device proof passed.");
  console.log(`Local-only marker: ${marker}`);
  console.log(
    archivedConversationId
      ? `Temporary Cloud conversation archived: ${archivedConversationId}`
      : "No temporary Cloud conversation required cleanup.",
  );
  if (values.keep) console.log(`Workspace retained: ${workspace}`);
}

if (import.meta.main) {
  await main();
}
