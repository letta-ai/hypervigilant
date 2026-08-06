import { rm } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const outdir = join(projectRoot, "dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(projectRoot, "src", "cli.ts")],
  outdir,
  target: "bun",
  packages: "external",
  naming: "cli.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${join(outdir, "cli.js")}`);
