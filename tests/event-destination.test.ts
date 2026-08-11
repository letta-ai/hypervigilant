import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LettaAgentClient,
  LettaCodeSession,
  SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { startSyntheticReceiver } from "../demo/http-event-receiver/receiver.ts";
import { configSchema } from "../src/config.ts";
import {
  assertPendingDestinationLease,
  deliverPendingHttpEvent,
  enqueueEvent,
  finalizePendingEvent,
  recordHttpReceipt,
} from "../src/event-destination.ts";
import {
  EVENT_RECEIPT_SCHEMA,
  type EventReceipt,
  FILE_EVENT_SCHEMA,
  hashEventBody,
  type PendingEvent,
  parsePendingPayload,
} from "../src/event-schema.ts";
import { initCommand } from "../src/init.ts";
import { type HypervigilantState, StateStore, stateSchema } from "../src/state.ts";
import { statusCommand } from "../src/status.ts";
import { scanCommand } from "../src/watch.ts";
import type { FileChange } from "../src/watcher.ts";

const roots: string[] = [];
const receivers: Array<{ stop(): Promise<void> }> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(25);
  }
}

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function eventOnlyConfig(url = "http://127.0.0.1:9999/v1/events") {
  return configSchema.parse({
    version: 1,
    project: "event-project",
    destinations: {
      agent: false,
      http: {
        url,
        authTokenEnv: "EVENT_TOKEN",
        requestTimeoutMs: 1_000,
      },
    },
  });
}

function emptyState(): HypervigilantState {
  return {
    version: 1,
    connectionKey: "agent-disabled",
    projectConversation: { conversationId: null },
    fileConversations: {},
    snapshots: {},
    binaryBaselineEstablished: true,
  };
}

function textAddition(): FileChange {
  return {
    relPath: "notes/example.md",
    absPath: "/project/notes/example.md",
    event: "add",
    kind: "text",
    oldContent: null,
    newContent: "new\n",
    hash: hashEventBody("new\n"),
    size: 4,
  };
}

function receiptFor(state: HypervigilantState): EventReceipt {
  const pending = state.eventOutput?.pending;
  if (!pending) throw new Error("missing pending event");
  return {
    schema: EVENT_RECEIPT_SCHEMA,
    accepted: true,
    eventId: pending.eventId,
    bodySha256: pending.bodySha256,
    sourceId: "synthetic:test",
    sourceSequence: 1,
    acceptedAt: "2026-08-11T00:00:01.000Z",
  };
}

function requiredPending(state: HypervigilantState): PendingEvent {
  const pending = state.eventOutput?.pending;
  if (!pending) throw new Error("missing pending event");
  return pending;
}

function agentClient(
  success: boolean,
  onSessionOptions?: (options: Record<string, unknown>) => void,
): LettaAgentClient {
  const session = {
    conversationId: "conv-event-test",
    async send() {},
    async *stream() {
      yield {
        type: "result",
        success,
        result: success ? "accepted" : undefined,
        errorDetail: success ? undefined : "synthetic agent failure",
        durationMs: 1,
        conversationId: "conv-event-test",
      } as SDKResultMessage;
    },
    async recoverPendingApprovals() {
      return { recovered: true, unsupported: false };
    },
    close() {},
  } as unknown as LettaCodeSession;
  return {
    createSession(_agentId: string, options: Record<string, unknown>) {
      onSessionOptions?.(options);
      return session;
    },
    resumeSession() {
      return session;
    },
  } as unknown as LettaAgentClient;
}

describe("HTTP event destination", () => {
  it("builds a strict, stable event and advances snapshots only after a receipt", () => {
    const config = eventOnlyConfig();
    const queued = enqueueEvent(
      emptyState(),
      config,
      [textAddition()],
      "agent-disabled",
      new Date("2026-08-11T00:00:00.000Z"),
    );
    const pending = queued.eventOutput?.pending;
    expect(pending).toBeDefined();
    expect(queued.snapshots).toEqual({});
    expect(pending?.sequence).toBe(1);
    expect(queued.eventOutput?.nextSequence).toBe(2);

    if (!pending) throw new Error("missing pending event");
    const payload = parsePendingPayload(pending);
    expect(payload.schema).toBe(FILE_EVENT_SCHEMA);
    expect(payload.changes).toEqual([
      {
        path: "notes/example.md",
        event: "add",
        before: null,
        after: {
          sha256: hashEventBody("new\n"),
          bytes: 4,
          kind: "text",
          text: "new\n",
        },
      },
    ]);
    expect(stateSchema.safeParse(queued).success).toBe(true);
    expect(
      stateSchema.safeParse({
        ...queued,
        eventOutput: {
          ...queued.eventOutput,
          pending: { ...pending, bodySha256: "f".repeat(64) },
        },
      }).success,
    ).toBe(false);

    const accepted = recordHttpReceipt(queued, receiptFor(queued));
    const finalized = finalizePendingEvent(accepted);
    expect(finalized.eventOutput?.pending).toBeUndefined();
    expect(finalized.eventOutput?.lastReceipt?.sourceId).toBe("synthetic:test");
    expect(finalized.snapshots["notes/example.md"]).toMatchObject({
      hash: hashEventBody("new\n"),
      size: 4,
      kind: "text",
      content: "new\n",
    });
  });

  it("preserves text-to-binary transitions without storing binary bytes", () => {
    const state: HypervigilantState = {
      ...emptyState(),
      snapshots: {
        "asset.bin": {
          path: "asset.bin",
          hash: hashEventBody("old"),
          size: 3,
          kind: "text",
          content: "old",
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
      },
    };
    const queued = enqueueEvent(
      state,
      eventOnlyConfig(),
      [
        {
          relPath: "asset.bin",
          absPath: "/project/asset.bin",
          event: "change",
          kind: "binary",
          oldContent: "old",
          newContent: null,
          hash: "c".repeat(64),
          size: 8,
        },
      ],
      "agent-disabled",
    );
    expect(parsePendingPayload(requiredPending(queued)).changes[0]).toEqual({
      path: "asset.bin",
      event: "change",
      before: {
        sha256: hashEventBody("old"),
        bytes: 3,
        kind: "text",
        text: "old",
      },
      after: { sha256: "c".repeat(64), bytes: 8, kind: "binary" },
    });
    expect(queued.eventOutput?.pending?.body).not.toContain("binary bytes");
  });

  it("sends bearer auth and rejects status-only or mismatched acknowledgements", async () => {
    const queued = enqueueEvent(
      emptyState(),
      eventOnlyConfig(),
      [textAddition()],
      "agent-disabled",
    );
    const pending = requiredPending(queued);
    const token = "private-token-value";
    let observedHeaders: Headers | undefined;
    let observedRedirect: RequestInit["redirect"];
    const matchingReceipt = receiptFor(queued);
    const accepted = await deliverPendingHttpEvent(pending, {
      env: { EVENT_TOKEN: token },
      async fetch(_input, init) {
        observedHeaders = new Headers(init?.headers);
        observedRedirect = init?.redirect;
        return Response.json(matchingReceipt);
      },
    });
    expect(accepted).toEqual(matchingReceipt);
    expect(observedHeaders?.get("authorization")).toBe(`Bearer ${token}`);
    expect(observedHeaders?.get("idempotency-key")).toBe(pending.eventId);
    expect(observedHeaders?.get("x-hypervigilant-body-sha256")).toBe(pending.bodySha256);
    expect(observedRedirect).toBe("error");
    expect(JSON.stringify(queued)).not.toContain(token);

    let redactedError = "";
    try {
      await deliverPendingHttpEvent(pending, {
        env: { EVENT_TOKEN: token },
        async fetch() {
          throw new Error(`transport accidentally echoed ${token}`);
        },
      });
    } catch (error) {
      redactedError = (error as Error).message;
    }
    expect(redactedError).toContain("[REDACTED]");
    expect(redactedError).not.toContain(token);

    await expect(
      deliverPendingHttpEvent(pending, {
        env: { EVENT_TOKEN: token },
        async fetch() {
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow("status 204");

    await expect(
      deliverPendingHttpEvent(pending, {
        env: { EVENT_TOKEN: token },
        async fetch() {
          return Response.json({ ...matchingReceipt, bodySha256: "d".repeat(64) });
        },
      }),
    ).rejects.toThrow("does not match");

    await expect(
      deliverPendingHttpEvent(pending, {
        env: { EVENT_TOKEN: token },
        async fetch() {
          return new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        },
      }),
    ).rejects.toThrow("non-JSON receipt");

    await expect(
      deliverPendingHttpEvent(pending, {
        env: { EVENT_TOKEN: token },
        async fetch() {
          return new Response(new Uint8Array(65_537), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    ).rejects.toThrow("oversized receipt");

    const httpDestination = pending.httpDestination;
    if (!httpDestination) throw new Error("missing HTTP destination");
    await expect(
      deliverPendingHttpEvent(
        {
          ...pending,
          httpDestination: { ...httpDestination, requestTimeoutMs: 10 },
        },
        {
          env: { EVENT_TOKEN: token },
          async fetch(_input, init) {
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
          },
        },
      ),
    ).rejects.toThrow("timed out after 10ms");
  });

  it("gets one stable receiver receipt for exact replay and a conflict for divergent replay", async () => {
    const token = "receiver-contract-token";
    const receiver = startSyntheticReceiver({ token, sourceId: "synthetic:replay" });
    receivers.push(receiver);
    const config = eventOnlyConfig(receiver.url);
    const queued = enqueueEvent(emptyState(), config, [textAddition()], "agent-disabled");
    const pending = requiredPending(queued);

    const first = await deliverPendingHttpEvent(pending, { env: { EVENT_TOKEN: token } });
    const exact = await deliverPendingHttpEvent(pending, { env: { EVENT_TOKEN: token } });
    expect(exact).toEqual(first);
    expect(receiver.receipts.size).toBe(1);

    const divergentPayload = JSON.parse(pending.body) as Record<string, unknown>;
    divergentPayload.observedAt = "2026-08-11T23:59:59.000Z";
    const divergentBody = JSON.stringify(divergentPayload);
    const divergent = await fetch(receiver.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": pending.eventId,
        "X-Hypervigilant-Body-SHA256": hashEventBody(divergentBody),
      },
      body: divergentBody,
    });
    expect(divergent.status).toBe(409);

    const unauthorized = await fetch(receiver.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": pending.eventId,
        "X-Hypervigilant-Body-SHA256": pending.bodySha256,
      },
      body: pending.body,
    });
    expect(unauthorized.status).toBe(401);
  });

  it("binds a pending event to its original URL, token variable, and agent route", () => {
    const config = configSchema.parse({
      version: 1,
      project: "event-project",
      agentId: "agent-one",
      destinations: {
        agent: true,
        http: {
          url: "http://127.0.0.1:9999/v1/events",
          authTokenEnv: "EVENT_TOKEN",
        },
      },
    });
    const queued = enqueueEvent(emptyState(), config, [textAddition()], "cloud");
    const pending = requiredPending(queued);
    expect(() => assertPendingDestinationLease(pending, config, "cloud")).not.toThrow();
    const configuredHttp = config.destinations.http;
    if (!configuredHttp) throw new Error("missing configured HTTP destination");
    expect(() =>
      assertPendingDestinationLease(
        pending,
        {
          ...config,
          destinations: {
            ...config.destinations,
            http: { ...configuredHttp, authTokenEnv: "OTHER_TOKEN" },
          },
        },
        "cloud",
      ),
    ).toThrow("different HTTP destination");
    expect(() =>
      assertPendingDestinationLease(pending, { ...config, agentId: "agent-two" }, "cloud"),
    ).toThrow("different agent route");
  });

  it("recovers an HTTP-only scan from the exact persisted outbox item", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypervigilant-event-recovery-"));
    roots.push(root);
    const token = "correct-recovery-token";
    const receiver = startSyntheticReceiver({ token, sourceId: "filesystem:test" });
    receivers.push(receiver);
    await writeFile(join(root, "note.md"), "saved event\n");
    await initCommand({
      path: root,
      project: "recovery",
      eventOnly: true,
      httpDestination: {
        url: receiver.url,
        authTokenEnv: "RECOVERY_TOKEN",
        requestTimeoutMs: 1_000,
      },
      nonInteractive: true,
    });

    await expect(
      scanCommand({
        path: root,
        runtimeEnv: {},
        eventEnv: { RECOVERY_TOKEN: "wrong-token" },
      }),
    ).rejects.toThrow("status 401");
    const store = new StateStore({ stateDir: join(root, ".hypervigilant") });
    const failed = await store.load();
    const eventId = failed?.eventOutput?.pending?.eventId;
    const body = failed?.eventOutput?.pending?.body;
    expect(eventId).toMatch(/^hvevt_/);
    if (!eventId) throw new Error("missing persisted event ID");
    expect(failed?.snapshots).toEqual({});
    expect(receiver.receipts.size).toBe(0);
    expect(await readFile(join(root, ".hypervigilant", "state.json"), "utf8")).not.toContain(
      "wrong-token",
    );
    const pendingStatus = await statusCommand({ path: root });
    expect(pendingStatus.lines.some((line) => line.includes(`Pending: ${eventId}`))).toBe(true);
    expect(pendingStatus.lines.join("\n")).not.toContain("saved event");
    expect(pendingStatus.lines.join("\n")).not.toContain(
      failed?.eventOutput?.pending?.bodySha256 ?? "missing-digest",
    );

    await scanCommand({ path: root, runtimeEnv: {}, eventEnv: { RECOVERY_TOKEN: token } });
    const recovered = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(recovered?.eventOutput?.pending).toBeUndefined();
    expect(recovered?.eventOutput?.lastReceipt?.eventId).toBe(eventId);
    expect(receiver.receipts.get(eventId)?.bodySha256).toBe(
      failed?.eventOutput?.pending?.bodySha256,
    );
    expect(body).toBe(failed?.eventOutput?.pending?.body);
    expect(recovered?.snapshots["note.md"]?.content).toBe("saved event\n");

    const status = await statusCommand({ path: root });
    expect(status.lines.some((line) => line === "Agent: disabled")).toBe(true);
    expect(status.lines.some((line) => line.includes("filesystem:test sequence 1"))).toBe(true);
    expect(status.lines.join("\n")).not.toContain(token);
  });

  it("persists HTTP acceptance before agent delivery and does not repeat it after agent failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypervigilant-dual-destination-"));
    roots.push(root);
    const token = "dual-destination-token";
    const receiver = startSyntheticReceiver({ token, sourceId: "filesystem:dual" });
    receivers.push(receiver);
    await writeFile(join(root, "note.md"), "dual delivery\n");
    await initCommand({
      path: root,
      project: "dual",
      agentId: "agent-dual",
      mode: "review",
      httpDestination: {
        url: receiver.url,
        authTokenEnv: "DUAL_TOKEN",
        requestTimeoutMs: 1_000,
      },
      nonInteractive: true,
    });
    const options = {
      path: root,
      runtimeEnv: { LETTA_API_KEY: "test-key" },
      eventEnv: { DUAL_TOKEN: token },
    };

    let agentSessionOptions: Record<string, unknown> | undefined;
    await expect(
      scanCommand(
        options,
        agentClient(false, (sessionOptions) => {
          agentSessionOptions = sessionOptions;
        }),
      ),
    ).rejects.toThrow("Agent delivery stopped");
    expect(agentSessionOptions?.env).toEqual({ LETTA_API_KEY: "test-key" });
    expect(JSON.stringify(agentSessionOptions)).not.toContain(token);
    const failed = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(receiver.receipts.size).toBe(1);
    expect(failed?.eventOutput?.pending?.httpReceipt?.sourceId).toBe("filesystem:dual");
    expect(failed?.eventOutput?.pending?.agentDelivered).toBe(false);
    expect(failed?.snapshots).toEqual({});

    await scanCommand(options, agentClient(true));
    const recovered = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(receiver.receipts.size).toBe(1);
    expect(recovered?.eventOutput?.pending).toBeUndefined();
    expect(recovered?.eventOutput?.lastReceipt?.sourceId).toBe("filesystem:dual");
    expect(recovered?.snapshots["note.md"]?.content).toBe("dual delivery\n");
  });

  it("settles a persisted intermediate event before emitting the current deleted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypervigilant-event-order-"));
    roots.push(root);
    const token = "ordered-recovery-token";
    const receiver = startSyntheticReceiver({ token, sourceId: "filesystem:ordered" });
    receivers.push(receiver);
    const notePath = join(root, "note.md");
    await writeFile(notePath, "intermediate\n");
    await initCommand({
      path: root,
      project: "ordered",
      eventOnly: true,
      httpDestination: {
        url: receiver.url,
        authTokenEnv: "ORDER_TOKEN",
        requestTimeoutMs: 1_000,
      },
      nonInteractive: true,
    });
    await expect(
      scanCommand({ path: root, runtimeEnv: {}, eventEnv: { ORDER_TOKEN: "wrong" } }),
    ).rejects.toThrow("status 401");
    await unlink(notePath);

    await scanCommand({ path: root, runtimeEnv: {}, eventEnv: { ORDER_TOKEN: token } });
    const recovered = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
    expect(receiver.receipts.size).toBe(2);
    expect(recovered?.eventOutput?.nextSequence).toBe(3);
    expect(recovered?.eventOutput?.lastReceipt?.sourceSequence).toBe(2);
    expect(recovered?.snapshots).toEqual({});
  });

  it("retries a failed watch event from the outbox without another file save", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypervigilant-event-watch-retry-"));
    roots.push(root);
    const acceptedToken = "watch-retry-token";
    const receiverOptions = { token: "reject-first", sourceId: "filesystem:watch-retry" };
    const receiver = startSyntheticReceiver(receiverOptions);
    receivers.push(receiver);
    await writeFile(join(root, ".env"), `WATCH_EVENT_TOKEN=${acceptedToken}\n`);
    await initCommand({
      path: root,
      project: "watch-retry",
      eventOnly: true,
      batching: "immediate",
      httpDestination: {
        url: receiver.url,
        authTokenEnv: "WATCH_EVENT_TOKEN",
        requestTimeoutMs: 1_000,
      },
      nonInteractive: true,
    });
    const env = { ...process.env };
    delete env.LETTA_API_KEY;
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "watch", root],
      cwd: join(import.meta.dirname, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    const stdoutReader = child.stdout.getReader();
    const stdoutPump = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
      stdout += decoder.decode();
    })();
    const stderrPump = new Response(child.stderr).text();
    try {
      await waitFor(() => stdout.includes(`Watching ${root}`));
      await writeFile(join(root, "retry.md"), "retry once\n");
      await waitFor(() => receiver.metrics.unauthorized === 1);
      expect(receiver.receipts.size).toBe(0);

      receiverOptions.token = acceptedToken;
      await waitFor(() => receiver.receipts.size === 1, 5_000);
      await waitFor(async () => {
        const state = await new StateStore({ stateDir: join(root, ".hypervigilant") }).load();
        return state?.snapshots["retry.md"]?.content === "retry once\n";
      });
      expect(receiver.receipts.size).toBe(1);
      expect(receiver.metrics.requests).toBe(2);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await Promise.all([stdoutPump, stderrPump]);
    }
  });

  it("runs the HTTP-only CLI from project .env without a Letta Cloud key", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypervigilant-event-cli-"));
    roots.push(root);
    const token = "cli-project-token";
    const receiver = startSyntheticReceiver({ token, sourceId: "filesystem:cli" });
    receivers.push(receiver);
    await writeFile(join(root, "note.md"), "CLI delivery\n");
    await writeFile(join(root, ".env"), `CLI_EVENT_TOKEN=${token}\n`);
    await initCommand({
      path: root,
      project: "cli-events",
      eventOnly: true,
      httpDestination: {
        url: receiver.url,
        authTokenEnv: "CLI_EVENT_TOKEN",
        requestTimeoutMs: 1_000,
      },
      nonInteractive: true,
    });
    const env = { ...process.env };
    delete env.LETTA_API_KEY;
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "scan", root],
      cwd: join(import.meta.dirname, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("HTTP event accepted as filesystem:cli sequence 1");
    expect(stdout).not.toContain(token);
    expect(receiver.receipts.size).toBe(1);
  });
});
