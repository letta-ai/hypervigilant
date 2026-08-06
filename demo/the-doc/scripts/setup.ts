import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const demoRoot = resolve(import.meta.dir, "..");
const workspaceRoot = join(demoRoot, "workspace");

export async function setupTheDoc(agentId?: string): Promise<string> {
  let resolvedAgentId = agentId;
  if (!resolvedAgentId) {
    const rootConfigPath = resolve(demoRoot, "..", "..", "hypervigilant.toml");
    try {
      const rootConfig = Bun.TOML.parse(await readFile(rootConfigPath, "utf8"));
      resolvedAgentId = typeof rootConfig.agent_id === "string" ? rootConfig.agent_id : undefined;
    } catch {
      throw new Error(
        `Could not read an agent ID from ${rootConfigPath}. Pass --agent-id agent-xxx instead.`,
      );
    }
  }

  if (
    !resolvedAgentId ||
    !resolvedAgentId.startsWith("agent-") ||
    resolvedAgentId === "agent-REPLACE-ME"
  ) {
    throw new Error("Provide a Letta agent ID with --agent-id agent-xxx.");
  }

  await mkdir(workspaceRoot, { recursive: true });
  const projectPath = join(workspaceRoot, "PROJECT.md");
  try {
    await copyFile(join(demoRoot, "PROJECT.md.example"), projectPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const configTemplatePath = join(demoRoot, "hypervigilant.toml.example");
  const configPath = join(workspaceRoot, "hypervigilant.toml");
  const template = await readFile(configTemplatePath, "utf8");
  await writeFile(configPath, template.replace("agent-REPLACE-ME", resolvedAgentId), "utf8");
  return configPath;
}

if (import.meta.main) {
  const argumentIndex = process.argv.indexOf("--agent-id");
  const agentId = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  console.log(`Configured ${await setupTheDoc(agentId)}`);
}
