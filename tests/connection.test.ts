import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import {
  connectionFilesystemAccess,
  connectionKey,
  createConnectionClients,
  resolveConnectionPlan,
  validateConnectionAgent,
} from "../src/connection.ts";

describe("Letta connection planning", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hypervigilant-connection-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the existing Cloud management and local-execution split", async () => {
    await writeFile(join(root, ".env"), "LETTA_API_KEY=sk-let-project\n");
    const plan = resolveConnectionPlan({ backend: "cloud" }, root, {
      LETTA_API_KEY: "sk-let-ambient",
    });
    expect(plan.connectionKey).toBe("cloud");
    expect(plan.filesystemAccess).toBe("shared");
    expect(plan.managementOptions).toEqual({
      backend: "cloud",
      apiKey: "sk-let-project",
    });
    expect(plan.runtimeOptions).toEqual({
      backend: "local",
      appServer: { harnessBackend: "api", pinGlobalAgent: false },
    });
    expect(plan.runtimeEnv).toEqual({ LETTA_API_KEY: "sk-let-project" });
  });

  it("uses a command-scoped local App Server without requiring Cloud credentials", () => {
    const plan = resolveConnectionPlan(
      { backend: "local", requestTimeoutMs: 90_000, startupTimeoutMs: 45_000 },
      root,
      { LETTA_API_KEY: "not-a-cloud-key" },
    );
    expect(plan.connectionKey).toMatch(/^local:[0-9a-f]{16}$/);
    expect(plan.runtimeEnv).toEqual({});
    expect(plan.managementOptions).toBe(plan.runtimeOptions);
    expect(plan.runtimeOptions).toEqual({
      backend: "local",
      appServer: {
        harnessBackend: "local",
        pinGlobalAgent: false,
        requestTimeoutMs: 90_000,
        startupTimeoutMs: 45_000,
      },
    });
  });

  it("connects to an authenticated remote App Server without storing its token", async () => {
    await writeFile(join(root, ".env"), "APP_SERVER_TOKEN=project-secret\n");
    const connection = {
      backend: "remote" as const,
      url: "wss://example.internal:4500/",
      authTokenEnv: "APP_SERVER_TOKEN",
      requestTimeoutMs: 120_000,
      sharedFilesystem: false,
    };
    const plan = resolveConnectionPlan(connection, root, {
      APP_SERVER_TOKEN: "ambient-secret",
    });
    expect(plan.connectionKey).toBe("remote:wss://example.internal:4500");
    expect(plan.description).toBe("remote App Server at wss://example.internal:4500");
    expect(plan.filesystemAccess).toBe("diff-only");
    expect(plan.runtimeEnv).toEqual({});
    expect(plan.managementOptions).toEqual({
      backend: "remote",
      url: "wss://example.internal:4500",
      authToken: "project-secret",
      requestTimeoutMs: 120_000,
      pinGlobalAgent: false,
    });
    expect(connectionKey(connection)).toBe(plan.connectionKey);
  });

  it("requires an explicitly configured token variable but allows unauthenticated loopback", () => {
    expect(() =>
      resolveConnectionPlan(
        {
          backend: "remote",
          url: "wss://example.internal:4500",
          authTokenEnv: "MISSING_TOKEN",
          sharedFilesystem: false,
        },
        root,
        {},
      ),
    ).toThrow("MISSING_TOKEN is required");

    const loopback = resolveConnectionPlan(
      {
        backend: "remote",
        url: "ws://127.0.0.1:4500",
        sharedFilesystem: false,
      },
      root,
      {},
    );
    expect(loopback.managementOptions).not.toHaveProperty("authToken");
  });

  it("enables filesystem tools only for local execution or an explicit shared remote root", () => {
    expect(connectionFilesystemAccess({ backend: "cloud" })).toBe("shared");
    expect(connectionFilesystemAccess({ backend: "local" })).toBe("shared");
    expect(
      connectionFilesystemAccess({
        backend: "remote",
        url: "ws://127.0.0.1:4500",
        sharedFilesystem: false,
      }),
    ).toBe("diff-only");
    expect(
      connectionFilesystemAccess({
        backend: "remote",
        url: "ws://127.0.0.1:4500",
        sharedFilesystem: true,
      }),
    ).toBe("shared");
  });

  it("binds local conversation identity to the selected local storage root", () => {
    expect(connectionKey({ backend: "local" }, { LETTA_LOCAL_BACKEND_DIR: "/tmp/a" })).not.toBe(
      connectionKey({ backend: "local" }, { LETTA_LOCAL_BACKEND_DIR: "/tmp/b" }),
    );
  });

  it("starts one isolated local App Server, probes it, and waits for shutdown", async () => {
    const localBackendDir = join(root, "local-backend");
    const plan = resolveConnectionPlan({ backend: "local" }, root, {
      LETTA_LOCAL_BACKEND_DIR: localBackendDir,
    });
    const clients = await createConnectionClients(plan);
    try {
      await expect(validateConnectionAgent(clients, "agent-local-does-not-exist")).rejects.toThrow(
        "not found",
      );
    } finally {
      await clients.close();
    }
    expect(plan.localBackendDir).toBe(localBackendDir);
  }, 30_000);
});

describe("agent connection validation", () => {
  it("uses the command-scoped App Server probe", async () => {
    const validateAgent = mock(async (_agentId: string) => {});
    const clients = {
      runtime: {},
      createAgent: async () => "agent-created",
      validateAgent,
      close: async () => {},
    } as unknown as {
      runtime: LettaAgentClient;
      createAgent(): Promise<string>;
      validateAgent(agentId: string): Promise<void>;
      close(): Promise<void>;
    };
    await validateConnectionAgent(clients, "agent-local-test");
    expect(validateAgent).toHaveBeenCalledWith("agent-local-test");
  });

  it("propagates authoritative probe failures", async () => {
    const validateAgent = mock(async (_agentId: string) => {
      throw new Error("agent unavailable");
    });
    const clients = {
      runtime: {},
      createAgent: async () => "agent-created",
      validateAgent,
      close: async () => {},
    } as unknown as {
      runtime: LettaAgentClient;
      createAgent(): Promise<string>;
      validateAgent(agentId: string): Promise<void>;
      close(): Promise<void>;
    };
    expect(validateConnectionAgent(clients, "agent-test")).rejects.toThrow("agent unavailable");
  });
});
