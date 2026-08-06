import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configuredPermissionPolicy,
  getPermissionStatus,
  permissionAgentMode,
  permissionStatePath,
  resetPermissionPolicy,
  setPermissionPolicy,
} from "../src/permissions.ts";
import { approvalForPolicy } from "../src/watch.ts";

const root = join(import.meta.dirname, "tmp-permissions");
const config = { mode: "edit" as const, stateDir: ".hypervigilant" };

describe("permission manager", () => {
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps existing modes to backward-compatible policies", () => {
    expect(configuredPermissionPolicy("review")).toBe("review");
    expect(configuredPermissionPolicy("edit")).toBe("ask");
    expect(permissionAgentMode("review")).toBe("review");
    expect(permissionAgentMode("ask")).toBe("edit");
    expect(permissionAgentMode("yolo")).toBe("edit");
  });

  it("uses the configured policy when no override exists", async () => {
    expect(await getPermissionStatus(root, config)).toEqual({
      configured: "ask",
      override: null,
      effective: "ask",
      path: permissionStatePath(root, config),
    });
    expect(
      await getPermissionStatus(root, { mode: "review", stateDir: ".hypervigilant" }),
    ).toMatchObject({ configured: "review", override: null, effective: "review" });
  });

  it("persists every override atomically and resets it", async () => {
    for (const policy of ["review", "ask", "yolo"] as const) {
      const state = await setPermissionPolicy(root, config, policy);
      expect(state.policy).toBe(policy);
      expect((await getPermissionStatus(root, config)).effective).toBe(policy);
      expect(JSON.parse(await readFile(permissionStatePath(root, config), "utf8")).policy).toBe(
        policy,
      );
    }
    await resetPermissionPolicy(root, config);
    expect((await getPermissionStatus(root, config)).effective).toBe("ask");
  });

  it("fails closed on malformed or unsupported state", async () => {
    const path = permissionStatePath(root, config);
    await mkdir(join(root, ".hypervigilant"), { recursive: true });
    await writeFile(path, "not-json\n");
    await expect(getPermissionStatus(root, config)).rejects.toThrow("not valid JSON");

    await writeFile(
      path,
      `${JSON.stringify({ version: 1, policy: "unrestricted", updatedAt: new Date().toISOString() })}\n`,
    );
    await expect(getPermissionStatus(root, config)).rejects.toThrow("Permission state");
  });

  it("routes ask to the interactive callback and yolo to automatic approval", async () => {
    const interactive = mock(async () => ({ behavior: "deny" as const, message: "no" }));
    const statuses: string[] = [];
    const options = {
      onToolApproval: interactive,
      onStatus: (message: string) => statuses.push(message),
    };

    expect(approvalForPolicy("review", options)).toBeUndefined();
    expect(approvalForPolicy("ask", options)).toBe(interactive);
    const yolo = approvalForPolicy("yolo", options);
    expect(await yolo?.("Edit", { file_path: "/project/file.ts" })).toEqual({
      behavior: "allow",
      message: "Allowed by Hypervigilant YOLO policy",
    });
    expect(interactive).not.toHaveBeenCalled();
    expect(statuses).toEqual(["YOLO auto-approved Edit: /project/file.ts"]);
  });
});
