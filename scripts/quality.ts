import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GENERATED_FILES = ["dist/cli.js", "specs/STATUS.md"] as const;

async function digest(relPath: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(join(ROOT, relPath)))
      .digest("hex");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function generatedDigests(): Promise<Map<string, string | null>> {
  return new Map(
    await Promise.all(GENERATED_FILES.map(async (path) => [path, await digest(path)] as const)),
  );
}

async function run(label: string, command: string[]): Promise<void> {
  console.log(`\n[quality] ${label}`);
  const child = Bun.spawn({
    cmd: command,
    cwd: ROOT,
    env: { ...process.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with status ${exitCode}.`);
  }
}

async function main(): Promise<void> {
  const generatedBefore = await generatedDigests();
  await run("specs, types, lint, unit tests, and build", ["bun", "run", "check"]);
  await run("demo tests", ["bun", "run", "test:demo"]);
  await run("dependency audit", ["bun", "audit"]);
  await run("package manifest", ["npm", "pack", "--dry-run"]);
  await run("unstaged diff whitespace", ["git", "diff", "--check"]);
  await run("staged diff whitespace", ["git", "diff", "--cached", "--check"]);

  const generatedAfter = await generatedDigests();
  const changed = GENERATED_FILES.filter(
    (path) => generatedBefore.get(path) !== generatedAfter.get(path),
  );
  if (changed.length > 0) {
    throw new Error(
      `The quality gate regenerated ${changed.join(", ")}. Inspect and keep those generated changes, then rerun the gate.`,
    );
  }
  console.log("\n[quality] All repository gates passed.");
}

try {
  await main();
} catch (error) {
  console.error(`[quality] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
