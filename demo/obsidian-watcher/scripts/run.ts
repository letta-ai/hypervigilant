import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultWorkspaceRoot, parseSetupArguments, setupObsidianWatcher } from "./setup.ts";

const demoRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(demoRoot, "..", "..");
const args = parseSetupArguments(process.argv.slice(2));
const vaultRoot = resolve(args.vaultRoot ?? defaultWorkspaceRoot);

const setup = await setupObsidianWatcher({
  vaultRoot,
  agentId: args.agentId,
  force: args.force,
  seedSample: args.vaultRoot === undefined,
});

console.log(
  setup.createdAgent
    ? `Created dedicated Letta Auto agent ${setup.agentId}.`
    : `Using configured agent ${setup.agentId}.`,
);
console.log(`Watching ${vaultRoot}`);

function cliCommand(cliArgs: string[]): string[] {
  const override = process.env.HYPERVIGILANT_BIN?.trim();
  if (override) return [override, ...cliArgs];
  const sourceCli = join(packageRoot, "src", "cli.ts");
  if (existsSync(sourceCli)) return ["bun", "run", sourceCli, ...cliArgs];
  const builtCli = join(packageRoot, "dist", "cli.js");
  if (existsSync(builtCli)) return ["bun", builtCli, ...cliArgs];
  return ["hypervigilant", ...cliArgs];
}

let stopping = false;
const watcher = Bun.spawn(cliCommand(["watch", vaultRoot]), {
  cwd: packageRoot,
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  watcher.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const exitCode = await watcher.exited;
if (exitCode !== 0 && !stopping) process.exitCode = exitCode;
