import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLOUD_KEY_PREFIX = "sk-let-";

interface DotEnvKey {
  path: string;
  value: string;
}

function readDotEnvApiKey(cwd: string): DotEnvKey | null {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return null;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?LETTA_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1]?.trim() ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    return { path, value };
  }
  return null;
}

/** Resolve a Letta Cloud key without accepting an inherited local-server UUID. */
export function resolveCloudApiKey(
  roots: string | string[] = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const root of [...new Set(Array.isArray(roots) ? roots : [roots])]) {
    const fromDotEnv = readDotEnvApiKey(root);
    if (!fromDotEnv) continue;
    if (fromDotEnv.value.startsWith(CLOUD_KEY_PREFIX)) return fromDotEnv.value;
    throw new Error(
      `LETTA_API_KEY in ${fromDotEnv.path} is not a Letta Cloud key. Set an sk-let- key.`,
    );
  }

  const ambient = env.LETTA_API_KEY?.trim();
  if (ambient?.startsWith(CLOUD_KEY_PREFIX)) return ambient;

  if (ambient) {
    throw new Error(
      "LETTA_API_KEY is not a Letta Cloud key. Set an sk-let- key in .env or your shell.",
    );
  }
  throw new Error("LETTA_API_KEY is required. Set an sk-let- key in .env or your shell.");
}
