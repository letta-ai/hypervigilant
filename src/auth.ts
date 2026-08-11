import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLOUD_KEY_PREFIX = "sk-let-";

interface DotEnvKey {
  path: string;
  value: string;
}

function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closingIndex = value.indexOf(quote, 1);
    if (closingIndex >= 0) {
      const remainder = value.slice(closingIndex + 1).trim();
      if (!remainder || remainder.startsWith("#")) {
        return value.slice(1, closingIndex);
      }
    }
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function readDotEnvValue(cwd: string, name: string): DotEnvKey | null {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return null;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const exportMatch = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const variable = exportMatch?.[1] ?? match?.[1];
    if (variable !== name) continue;
    const rawValue = exportMatch?.[2] ?? match?.[2];
    if (rawValue === undefined) continue;
    return { path, value: parseDotEnvValue(rawValue) };
  }
  return null;
}

/** Resolve an explicitly named secret without ever returning a different variable. */
export function resolveEnvironmentValue(
  name: string,
  roots: string | string[] = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const root of [...new Set(Array.isArray(roots) ? roots : [roots])]) {
    const fromDotEnv = readDotEnvValue(root, name);
    if (!fromDotEnv) continue;
    if (fromDotEnv.value) return fromDotEnv.value;
    throw new Error(`${name} in ${fromDotEnv.path} is empty.`);
  }

  const ambient = env[name]?.trim();
  if (ambient) return ambient;
  throw new Error(`${name} is required but was not found in .env or the process environment.`);
}

/** Resolve a Letta Cloud key without accepting an inherited local-server UUID. */
export function resolveCloudApiKey(
  roots: string | string[] = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const root of [...new Set(Array.isArray(roots) ? roots : [roots])]) {
    const fromDotEnv = readDotEnvValue(root, "LETTA_API_KEY");
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
