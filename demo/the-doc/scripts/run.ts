import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ActivityFeed, parseHypervigilantActivity } from "../activity.ts";
import { startTheDocServer } from "../server.ts";
import { setupTheDoc } from "./setup.ts";

const demoRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(demoRoot, "..", "..");
const workspaceRoot = join(demoRoot, "workspace");
const configPath = join(workspaceRoot, "hypervigilant.toml");
const projectPath = join(workspaceRoot, "PROJECT.md");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = portArgument ? Number(portArgument.slice("--port=".length)) : undefined;

if (!existsSync(projectPath) || !existsSync(configPath)) {
  console.log(`Configured ${await setupTheDoc()}`);
}

function cliCommand(args: string[]): string[] {
  const override = process.env.HYPERVIGILANT_BIN?.trim();
  if (override) return [override, ...args];
  const sourceCli = join(packageRoot, "src", "cli.ts");
  if (existsSync(sourceCli)) return ["bun", "run", sourceCli, ...args];
  const builtCli = join(packageRoot, "dist", "cli.js");
  if (existsSync(builtCli)) return ["bun", builtCli, ...args];
  return ["hypervigilant", ...args];
}

async function runCli(args: string[]): Promise<void> {
  const command = cliCommand(args);
  const processResult = Bun.spawn(command, {
    cwd: packageRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await processResult.exited;
  if (exitCode !== 0) throw new Error(`Hypervigilant exited with code ${exitCode}.`);
}

const activityFeed = new ActivityFeed();
const listenerId = "hypervigilant";
activityFeed.upsert({
  id: listenerId,
  label: "Hypervigilant",
  kind: "Agent listener",
  target: "PROJECT.md",
  state: "starting",
  summary: "Starting the document listener",
});

await runCli(["permissions", "yolo", workspaceRoot]);

let settleTimer: ReturnType<typeof setTimeout> | null = null;
function recordActivityLine(line: string): void {
  const transition = parseHypervigilantActivity(line);
  if (!transition) return;
  if (settleTimer) clearTimeout(settleTimer);
  activityFeed.update(listenerId, transition);
  if (transition.settlesToListening) {
    settleTimer = setTimeout(() => {
      activityFeed.update(listenerId, {
        state: "listening",
        summary: "Waiting for a saved change",
      });
      settleTimer = null;
    }, 2400);
  }
}

let watcherBecameReady = false;
let readyResolve: (() => void) | undefined;
let readyReject: ((error: Error) => void) | undefined;
const watcherReady = new Promise<void>((resolveReady, rejectReady) => {
  readyResolve = resolveReady;
  readyReject = rejectReady;
});
let stopping = false;
const watcher = Bun.spawn(cliCommand(["watch", workspaceRoot]), {
  cwd: packageRoot,
  env: process.env,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});

async function relayOutput(
  stream: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    target.write(value);
    pending += decoder.decode(value, { stream: true });
    if (pending.includes("Watching ")) {
      watcherBecameReady = true;
      readyResolve?.();
    }
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex >= 0) {
      recordActivityLine(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }
    pending = pending.slice(-4096);
  }
  if (pending) recordActivityLine(pending);
}

void relayOutput(watcher.stdout, process.stdout);
void relayOutput(watcher.stderr, process.stderr);
void watcher.exited.then((exitCode) => {
  if (settleTimer) clearTimeout(settleTimer);
  const stoppedCleanly = stopping || exitCode === 0;
  activityFeed.update(listenerId, {
    state: stoppedCleanly ? "offline" : "failed",
    summary: stoppedCleanly ? "Listener stopped" : "Listener process failed",
    event: stoppedCleanly ? "Listener stopped" : "Listener process failed",
  });
  if (!watcherBecameReady || exitCode !== 0) {
    readyReject?.(new Error(`Hypervigilant exited with code ${exitCode}.`));
  }
});

const readyTimeout = setTimeout(() => {
  readyReject?.(new Error("Hypervigilant did not become ready within 30 seconds."));
}, 30_000);
try {
  await watcherReady;
} finally {
  clearTimeout(readyTimeout);
}

let editorServer;
try {
  editorServer = await startTheDocServer({ port, activityFeed });
} catch (error) {
  watcher.kill("SIGTERM");
  await watcher.exited;
  throw error;
}
console.log("");
console.log(`Open ${editorServer.url}`);
console.log("Edit the page, then press Ctrl+S or Command+S.");
console.log("Each changed save dispatches the agent with automatic guarded file approval.");
console.log("");

const stop = (): void => {
  if (stopping) return;
  stopping = true;
  watcher.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const exitCode = await watcher.exited;
await editorServer.stop();
if (exitCode !== 0 && !stopping) process.exitCode = exitCode;
