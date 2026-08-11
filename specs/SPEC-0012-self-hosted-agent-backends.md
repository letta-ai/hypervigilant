---
id: SPEC-0012
title: Self-hosted agent backends
status: implemented
dependencies: [SPEC-0000, SPEC-0001, SPEC-0003, SPEC-0005]
supersedes: []
implementation_links: [src/connection.ts, src/auth.ts, src/config.ts, src/cli.ts, src/watch.ts, src/agent.ts, src/state.ts, src/status.ts, tests/connection.test.ts, tests/config.test.ts, tests/agent.test.ts, tests/status.test.ts, demo/cloud-local-device/run.ts, demo/cloud-local-device/run.test.ts, demo/cloud-local-device/README.md, README.md, hypervigilant.example.toml, hypervigilant.schema.json, package.json, bun.lock]
---

# Self-hosted agent backends

## Goal

Let Hypervigilant target Cloud, fully local, and user-managed Letta App Server agents without weakening file authority, credential custody, or conversation continuity.

## Product behavior

- `[connection].backend = "cloud"` preserves the existing split: agent state in Letta Cloud and filesystem tools in an SDK-owned local App Server.
- `[connection].backend = "local"` uses one command-scoped App Server with fully local agent state and provider configuration. No Cloud key is required or inspected.
- `[connection].backend = "remote"` connects to a user-managed App Server URL with a bearer token resolved from a named environment variable. Authentication and TLS are optional only for loopback servers.
- Remote connections are diff-only by default. They expose no Hypervigilant-managed filesystem tools and require review mode because the App Server may not share the watcher's filesystem. Agent-attached tools remain under their independent server-side rules.
- `shared_filesystem = true` explicitly asserts that the remote App Server sees the watched root, including any generated isolated worktree, at the same absolute path and enables the existing guarded filesystem tools.
- Agent availability is checked through the selected backend before state creation. Local and remote checks use a short-lived raw App Server client so pooled SDK management connections cannot keep one-shot commands alive.
- Persisted conversation routes are owned jointly by agent ID and connection identity. Changing backend, remote URL, or local backend storage root resets routes while preserving snapshots.
- Status reports the selected backend and whether filesystem tools are shared or diff-only without reading credentials or contacting the server.

## Configuration

Cloud remains the backward-compatible default:

```toml
[connection]
backend = "cloud"
```

Fully local:

```toml
[connection]
backend = "local"
```

User-managed App Server:

```toml
[connection]
backend = "remote"
url = "wss://agents.example.com"
auth_token_env = "LETTA_APP_SERVER_TOKEN"
shared_filesystem = false
```

The token variable name is safe to store; its value is not.

## Acceptance criteria

- [x] Existing configuration without `[connection]` loads as Cloud.
- [x] Cloud connection planning preserves project-first `sk-let-` key resolution and local tool execution.
- [x] A runnable behavioral demo proves that Cloud agent state can use the current device rather than a managed sandbox by reading an excluded local-only marker and archiving the temporary conversation.
- [x] Local connection planning requires no Cloud key and starts the local agent backend.
- [x] A local scan reuses one App Server for validation and delivery, then exits without leaking the server process.
- [x] Remote connection planning accepts `http`, `https`, `ws`, and `wss` URLs plus bearer-token indirection.
- [x] Invalid backend combinations, URL protocols, credential-bearing URLs, token variable names, plaintext or unauthenticated non-loopback servers, and edit-capable non-shared remote configurations fail closed.
- [x] Remote diff-only sessions omit CWD and Hypervigilant-managed filesystem tools while retaining explicitly configured non-file tools.
- [x] Shared remote sessions retain existing file guards and approval policy.
- [x] Agent or connection changes reset project, per-file, and named conversation routes without deleting snapshots.
- [x] Status is credential-dark, read-only, and explicit about backend and filesystem authority.
- [x] CLI setup, help, root examples, JSON schema, and README describe all three deployment shapes and the local model-availability boundary.
- [x] Unit tests cover Cloud, local, authenticated remote, unauthenticated loopback, missing token, route ownership, and diff-only tool selection.

## Non-goals

- Synchronizing a watched checkout to another machine.
- Translating different local and remote filesystem roots.
- Inventing a local equivalent of the `letta/auto` Cloud router.
- Managing model-provider credentials for a local or remote App Server.
- Starting or supervising a user-managed remote App Server.
