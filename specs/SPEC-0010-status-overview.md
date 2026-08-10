---
id: SPEC-0010
title: Read-only status overview
status: implemented
dependencies: [SPEC-0000, SPEC-0001, SPEC-0005, SPEC-0008]
supersedes: []
implementation_links: [src/status.ts, src/cli.ts, tests/status.test.ts, README.md]
---

# Read-only status overview

## Goal

Provide `hypervigilant status [path]` — a read-only overview of configuration, file state, routing, and worktree status. No API key, no messages, no conversations, no watcher, no locks, no mutations.

## Behavior

- Loads config and state via `StateStore.load()`. Missing state is valid; corrupt state throws.
- Shows project name and configured agent ID.
- Shows current text/binary file counts and bytes (only files `inspectFile` accepts).
- Compares eligible current files with persisted snapshots: indexed, changed, new, stale/missing. A current path is added only after `inspectFile` accepts it, so skipped oversized files do not hide stale snapshots.
- If persisted state belongs to another agent, says so and ignores saved conversation routes. Snapshot classification remains because snapshots are project file state.
- Project routing: all selected files map to one saved project conversation or "not yet created."
- Per-file routing: counts current files with and without saved conversation IDs, plus at most five examples with route IDs.
- Named prompt-rule routes: shows definitions and saved IDs, but says file mapping depends on add/change/delete events.
- Worktree: shows only `enabled` or `disabled`. If an isolated worktree exists, reads its watched files and state without creating or locking it. No metadata or paths are shown.
- Each file/example list is bounded at five. Never prints file contents, hashes, secrets, raw state JSON, absolute paths, or tool data.

## Acceptance criteria

- [x] `status` loads config and state without an API key.
- [x] Shows project and agent ID.
- [x] Shows current text/binary file counts and bytes.
- [x] Classifies current files as indexed, changed, new, or stale/missing.
- [x] Skipped oversized files do not hide stale snapshots.
- [x] Agent mismatch is reported; saved conversation routes are ignored.
- [x] Project and per-file routing overview with bounded examples.
- [x] Named prompt-rule routes show definitions and saved IDs with event-dependency note.
- [x] Worktree shows only enabled/disabled and uses existing worktree files/state when present.
- [x] Output bounded at five examples per list.
- [x] Never prints contents, hashes, secrets, raw state JSON, absolute paths, or tool data.
- [x] Missing state is valid; corrupt state throws.
- [x] No state mutation, no messages, no conversations, no watcher, no locks.
- [x] `bun run check` passes.
