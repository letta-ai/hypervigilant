---
id: SPEC-0009
title: One-shot initial scan
status: implemented
dependencies: [SPEC-0000, SPEC-0003, SPEC-0005, SPEC-0006, SPEC-0008]
supersedes: []
implementation_links: [src/watch.ts, src/cli.ts, tests/scan.test.ts, tests/live.test.ts, README.md]
---

# One-shot initial scan

## Goal

Let a user send files already present in a configured project to the agent. The command then exits without a watcher.

## Product behavior

- `hypervigilant scan [path]` loads the same project configuration and permissions as `watch`.
- A scan reads every current file that matches the include and exclude globs.
- A scan presents each current file as an `add` event, even when a snapshot already exists.
- The agent message identifies the delivery as a scan of existing files.
- Text files send their full content as unified additions. Binary files send metadata only.
- The command performs one delivery batch, exits, and does not start a file watcher.
- Existing project, per-file, and named conversation routes resume when their agent ID still matches.
- A changed agent ID resets all conversation routes before delivery.
- Snapshots advance only for files delivered to every required route.
- A successful scan removes stale matching snapshots without reporting deletion events.
- Agent file mutations use the same path guards, approval policy, snapshot suppression, and worktree commit behavior as watched deliveries.
- A failed delivery preserves new conversation IDs and any independently completed paths, then exits with an error.
- A scan with no matching files exits successfully after creating valid empty state.

## Acceptance criteria

- [x] `hypervigilant scan [path]` sends matching existing text files and exits.
- [x] A scan of a baselined project sends its current matching files again.
- [x] Scan events activate `add` prompt rules and do not activate `change` or `delete` rules.
- [x] Binary scan messages and state contain metadata but no binary bytes.
- [x] Include globs, exclude globs, symbolic-link rejection, and file-size limits remain enforced.
- [x] Successful scans persist current snapshots, remove stale matching snapshots, and preserve conversation routes.
- [x] Failed required delivery does not mark the affected files as delivered and produces a nonzero CLI exit.
- [x] Review, ask, YOLO, configured client tools, and attached server tools keep their existing boundaries.
- [x] Worktree scans use the isolated watched root, process lock, mutation commit rules, and lock cleanup.
- [x] The command does not start a persistent file watcher.
- [x] CLI help, README guidance, public exports, tests, and generated specification status are updated.
- [x] `bun run check`, demo tests, audit, and package inspection pass.

## Non-goals

- Deletion reports for files that no longer exist.
- A distinct prompt-rule event for scans.
- Model-size batches for one project-routed scan.
- A replacement for continuous `watch` operation.

## Dependencies

- SPEC-0000 defines file selection, delivery, routing, and persisted snapshots.
- SPEC-0003 defines runtime permissions.
- SPEC-0005 defines named prompt conversations.
- SPEC-0006 defines configured client tools.
- SPEC-0008 defines metadata-only binary events.

## Implementation links

- `src/watch.ts` runs the shared one-shot and continuous delivery path.
- `src/cli.ts` exposes `hypervigilant scan`.
- `tests/scan.test.ts` covers scan delivery, repeated scans, binary safety, failure, state cleanup, and worktree cleanup.
- `tests/live.test.ts` contains the opt-in Agent SDK acceptance check.
- `README.md` documents scan setup, behavior, commands, and limits.
