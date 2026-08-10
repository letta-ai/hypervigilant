import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultWorkspaceRoot } from "./setup.ts";

export interface IntroducedVaultChange {
  handoffPath: string;
  publishingLogPath: string;
}

export async function introduceVaultChange(
  workspaceRoot = resolve(defaultWorkspaceRoot),
  recordedAt = new Date(),
): Promise<IntroducedVaultChange> {
  const statePath = join(workspaceRoot, ".hypervigilant", "state.json");
  if (!(await Bun.file(statePath).exists())) {
    throw new Error("Start the Obsidian watcher and wait for its baseline first.");
  }

  const publishingLogPath = join(workspaceRoot, "projects", "publishing-log.md");
  const handoffPath = join(workspaceRoot, "Inbox", "field-guide-release.md");
  await mkdir(join(workspaceRoot, "Inbox"), { recursive: true });

  await writeFile(
    publishingLogPath,
    `---
type: project-log
status: verified
---

# Publishing log

## Status

The field guide has a verified public deployment.

## Receipt

- URL: https://example.com/guides/field-guide
- Deployment: demo-deploy-1042
- Readback: HTTP 200 with the marker \`Field guide\`
- Recorded: ${recordedAt.toISOString()}

## Next step

Propagate this receipt into the project state.
`,
    "utf8",
  );

  await writeFile(
    handoffPath,
    `---
type: inbox
status: open
---

# Field guide release

The verified publication receipt is in [[projects/publishing-log|Publishing log]].

@watcher Propagate the verified publication into [[projects/field-guide|Field guide]] and [[index|Index]]. Set the project's next step to announce the release. Preserve this handoff as source. Record one receipt in [[Watcher Inbox]].
`,
    "utf8",
  );

  return { handoffPath, publishingLogPath };
}

if (import.meta.main) {
  await introduceVaultChange();
  console.log("Saved a verified publishing receipt and one explicit watcher handoff.");
  console.log("The steward should update project state and the index, then record one receipt.");
}
