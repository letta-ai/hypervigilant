# HTTP event receiver demo

This demo proves Hypervigilant can scan files into an authenticated generic HTTP destination without creating or contacting a Letta agent.

The synthetic receiver enforces the production-facing request contract:

- bearer authentication;
- strict `dev.hypervigilant.file-event@1` payloads;
- matching event IDs and body digests in headers and JSON;
- stable receipts for exact retries;
- `409` refusal when an event ID is reused with different content.

It stores receipts in memory, so it demonstrates protocol behavior rather than production durability. A real receiver must persist the event and idempotency record before returning `dev.hypervigilant.event-receipt@1`.

Run the complete HTTP-only scan:

```bash
bun run demo:http-event
```

The script creates a temporary project, writes an event-only configuration, scans one file, verifies the persisted receiver receipt in Hypervigilant state, and deletes the temporary project. It never prints the generated bearer token.
