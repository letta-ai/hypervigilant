import { EVENT_RECEIPT_SCHEMA, fileEventPayloadSchema, hashEventBody } from "../../src/event-schema.ts";

export interface SyntheticReceiverOptions {
  token: string;
  sourceId?: string;
}

export interface SyntheticReceiver {
  url: string;
  receipts: ReadonlyMap<string, { bodySha256: string; receipt: Record<string, unknown> }>;
  metrics: { requests: number; unauthorized: number; divergentReplay: number };
  stop(): Promise<void>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Strict in-memory receiver for local proof and contract tests.
 * It models durable idempotency semantics; it is not a production event store.
 */
export function startSyntheticReceiver(options: SyntheticReceiverOptions): SyntheticReceiver {
  const receipts = new Map<
    string,
    { bodySha256: string; receipt: Record<string, unknown> }
  >();
  const metrics = { requests: 0, unauthorized: 0, divergentReplay: 0 };
  let sourceSequence = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/events") {
        return json({ error: "not_found" }, 404);
      }
      metrics.requests += 1;
      if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
        metrics.unauthorized += 1;
        return json({ error: "unauthorized" }, 401);
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return json({ error: "content_type" }, 415);
      }

      const body = await request.text();
      if (Buffer.byteLength(body, "utf8") > 2_000_000) {
        return json({ error: "too_large" }, 413);
      }
      const bodySha256 = hashEventBody(body);
      const eventId = request.headers.get("idempotency-key");
      if (
        !eventId ||
        request.headers.get("x-hypervigilant-body-sha256") !== bodySha256
      ) {
        return json({ error: "identity_mismatch" }, 400);
      }
      let payload: ReturnType<typeof fileEventPayloadSchema.parse>;
      try {
        payload = fileEventPayloadSchema.parse(JSON.parse(body));
      } catch {
        return json({ error: "invalid_event" }, 400);
      }
      if (payload.eventId !== eventId) {
        return json({ error: "identity_mismatch" }, 400);
      }

      const existing = receipts.get(eventId);
      if (existing) {
        if (existing.bodySha256 !== bodySha256) {
          metrics.divergentReplay += 1;
          return json({ error: "divergent_replay" }, 409);
        }
        return json(existing.receipt, 200);
      }

      sourceSequence += 1;
      const receipt = {
        schema: EVENT_RECEIPT_SCHEMA,
        accepted: true,
        eventId,
        bodySha256,
        sourceId: options.sourceId ?? "synthetic:filesystem",
        sourceSequence,
        acceptedAt: new Date().toISOString(),
      };
      receipts.set(eventId, { bodySha256, receipt });
      return json(receipt, 200);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1/events`,
    receipts,
    metrics,
    async stop() {
      await server.stop(true);
    },
  };
}
