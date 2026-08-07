import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultWorkspaceRoot } from "./setup.ts";

const workspaceRoot = resolve(defaultWorkspaceRoot);
const statePath = join(workspaceRoot, ".hypervigilant", "state.json");
if (!(await Bun.file(statePath).exists())) {
  throw new Error("Start the Obsidian watcher and wait for its baseline first.");
}

await mkdir(join(workspaceRoot, "concepts"), { recursive: true });
await writeFile(
  join(workspaceRoot, "concepts", "shipping-is-done.md"),
  `# Shipping is done

Once a source commit exists, users have the feature. This follows from [[deployment receipt]].
`,
  "utf8",
);

await writeFile(
  join(workspaceRoot, "projects", "field-guide.md"),
  `---
type: project
status: complete
---

# Field guide

## Status

Complete and publicly available.

## Next step

Record the still-pending deployment in [[projects/publishing-log|Publishing log]].
`,
  "utf8",
);

console.log("Saved one concept change and one project change.");
console.log("The batch should reach the default, connections, claims, and continuity conversations.");
