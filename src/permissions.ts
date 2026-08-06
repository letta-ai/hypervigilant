import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AgentMode, HypervigilantConfig } from "./config.ts";
import { atomicWriteJSON } from "./state.ts";

export const PERMISSION_POLICIES = ["review", "ask", "yolo"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

const permissionStateSchema = z
  .object({
    version: z.literal(1),
    policy: z.enum(PERMISSION_POLICIES),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PermissionState = z.infer<typeof permissionStateSchema>;

export interface PermissionStatus {
  configured: PermissionPolicy;
  override: PermissionPolicy | null;
  effective: PermissionPolicy;
  path: string;
}

export function configuredPermissionPolicy(mode: AgentMode): PermissionPolicy {
  return mode === "review" ? "review" : "ask";
}

export function permissionStatePath(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
): string {
  return resolve(projectRoot, config.stateDir, "permissions.json");
}

async function loadPermissionOverride(path: string): Promise<PermissionPolicy | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read permission state at ${path}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`Permission state at ${path} is not valid JSON. Run permissions reset.`);
  }
  const parsed = permissionStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Permission state at ${path} is invalid. Run permissions reset. ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data.policy;
}

export async function getPermissionStatus(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "mode" | "stateDir">,
): Promise<PermissionStatus> {
  const path = permissionStatePath(projectRoot, config);
  const configured = configuredPermissionPolicy(config.mode);
  const override = await loadPermissionOverride(path);
  return {
    configured,
    override,
    effective: override ?? configured,
    path,
  };
}

export async function setPermissionPolicy(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
  policy: PermissionPolicy,
): Promise<PermissionState> {
  const state: PermissionState = {
    version: 1,
    policy,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJSON(permissionStatePath(projectRoot, config), state);
  return state;
}

export async function resetPermissionPolicy(
  projectRoot: string,
  config: Pick<HypervigilantConfig, "stateDir">,
): Promise<void> {
  await rm(permissionStatePath(projectRoot, config), { force: true });
}

export function permissionAgentMode(policy: PermissionPolicy): AgentMode {
  return policy === "review" ? "review" : "edit";
}
