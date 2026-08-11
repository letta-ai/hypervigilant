import { resolve } from "node:path";
import type { HttpEventDestinationConfig, HypervigilantConfig } from "./config.ts";
import {
  createEmitterId,
  createEventId,
  EVENT_RECEIPT_SCHEMA,
  type EventOutputState,
  type EventReceipt,
  eventReceiptSchema,
  FILE_EVENT_SCHEMA,
  type FileEventChange,
  type FileEventPayload,
  fileEventPayloadSchema,
  hashEventBody,
  type PendingEvent,
  type PendingHttpDestination,
  parsePendingPayload,
} from "./event-schema.ts";
import type { FileSnapshot, HypervigilantState } from "./state.ts";
import { removeSnapshot, setSnapshot } from "./state.ts";
import type { FileChange } from "./watcher.ts";

export interface EventDestinationRuntime {
  env?: Record<string, string | undefined>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

function fileVersion(
  snapshot: Pick<FileSnapshot, "hash" | "size" | "content" | "kind"> | undefined,
): FileEventChange["before"] {
  if (!snapshot?.hash || snapshot.size === null) return null;
  const kind = snapshot.kind ?? "text";
  if (kind === "text" && snapshot.content === null) {
    throw new Error("Cannot emit a text file version whose saved content is missing.");
  }
  return {
    sha256: snapshot.hash,
    bytes: snapshot.size,
    kind,
    ...(kind === "text" ? { text: snapshot.content ?? "" } : {}),
  };
}

function currentFileVersion(change: FileChange): FileEventChange["after"] {
  if (change.hash === null || change.size === null) return null;
  const kind = change.kind ?? "text";
  if (kind === "text" && change.newContent === null) {
    throw new Error(`Cannot emit ${change.relPath}: text content is missing.`);
  }
  return {
    sha256: change.hash,
    bytes: change.size,
    kind,
    ...(kind === "text" ? { text: change.newContent ?? "" } : {}),
  };
}

function eventChange(change: FileChange, state: HypervigilantState): FileEventChange {
  const event = change.event === "unlink" ? "delete" : change.event;
  const previous = fileVersion(state.snapshots[change.relPath]);
  const current = currentFileVersion(change);
  const before = event === "add" ? null : previous;
  const after = event === "delete" ? null : current;
  return fileEventPayloadSchema.shape.changes.element.parse({
    path: change.relPath,
    event,
    before,
    after,
  });
}

function eventOutput(state: HypervigilantState): EventOutputState {
  return (
    state.eventOutput ?? {
      emitterId: createEmitterId(),
      nextSequence: 1,
    }
  );
}

function httpLease(destination: HttpEventDestinationConfig): PendingHttpDestination {
  return {
    url: destination.url,
    authTokenEnv: destination.authTokenEnv,
    requestTimeoutMs: destination.requestTimeoutMs,
  };
}

/** Create and attach one exact pending event without performing external effects. */
export function enqueueEvent(
  state: HypervigilantState,
  config: HypervigilantConfig,
  changes: FileChange[],
  configuredConnectionKey: string,
  now = new Date(),
): HypervigilantState {
  const output = eventOutput(state);
  if (output.pending) {
    throw new Error(`Pending event ${output.pending.eventId} must be settled before enqueueing.`);
  }
  const sequence = output.nextSequence;
  const eventId = createEventId(output.emitterId, sequence);
  const payload: FileEventPayload = fileEventPayloadSchema.parse({
    schema: FILE_EVENT_SCHEMA,
    eventId,
    emitterId: output.emitterId,
    sequence,
    project: config.project,
    observedAt: now.toISOString(),
    changes: [...changes]
      .sort((left, right) => left.relPath.localeCompare(right.relPath))
      .map((change) => eventChange(change, state)),
  });
  const body = JSON.stringify(payload);
  const pending: PendingEvent = {
    eventId,
    sequence,
    body,
    bodySha256: hashEventBody(body),
    createdAt: payload.observedAt,
    httpDestination: config.destinations.http ? httpLease(config.destinations.http) : undefined,
    agentDestination:
      config.destinations.agent && config.agentId
        ? { agentId: config.agentId, connectionKey: configuredConnectionKey }
        : undefined,
    agentDeliveredPaths: [],
    agentMutationPaths: [],
    agentDelivered: false,
  };
  return {
    ...state,
    eventOutput: {
      ...output,
      nextSequence: sequence + 1,
      pending,
    },
  };
}

function sameHttpDestination(
  current: HttpEventDestinationConfig | undefined,
  leased: PendingHttpDestination | undefined,
): boolean {
  if (!current || !leased) return current === undefined && leased === undefined;
  return (
    current.url === leased.url &&
    current.authTokenEnv === leased.authTokenEnv &&
    current.requestTimeoutMs === leased.requestTimeoutMs
  );
}

/** Refuse to redirect an already persisted batch through changed configuration. */
export function assertPendingDestinationLease(
  pending: PendingEvent,
  config: HypervigilantConfig,
  configuredConnectionKey: string,
): void {
  if (parsePendingPayload(pending).project !== config.project) {
    throw new Error(
      `Pending event ${pending.eventId} belongs to project ${JSON.stringify(parsePendingPayload(pending).project)}. Restore that project name to settle it.`,
    );
  }
  if (!sameHttpDestination(config.destinations.http, pending.httpDestination)) {
    throw new Error(
      `Pending event ${pending.eventId} is bound to a different HTTP destination. Restore the prior URL, token variable, and timeout to settle it.`,
    );
  }
  const currentAgent =
    config.destinations.agent && config.agentId
      ? { agentId: config.agentId, connectionKey: configuredConnectionKey }
      : undefined;
  const leasedAgent = pending.agentDestination;
  if (
    (!currentAgent && leasedAgent) ||
    (currentAgent && !leasedAgent) ||
    (currentAgent &&
      leasedAgent &&
      (currentAgent.agentId !== leasedAgent.agentId ||
        currentAgent.connectionKey !== leasedAgent.connectionKey))
  ) {
    throw new Error(
      `Pending event ${pending.eventId} is bound to a different agent route. Restore the prior agent and connection to settle it.`,
    );
  }
}

function resolveBearerToken(
  destination: PendingHttpDestination,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!destination.authTokenEnv) return undefined;
  const token = env[destination.authTokenEnv];
  if (!token) {
    throw new Error(
      `HTTP event destination requires a non-empty ${destination.authTokenEnv} environment variable.`,
    );
  }
  if (
    [...token].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(
      `HTTP event destination token in ${destination.authTokenEnv} contains forbidden control characters.`,
    );
  }
  return token;
}

function redactSecret(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

async function readWithAbort(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) throw new Error("receipt read aborted");
  return await new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(new Error("receipt read aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolveRead(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectRead(error);
      },
    );
  });
}

async function readBoundedReceipt(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("HTTP event destination returned a non-JSON receipt.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    throw new Error("HTTP event destination returned an oversized receipt.");
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, signal);
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > 65_536) {
          await reader.cancel().catch(() => {});
          throw new Error("HTTP event destination returned an oversized receipt.");
        }
        chunks.push(value);
      }
    } finally {
      if (signal.aborted) void reader.cancel().catch(() => {});
    }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("HTTP event destination returned malformed JSON.");
  }
}

/** Send one pending body and require a matching durable-append receipt. */
export async function deliverPendingHttpEvent(
  pending: PendingEvent,
  runtime: EventDestinationRuntime = {},
): Promise<EventReceipt> {
  const destination = pending.httpDestination;
  if (!destination) throw new Error(`Pending event ${pending.eventId} has no HTTP destination.`);
  if (pending.httpReceipt) return pending.httpReceipt;

  const token = resolveBearerToken(destination, runtime.env ?? process.env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), destination.requestTimeoutMs);
  timeout.unref?.();
  let response: Response;
  try {
    const fetchRequest = runtime.fetch ?? fetch;
    response = await fetchRequest(destination.url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": pending.eventId,
        "X-Hypervigilant-Body-SHA256": pending.bodySha256,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: pending.body,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(
        `HTTP event destination timed out after ${destination.requestTimeoutMs}ms for ${pending.eventId}.`,
      );
    }
    throw new Error(
      `HTTP event destination request failed for ${pending.eventId}: ${redactSecret((error as Error).message, token)}`,
    );
  }

  try {
    if (response.status !== 200) {
      throw new Error(
        `HTTP event destination returned status ${response.status} for ${pending.eventId}; the event remains pending.`,
      );
    }
    const parsed = eventReceiptSchema.safeParse(
      await readBoundedReceipt(response, controller.signal),
    );
    if (!parsed.success) {
      throw new Error(
        `HTTP event destination returned an invalid ${EVENT_RECEIPT_SCHEMA} receipt.`,
      );
    }
    const receipt = parsed.data;
    if (receipt.eventId !== pending.eventId || receipt.bodySha256 !== pending.bodySha256) {
      throw new Error(
        `HTTP event destination receipt does not match pending event ${pending.eventId}.`,
      );
    }
    return receipt;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `HTTP event destination timed out after ${destination.requestTimeoutMs}ms for ${pending.eventId}.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function recordHttpReceipt(
  state: HypervigilantState,
  receipt: EventReceipt,
): HypervigilantState {
  const output = state.eventOutput;
  const pending = output?.pending;
  if (!output || !pending)
    throw new Error("Cannot record an HTTP receipt without a pending event.");
  if (receipt.eventId !== pending.eventId || receipt.bodySha256 !== pending.bodySha256) {
    throw new Error(`Receipt does not match pending event ${pending.eventId}.`);
  }
  return {
    ...state,
    eventOutput: {
      ...output,
      pending: { ...pending, httpReceipt: receipt },
    },
  };
}

export function recordAgentDelivery(
  state: HypervigilantState,
  deliveredPaths: Iterable<string>,
  mutationPaths: Iterable<string>,
  complete: boolean,
): HypervigilantState {
  const output = state.eventOutput;
  const pending = output?.pending;
  if (!output || !pending?.agentDestination) {
    throw new Error("Cannot record agent delivery without a pending agent destination.");
  }
  const paths = new Set(pending.agentDeliveredPaths);
  for (const path of deliveredPaths) paths.add(path);
  const mutations = new Set(pending.agentMutationPaths);
  for (const path of mutationPaths) mutations.add(path);
  return {
    ...state,
    eventOutput: {
      ...output,
      pending: {
        ...pending,
        agentDeliveredPaths: [...paths].sort(),
        agentMutationPaths: [...mutations].sort(),
        agentDelivered: complete,
      },
    },
  };
}

/** Rehydrate the exact saved batch rather than rereading files that may have changed again. */
export function pendingEventChanges(pending: PendingEvent, projectRoot: string): FileChange[] {
  return parsePendingPayload(pending).changes.map((change) => ({
    relPath: change.path,
    absPath: resolve(projectRoot, ...change.path.split("/")),
    event: change.event === "delete" ? "unlink" : change.event,
    kind: change.after?.kind ?? change.before?.kind ?? "text",
    oldContent: change.before?.text ?? null,
    newContent: change.after?.text ?? null,
    hash: change.after?.sha256 ?? null,
    size: change.after?.bytes ?? null,
  }));
}

/** Advance snapshots from the exact event body and clear the completed outbox item. */
export function finalizePendingEvent(state: HypervigilantState): HypervigilantState {
  const output = state.eventOutput;
  const pending = output?.pending;
  if (!output || !pending) throw new Error("Cannot finalize without a pending event.");
  if (pending.httpDestination && !pending.httpReceipt) {
    throw new Error(`Pending event ${pending.eventId} has no HTTP receipt.`);
  }
  if (pending.agentDestination && !pending.agentDelivered) {
    throw new Error(`Pending event ${pending.eventId} has not completed agent delivery.`);
  }

  let nextState = state;
  for (const change of parsePendingPayload(pending).changes) {
    if (!change.after) {
      nextState = removeSnapshot(nextState, change.path);
      continue;
    }
    nextState = setSnapshot(
      nextState,
      change.path,
      change.after.sha256,
      change.after.bytes,
      change.after.text ?? null,
      change.after.kind,
    );
  }
  return {
    ...nextState,
    eventOutput: {
      ...output,
      pending: undefined,
      lastReceipt: pending.httpReceipt ?? output.lastReceipt,
    },
  };
}
