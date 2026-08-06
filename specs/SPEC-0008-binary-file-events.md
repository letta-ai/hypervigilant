---
id: SPEC-0008
title: Metadata-only binary file events
status: implemented
dependencies: [SPEC-0000, SPEC-0006]
supersedes: []
implementation_links: [src/watcher.ts, src/diff.ts, src/state.ts, src/watch.ts, tests/integration.test.ts, tests/diff.test.ts, README.md]
---

# Metadata-only binary file events

## Goal

Let configured agents react when matching images and other binary files arrive, change, or disappear. Send file metadata only. Keep binary bytes out of prompts and persisted state.

## Product behavior

- Include and exclude globs select text and binary files.
- The size limit applies before Hypervigilant reads or hashes a file.
- Text changes continue to use exact unified diffs.
- Binary changes send the event type, project-relative path, and current size.
- Hypervigilant hashes binary bytes to detect offline changes, then discards the bytes.
- Binary snapshots store the path, hash, size, kind, and timestamp. Their content remains `null`.
- The first baseline does not dispatch existing binary files.
- An upgrade from text-only state establishes one binary baseline before offline detection. It does not dispatch existing binary files.
- `ViewImage` remains an explicit client-tool grant. Binary detection does not add tools or permissions.
- Failed delivery does not advance a binary snapshot.

## Acceptance criteria

- [x] A matching binary addition produces one metadata-only `add` event.
- [x] Matching binary changes and deletions work while the watcher runs and after a restart.
- [x] Binary event messages contain no bytes, hashes, absolute paths, or synthetic text diffs.
- [x] Mixed batches preserve unified text diffs and add a separate binary event list.
- [x] Binary snapshots never persist file bytes.
- [x] Existing binary files enter the first or upgrade baseline without dispatch.
- [x] Legacy text snapshots load as text.
- [x] Existing text-only `FileChange` values and `getPreviousContent` callbacks remain valid.
- [x] Exclusions, symbolic-link rules, and size limits still apply.
- [x] `ViewImage` is available only when the config explicitly grants it.
- [x] The README includes a small image-inbox config and states that file moves need a separate guarded tool.
- [x] Targeted tests and the full project checks pass.

## Non-goals

- Embedding or diffing binary bytes.
- Detecting MIME types or understanding image content inside the watcher.
- Automatically granting `ViewImage` or another tool.
- Moving, renaming, or deleting files.
- Watching files above `max_file_size_bytes`.

## Implementation links

- `src/watcher.ts` classifies bounded files and emits text or binary changes.
- `src/state.ts` stores the file kind and migrates old text snapshots.
- `src/diff.ts` renders binary events without constructing a text diff.
- `src/watch.ts` owns baseline migration and successful-delivery persistence.
- `tests/integration.test.ts` covers live, offline, baseline, and size boundaries.
- `tests/diff.test.ts` proves that prompts contain metadata only.
- `README.md` contains the image-inbox mini config.
