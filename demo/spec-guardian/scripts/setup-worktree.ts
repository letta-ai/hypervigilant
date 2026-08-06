import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../../src/config.ts";

const defaultDestination = "/tmp/hypervigilant-spec-guardian-worktree";
const pathIndex = process.argv.indexOf("--path");
const destination = resolve(pathIndex >= 0 ? (process.argv[pathIndex + 1] ?? "") : defaultDestination);
const force = process.argv.includes("--force");
if (pathIndex >= 0 && !process.argv[pathIndex + 1]) {
	throw new Error("--path requires a destination.");
}

async function git(args: string[]): Promise<void> {
	const process = Bun.spawn({
		cmd: ["git", ...args],
		cwd: destination,
		stdout: "inherit",
		stderr: "pipe",
	});
	const stderr = await new Response(process.stderr).text();
	if ((await process.exited) !== 0) {
		throw new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim()}`);
	}
}

if (force) await rm(destination, { recursive: true, force: true });
try {
	await mkdir(destination, { recursive: false });
} catch (error) {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EEXIST") {
		throw new Error(`${destination} already exists. Use --force to replace this disposable demo.`);
	}
	if (code !== "ENOENT") throw error;
	await mkdir(dirname(destination), { recursive: true });
	await mkdir(destination);
}

const demoRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(demoRoot, "..", "..");
const rootConfig = await loadConfig(join(repositoryRoot, "hypervigilant.toml"));
const template = await readFile(join(demoRoot, "hypervigilant.toml.example"), "utf8");
const generatedConfig = template
	.replace("agent-REPLACE-ME", rootConfig.agentId)
	.replace("enabled = false", "enabled = true");

await cp(join(demoRoot, "SPEC.md"), join(destination, "SPEC.md"));
await cp(join(demoRoot, "src"), join(destination, "src"), { recursive: true });
await cp(join(demoRoot, "tests"), join(destination, "tests"), { recursive: true });
await mkdir(join(destination, "scripts"));
await cp(
	join(demoRoot, "scripts", "introduce-drift.ts"),
	join(destination, "scripts", "introduce-drift.ts"),
);
await cp(join(demoRoot, "scripts", "reset.ts"), join(destination, "scripts", "reset.ts"));
await writeFile(
	join(destination, ".gitignore"),
	".hypervigilant/\nhypervigilant.toml\n",
	"utf8",
);
await writeFile(join(destination, "hypervigilant.toml"), generatedConfig, "utf8");

await git(["init", "-b", "main"]);
await git(["add", ".gitignore", "SPEC.md", "src", "tests", "scripts"]);
await git(["commit", "-m", "Initialize spec guardian worktree demo"]);

console.log(`Created standalone worktree demo at ${destination}`);
console.log(`Start it with: bun run dev -- watch ${JSON.stringify(destination)}`);
console.log("Use the printed 'Edit watched files in' path for introduce-drift.ts.");
