---
id: SPEC-0013
title: Durable HTTP event destination
status: implemented
dependencies: [SPEC-0000, SPEC-0001, SPEC-0008, SPEC-0009, SPEC-0010, SPEC-0012]
supersedes: []
implementation_links: [src/event-schema.ts, src/event-destination.ts, src/config.ts, src/state.ts, src/watch.ts, src/cli.ts, src/init.ts, src/status.ts, src/index.ts, tests/event-destination.test.ts, tests/config.test.ts, tests/init.test.ts, demo/http-event-receiver/receiver.ts, demo/http-event-receiver/run.ts, demo/http-event-receiver/run.test.ts, demo/http-event-receiver/README.md, README.md, hypervigilant.example.toml, hypervigilant.schema.json, .env.example, package.json]
---

# Durable HTTP event destination

## Goal

Let Hypervigilant publish saved-file batches to an authenticated HTTP event receiver without requiring a Letta agent turn and without confusing a successful POST with durable ingestion.

## Product behavior

- Agent delivery remains enabled by default for existing configurations.
- `[destinations].agent` independently enables or disables Letta agent delivery.
- `[destinations.http]` enables one generic HTTP event destination. A project may use agent delivery, HTTP delivery, or both.
- HTTP-only operation does not create an SDK client, inspect `LETTA_API_KEY`, validate an agent, expose file tools, or require `agent_id`.
- A configured HTTP batch is written to the local state outbox before the first request. The exact body, body digest, event ID, sequence, and destination lease survive process failure.
- `Idempotency-Key` identifies the event. `X-Hypervigilant-Body-SHA256` identifies the exact JSON body. Retrying an event ID with the same body is valid; reusing it with a different body is a receiver error.
- The receiver must return an exact receipt matching the event ID and body digest. Generic `2xx` status is not evidence of durable append.
- Hypervigilant acknowledges the batch and advances file snapshots only after every configured destination has completed. An HTTP receipt is persisted before an agent turn, so agent failure cannot cause a second HTTP effect.
- If a process exits with a pending batch, the next scan or watch invocation settles that exact batch before creating another one. Changing the destination URL, token-variable name, agent ID, or connection identity while a batch is pending fails closed rather than rerouting it.
- HTTP status and errors never include token values or event bodies. Status may show the URL, token-variable name, pending event ID, sequence, and last receipt.
- HTTP event credentials are resolved into a destination-only environment map and are not exposed to the Letta agent or App Server runtime.
- The source token is expected to bind the receiver-side source and privacy class. Hypervigilant does not let the sender assert those authorities in the payload.

## Configuration

Existing agent-only configuration remains valid:

```toml
agent_id = "agent-xxx"
```

HTTP-only delivery:

```toml
[destinations]
agent = false

[destinations.http]
url = "https://stream.example.com/v1/events"
auth_token_env = "HYPERVIGILANT_STREAM_TOKEN"
request_timeout_ms = 10000
```

Agent and HTTP delivery:

```toml
agent_id = "agent-xxx"

[destinations]
agent = true

[destinations.http]
url = "https://stream.example.com/v1/events"
auth_token_env = "HYPERVIGILANT_STREAM_TOKEN"
```

The token variable name is safe to store. Its value is not written to configuration, state, logs, status, payloads, or receipts.

Non-loopback destinations require HTTPS and a named token environment variable. Loopback HTTP may be unauthenticated for local development. URLs containing credentials, query strings, or fragments are rejected.

## Request contract

The request body is strict JSON with schema `dev.hypervigilant.file-event@1`:

```json
{
  "schema": "dev.hypervigilant.file-event@1",
  "eventId": "hvevt_...",
  "emitterId": "hvem_...",
  "sequence": 1,
  "project": "The Coil",
  "observedAt": "2026-08-11T00:00:00.000Z",
  "changes": [
    {
      "path": "notes/example.md",
      "event": "change",
      "before": { "sha256": "...", "bytes": 3, "kind": "text", "text": "old" },
      "after": { "sha256": "...", "bytes": 3, "kind": "text", "text": "new" }
    }
  ]
}
```

Binary changes carry hashes but no text. Adds have `before: null`; deletes have `after: null`. Paths are project-relative and use forward slashes.

Headers:

- `Content-Type: application/json`
- `Idempotency-Key: <eventId>`
- `X-Hypervigilant-Body-SHA256: <lowercase SHA-256 hex>`
- `Authorization: Bearer <token>` when `auth_token_env` is configured

Redirects are rejected so credentials cannot be forwarded to another origin.

## Receipt contract

The receiver returns status `200`, content type `application/json`, and a strict body:

```json
{
  "schema": "dev.hypervigilant.event-receipt@1",
  "accepted": true,
  "eventId": "hvevt_...",
  "bodySha256": "...",
  "sourceId": "filesystem:coil",
  "sourceSequence": 2627,
  "acceptedAt": "2026-08-11T00:00:01.000Z"
}
```

`sourceId` and `sourceSequence` are receiver-owned canonical assignments. The same event ID and body must return the same receipt. A reused event ID with a different body should return `409`.

## Acceptance criteria

- [x] Existing agent-only configuration and delivery remain backward compatible.
- [x] HTTP-only configuration needs no agent ID or Letta credentials.
- [x] Configuration rejects empty destinations, unsafe URLs, plaintext non-loopback HTTP, credential-bearing URLs, query strings, fragments, invalid token-variable names, and unauthenticated non-loopback sinks.
- [x] The event payload preserves add, change, delete, text, and binary semantics with deterministic ordering and exact body hashing.
- [x] The outbox is persisted before network activity and survives restart.
- [x] Exact retries reuse the same event ID, body, digest, and sequence.
- [x] Matching receipts advance snapshots; status-only success, malformed receipts, mismatched receipts, redirects, authentication failures, timeouts, and divergent replay do not.
- [x] HTTP acceptance is persisted before optional agent delivery, and a failed agent turn does not repeat the accepted HTTP effect.
- [x] A pending batch is destination-bound and cannot be silently rerouted by a configuration change.
- [x] Status remains read-only and credential-dark while showing destination and outbox state.
- [x] CLI setup, help, root examples, JSON schema, README, and a strict synthetic receiver document the contract.
- [x] Tests prove request authentication, exact replay, divergent replay refusal, outbox recovery, no premature snapshot advancement, and no secret persistence.

## Non-goals

- Implementing the thought stream receiver or choosing its canonical source ID.
- Starting the historical Coil watcher or activating a production source.
- Accepting arbitrary receiver-defined payloads or custom authentication headers.
- Delivering to multiple HTTP destinations in one project.
- Guaranteeing exactly-once execution inside the receiver. Hypervigilant provides stable idempotency identity and requires a durable receiver receipt.
- Replacing source-specific Telegram, X, or other webhook protocols.
