import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const demoRoot = resolve(import.meta.dir, "..");
const argumentIndex = process.argv.indexOf("--agent-id");
let agentId = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "edit";
if (mode !== "review" && mode !== "edit") {
	throw new Error('Mode must be "review" or "edit".');
}

if (!agentId) {
	const rootConfigPath = resolve(demoRoot, "..", "..", "hypervigilant.toml");
	try {
		const rootConfig = Bun.TOML.parse(await readFile(rootConfigPath, "utf8"));
		agentId = typeof rootConfig.agent_id === "string" ? rootConfig.agent_id : undefined;
	} catch {
		throw new Error(
			`Could not read an agent ID from ${rootConfigPath}. Pass --agent-id agent-xxx instead.`,
		);
	}
}

if (!agentId || !agentId.startsWith("agent-") || agentId === "agent-REPLACE-ME") {
	throw new Error("Provide a real Letta agent ID with --agent-id agent-xxx.");
}

const templatePath = join(demoRoot, "hypervigilant.toml.example");
const configPath = join(demoRoot, "hypervigilant.toml");
const template = await readFile(templatePath, "utf8");
const config = template
	.replace("agent-REPLACE-ME", agentId)
	.replace(/mode = "(?:review|edit)"/, `mode = "${mode}"`);
await writeFile(configPath, config, "utf8");
console.log(`Configured ${configPath}`);
