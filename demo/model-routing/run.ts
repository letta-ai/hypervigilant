import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "agent-id": { type: "string" },
    "primary-model": { type: "string", default: "letta/auto" },
    "economy-model": { type: "string", default: "openai/gpt-4o-mini" },
    workspace: { type: "string", default: "/tmp/hypervigilant-model-routing" },
    "prepare-only": { type: "boolean", default: false },
  },
  strict: true,
});

const agentId = values["agent-id"];
if (!agentId?.startsWith("agent-") || agentId === "agent-REPLACE-ME") {
  throw new Error("Pass a real Letta agent ID with --agent-id agent-xxx.");
}
const primaryModel = values["primary-model"]?.trim();
const economyModel = values["economy-model"]?.trim();
if (!primaryModel || !economyModel) throw new Error("Model handles cannot be blank.");

const workspace = resolve(values.workspace ?? "/tmp/hypervigilant-model-routing");
const repositoryRoot = resolve(import.meta.dir, "..", "..");
const sourceCliPath = join(repositoryRoot, "src", "cli.ts");
const cliPath = existsSync(sourceCliPath) ? sourceCliPath : join(repositoryRoot, "dist", "cli.js");
const codeConfigPath = join(workspace, "code-review.toml");
const notesConfigPath = join(workspace, "notes-triage.toml");

function config(options: {
  project: string;
  model: string;
  include: string;
  stateDir: string;
  instructions: string;
}): string {
  return `version = 1
project = ${JSON.stringify(options.project)}
agent_id = ${JSON.stringify(agentId)}
model = ${JSON.stringify(options.model)}
include = [${JSON.stringify(options.include)}]
exclude = ["**/.git/**", "**/.hypervigilant*/**"]
mode = "review"
routing = "project"
state_dir = ${JSON.stringify(options.stateDir)}
instructions = ${JSON.stringify(options.instructions)}
`;
}

await mkdir(join(workspace, "code"), { recursive: true });
await mkdir(join(workspace, "notes"), { recursive: true });
await Promise.all([
  writeFile(join(workspace, "code", "example.ts"), 'export const greeting = "hello";\n', {
    flag: "wx",
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  }),
  writeFile(join(workspace, "notes", "inbox.md"), "# Inbox\n", { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  ),
  writeFile(
    codeConfigPath,
    config({
      project: "model-routing-code-review",
      model: primaryModel,
      include: "code/**",
      stateDir: ".hypervigilant-code",
      instructions: "Review source changes for correctness and regressions.",
    }),
  ),
  writeFile(
    notesConfigPath,
    config({
      project: "model-routing-notes-triage",
      model: economyModel,
      include: "notes/**",
      stateDir: ".hypervigilant-notes",
      instructions: "Summarize each note change in one sentence. Report unclear follow-up work.",
    }),
  ),
]);

const command = (configPath: string): string[] => [
  process.execPath,
  cliPath,
  "watch",
  workspace,
  "--config",
  configPath,
];
const shellCommand = (configPath: string): string =>
  command(configPath)
    .map((argument) => JSON.stringify(argument))
    .join(" ");

console.log(`Prepared ${workspace}`);
console.log(`code/**  -> ${primaryModel}`);
console.log(`notes/** -> ${economyModel}`);

if (values["prepare-only"]) {
  console.log(
    `\nRun in separate terminals:\n${shellCommand(codeConfigPath)}\n${shellCommand(notesConfigPath)}`,
  );
  process.exit(0);
}

const watchers = [
  {
    label: "code",
    process: Bun.spawn(command(codeConfigPath), {
      cwd: repositoryRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  },
  {
    label: "notes",
    process: Bun.spawn(command(notesConfigPath), {
      cwd: repositoryRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  },
];

async function printOutput(
  label: string,
  stream: ReadableStream<Uint8Array> | null,
  output: NodeJS.WriteStream,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) output.write(`[${label}] ${line}\n`);
  }
  pending += decoder.decode();
  if (pending) output.write(`[${label}] ${pending}\n`);
}

const outputTasks = watchers.flatMap((watcher) => [
  printOutput(watcher.label, watcher.process.stdout, process.stdout),
  printOutput(watcher.label, watcher.process.stderr, process.stderr),
]);
let stopping = false;
let requestedStop = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  for (const watcher of watchers) watcher.process.kill();
};
const requestStop = (): void => {
  requestedStop = true;
  stop();
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

console.log(
  "Both watchers are starting. Wait for both baselines, then edit code/ or notes/. Press Ctrl-C to stop.",
);
const firstExit = await Promise.race(
  watchers.map(async (watcher) => ({ watcher, code: await watcher.process.exited })),
);
if (!requestedStop) {
  stop();
  console.error(`${firstExit.watcher.label} watcher exited with code ${firstExit.code}.`);
}
await Promise.all([...watchers.map((watcher) => watcher.process.exited), ...outputTasks]);
if (!requestedStop) process.exitCode = firstExit.code || 1;
