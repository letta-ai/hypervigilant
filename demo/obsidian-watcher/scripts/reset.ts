import { rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { copySampleVault, defaultWorkspaceRoot } from "./setup.ts";

export async function resetSampleVault(
  workspaceRoot = resolve(defaultWorkspaceRoot),
): Promise<void> {
  await copySampleVault(workspaceRoot, true);
  await rm(join(workspaceRoot, "inbox", "field-guide-release.md"), { force: true });
  try {
    await rmdir(join(workspaceRoot, "inbox"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

if (import.meta.main) {
  await resetSampleVault();
  console.log("Restored the sample notes without changing configuration or Hypervigilant state.");
}
