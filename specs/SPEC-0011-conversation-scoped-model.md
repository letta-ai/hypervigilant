---
id: SPEC-0011
title: Conversation-scoped model selection
status: implemented
dependencies: [SPEC-0000, SPEC-0005]
supersedes: []
implementation_links: [src/config.ts, src/agent.ts, src/watch.ts, tests/config.test.ts, tests/agent.test.ts, tests/live.test.ts, README.md, hypervigilant.schema.json]
---

# Conversation-scoped model selection

## Goal

Let each Hypervigilant project select a model for the persistent conversations that it owns. Do not change the configured agent's default model.

## Behavior

- The top-level `model` configuration key is optional.
- When present, Hypervigilant passes it to Agent SDK sessions for project, per-file, and named conversation routes.
- Hypervigilant passes the configured model when it creates or resumes a conversation. A later configuration change therefore updates only those resumed routes.
- When omitted, Hypervigilant does not pass a model option. Existing Agent SDK behavior remains unchanged.

## Non-goals

- Change the agent's default model.
- Change unrelated conversations.
- Validate model availability before a delivery.
- Add separate model settings for each route.

## Acceptance criteria

- [x] Configuration accepts and serializes an optional model identifier.
- [x] New project, per-file, and named conversations receive the configured model.
- [x] Resumed watcher conversations receive the configured model.
- [x] Changing the configured model updates only Hypervigilant-owned conversation routes.
- [x] Omitting the setting preserves current behavior.
- [x] Automated tests cover create and resume paths.
- [x] A credentialed live test verifies that the agent default remains unchanged while the watcher conversation uses the selected model.
- [x] Documentation states that the setting is conversation-scoped.
