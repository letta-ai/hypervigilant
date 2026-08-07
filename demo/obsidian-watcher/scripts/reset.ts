import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { copySampleVault, defaultWorkspaceRoot } from "./setup.ts";

const workspaceRoot = resolve(defaultWorkspaceRoot);

await copySampleVault(workspaceRoot, true);
await rm(join(workspaceRoot, "concepts", "shipping-is-done.md"), { force: true });
console.log("Restored the sample notes without changing configuration or Hypervigilant state.");
