import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CreateAgentOptions,
  LettaAgentClient,
  type LettaCodeClientOptions,
} from "@letta-ai/letta-agent-sdk";
import {
  type AppServerRawResponse,
  createAppServerClient,
} from "@letta-ai/letta-code/app-server-client";
import type { AgentRetrieveResponseMessage } from "@letta-ai/letta-code/app-server-protocol";
import { resolveCloudApiKey, resolveEnvironmentValue } from "./auth.ts";
import { connectionConfigSchema, type LettaConnectionConfig } from "./config.ts";

export type FilesystemAccess = "shared" | "diff-only";

export interface ConnectionPlan {
  connection: LettaConnectionConfig;
  connectionKey: string;
  description: string;
  filesystemAccess: FilesystemAccess;
  managementOptions: LettaCodeClientOptions;
  runtimeOptions: LettaCodeClientOptions;
  runtimeEnv: Record<string, string>;
  localBackendDir?: string;
}

export interface ConnectionClients {
  runtime: LettaAgentClient;
  createAgent(options?: CreateAgentOptions): Promise<string>;
  validateAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);
const LISTENING_RE = /^Listening on\s+(ws:\/\/\S+)\s*$/m;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_STARTUP_OUTPUT_CHARS = 32_768;

function normalizedServerUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function localBackendStorageRoot(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.LETTA_LOCAL_BACKEND_DIR?.trim() ||
      join(env.HOME?.trim() || homedir(), ".letta", "lc-local-backend"),
  );
}

export function connectionKey(
  connection: LettaConnectionConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  connection = connectionConfigSchema.parse(connection);
  if (connection.backend === "remote") {
    return `remote:${normalizedServerUrl(connection.url)}`;
  }
  if (connection.backend === "local") {
    const storageRoot = localBackendStorageRoot(env);
    const digest = createHash("sha256").update(storageRoot).digest("hex").slice(0, 16);
    return `local:${digest}`;
  }
  return "cloud";
}

export function connectionFilesystemAccess(connection: LettaConnectionConfig): FilesystemAccess {
  connection = connectionConfigSchema.parse(connection);
  return connection.backend === "remote" && !connection.sharedFilesystem ? "diff-only" : "shared";
}

export function resolveConnectionPlan(
  connection: LettaConnectionConfig,
  roots: string | string[],
  env: NodeJS.ProcessEnv = process.env,
): ConnectionPlan {
  connection = connectionConfigSchema.parse(connection);
  if (connection.backend === "cloud") {
    const apiKey = resolveCloudApiKey(roots, env);
    return {
      connection,
      connectionKey: "cloud",
      description: "Letta Cloud",
      filesystemAccess: "shared",
      managementOptions: { backend: "cloud", apiKey },
      runtimeOptions: {
        backend: "local",
        appServer: { harnessBackend: "api", pinGlobalAgent: false },
      },
      runtimeEnv: { LETTA_API_KEY: apiKey },
    };
  }

  if (connection.backend === "local") {
    const options: LettaCodeClientOptions = {
      backend: "local",
      appServer: {
        harnessBackend: "local",
        pinGlobalAgent: false,
        ...(connection.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: connection.requestTimeoutMs }
          : {}),
        ...(connection.startupTimeoutMs !== undefined
          ? { startupTimeoutMs: connection.startupTimeoutMs }
          : {}),
      },
    };
    return {
      connection,
      connectionKey: connectionKey(connection, env),
      description: "local App Server",
      filesystemAccess: "shared",
      managementOptions: options,
      runtimeOptions: options,
      runtimeEnv: {},
      localBackendDir: localBackendStorageRoot(env),
    };
  }

  const authToken = connection.authTokenEnv
    ? resolveEnvironmentValue(connection.authTokenEnv, roots, env)
    : undefined;
  const url = normalizedServerUrl(connection.url);
  const options: LettaCodeClientOptions = {
    backend: "remote",
    url,
    pinGlobalAgent: false,
    ...(authToken !== undefined ? { authToken } : {}),
    ...(connection.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: connection.requestTimeoutMs }
      : {}),
  };
  return {
    connection,
    connectionKey: `remote:${url}`,
    description: `remote App Server at ${url}`,
    filesystemAccess: connectionFilesystemAccess(connection),
    managementOptions: options,
    runtimeOptions: options,
    runtimeEnv: {},
  };
}

export async function createConnectionClients(plan: ConnectionPlan): Promise<ConnectionClients> {
  // Desktop can inject an internal local-server URL. Cloud-backed local
  // execution must target the public API selected by its Cloud key instead.
  if (plan.connectionKey === "cloud") delete process.env.LETTA_BASE_URL;
  if (plan.connection.backend === "local") {
    const requestTimeoutMs = plan.connection.requestTimeoutMs;
    const server = await startOwnedLocalAppServer(
      plan.connection.startupTimeoutMs,
      plan.localBackendDir,
    );
    const options: LettaCodeClientOptions = {
      backend: "remote",
      url: server.url,
      pinGlobalAgent: false,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    };
    const client = new LettaAgentClient(options);
    return {
      runtime: client,
      createAgent: (options) => client.createAgent(options),
      validateAgent: (agentId) =>
        probeAppServerAgent(server.url, undefined, agentId, requestTimeoutMs),
      close: server.close,
    };
  }
  const management = new LettaAgentClient(plan.managementOptions);
  const runtime =
    plan.managementOptions === plan.runtimeOptions
      ? management
      : new LettaAgentClient(plan.runtimeOptions);
  return {
    runtime,
    createAgent: (options) => management.createAgent(options),
    validateAgent:
      plan.connection.backend === "cloud"
        ? async (agentId) => {
            await management.agents.retrieve(agentId);
          }
        : (agentId) =>
            probeAppServerAgent(
              plan.runtimeOptions.backend === "remote" ? plan.runtimeOptions.url : "",
              plan.runtimeOptions.backend === "remote" ? plan.runtimeOptions.authToken : undefined,
              agentId,
              plan.runtimeOptions.backend === "remote"
                ? plan.runtimeOptions.requestTimeoutMs
                : undefined,
            ),
    close: async () => {},
  };
}

/**
 * Validate the agent through the same backend and App Server used for turns.
 */
export async function validateConnectionAgent(
  clients: ConnectionClients,
  agentId: string,
): Promise<void> {
  await clients.validateAgent(agentId);
}

async function probeAppServerAgent(
  url: string,
  authToken: string | undefined,
  agentId: string,
  requestTimeoutMs: number | undefined,
): Promise<void> {
  const client = createAppServerClient({
    url,
    ...(authToken !== undefined ? { authToken } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  });
  try {
    await client.connect();
    const response = await client.requestRaw<AgentRetrieveResponseMessage & AppServerRawResponse>(
      {
        type: "agent_retrieve",
        request_id: client.nextRequestId("agent_retrieve"),
        agent_id: agentId,
      },
      {
        predicate: (message): message is AgentRetrieveResponseMessage & AppServerRawResponse =>
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "agent_retrieve_response",
      },
    );
    if (!response.success || !response.agent) {
      throw new Error(response.error ?? `Failed to retrieve agent ${agentId}.`);
    }
  } finally {
    client.close();
  }
}

interface OwnedLocalAppServer {
  url: string;
  close(): Promise<void>;
}

function resolveLettaCli(): string {
  const configured = process.env.LETTA_CLI_PATH?.trim();
  if (configured) return configured;
  return require.resolve("@letta-ai/letta-code");
}

function localServerEnvironment(localBackendDir: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // An owned local backend must not inherit the invoking agent or Cloud route.
  delete env.AGENT_ID;
  delete env.AGENT_NAME;
  delete env.CONVERSATION_ID;
  delete env.MEMORY_DIR;
  delete env.LETTA_MEMORY_DIR;
  delete env.LETTA_API_KEY;
  delete env.LETTA_BASE_URL;
  if (localBackendDir) env.LETTA_LOCAL_BACKEND_DIR = localBackendDir;
  return env;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

/** Start one local backend for the whole Hypervigilant command lifecycle. */
async function startOwnedLocalAppServer(
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  localBackendDir?: string,
): Promise<OwnedLocalAppServer> {
  const child = spawn(
    process.execPath,
    [resolveLettaCli(), "--backend", "local", "app-server", "--listen", "ws://127.0.0.1:0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: localServerEnvironment(localBackendDir),
    },
  );
  const terminateOnParentExit = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const detachParentExit = () => process.off("exit", terminateOnParentExit);
  process.once("exit", terminateOnParentExit);
  child.once("exit", detachParentExit);
  let output = "";

  return await new Promise<OwnedLocalAppServer>((resolve, reject) => {
    let settled = false;
    const cleanupStartupListeners = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      void terminateChild(child).finally(detachParentExit);
      reject(error);
    };
    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      child.stdout?.resume();
      child.stderr?.resume();
      let closePromise: Promise<void> | null = null;
      resolve({
        url,
        close: () => (closePromise ??= terminateChild(child)),
      });
    };
    const inspect = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-MAX_STARTUP_OUTPUT_CHARS);
      const match = output.match(LISTENING_RE);
      if (match?.[1]) succeed(match[1]);
    };
    const onStdout = (chunk: unknown) => inspect(chunk);
    const onStderr = (chunk: unknown) => inspect(chunk);
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(
        new Error(
          `Local Letta App Server exited before listening (code=${code ?? "null"}, signal=${signal ?? "null"}).${output ? ` Output:\n${output.trim()}` : ""}`,
        ),
      );
    const timeout = setTimeout(
      () =>
        fail(
          new Error(
            `Timed out waiting for the local Letta App Server.${output ? ` Output:\n${output.trim()}` : ""}`,
          ),
        ),
      startupTimeoutMs,
    );
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
