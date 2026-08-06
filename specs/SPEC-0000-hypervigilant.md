---
id: SPEC-0000
title: Hypervigilant file diff agent
status: implemented
dependencies: []
supersedes: []
implementation_links: [src/watch.ts, src/agent.ts, tests/integration.test.ts, README.md]
---

# Hypervigilant file diff agent

## Goal

Build a TypeScript and Bun command-line application that watches selected files in a project. The application sends exact text diffs or bounded binary metadata to a persistent Letta agent after each configured batch of saves.

## Product behavior

- A project configuration selects files with include and exclude globs.
- The default selection includes Markdown and plain-text files.
- The watcher stores last-delivered text or binary metadata in local project state.
- The watcher detects additions, edits, and deletions, including changes made while it was stopped.
- Text files use unified diffs. Binary files use metadata-only events as specified by SPEC-0008.
- Delivery supports one conversation for the project or one conversation for each file.
- Batching supports debounce, fixed-window, and immediate delivery.
- Review mode prevents file mutations.
- Edit mode lets the agent inspect and change local files. Every mutating tool call requires interactive approval.
- Changes made by approved agent edit tools update the snapshot without creating an automatic feedback loop.
- Setup accepts an existing agent ID or creates a dedicated agent with the Letta Agent SDK.

## Acceptance criteria

- [x] `hypervigilant init` creates a valid configuration and supports existing-agent and create-agent setup.
- [x] `hypervigilant watch` watches configured files and ignores configured exclusions.
- [x] The first run creates a baseline without sending every existing file.
- [x] Later runs send changes made while the watcher was stopped.
- [x] Text diffs use stable project-relative paths and unified diff syntax.
- [x] Binary files use bounded metadata-only events under SPEC-0008.
- [x] Debounce batches collapse repeated saves to the latest content and enforce a maximum wait.
- [x] Fixed and immediate batching modes work.
- [x] Project and per-file conversation routes persist across restarts.
- [x] State advances only after successful delivery.
- [x] Review mode cannot mutate files.
- [x] Edit mode asks before each file mutation and suppresses approved agent writes from re-triggering delivery.
- [x] Configuration and state writes are atomic.
- [x] Unit and integration tests cover file changes, batching, routing, state persistence, and permissions.
- [x] The README includes setup, configuration, operation, safety, architecture, troubleshooting, and development guidance.
- [x] `bun run check` passes.

## Non-goals

- Embedding binary bytes in prompts or local state.
- Replacing Git or preserving full file history.
- Detecting renames as a distinct operation.
- Running several agent turns concurrently.
- Providing a graphical user interface.
- Running agent edits without user approval.

## Dependencies

None.

## Implementation links

- `src/watch.ts` owns the persisted watcher lifecycle.
- `src/agent.ts` owns Agent SDK sessions, conversation routing, and permissions.
- `tests/integration.test.ts` covers the real filesystem boundary.
- `tests/live.test.ts` checks local file access through a real SDK session.
- `README.md` documents setup, operation, safety, architecture, and limits.
