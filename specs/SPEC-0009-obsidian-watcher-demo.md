---
id: SPEC-0009
title: Resource-bounded Obsidian watcher demo
status: implemented
dependencies: [SPEC-0000, SPEC-0004, SPEC-0005]
supersedes: []
implementation_links: [demo/obsidian-watcher/README.md, demo/obsidian-watcher/hypervigilant.toml.example, demo/obsidian-watcher/scripts/setup.ts, demo/obsidian-watcher/tests/setup.test.ts, README.md]
---

# Resource-bounded Obsidian watcher demo

## Goal

Show how one Markdown knowledge vault can route saved changes to several persistent specialist conversations without creating an agent fleet or dispatching every specialist for every note.

## Product behavior

- The demo creates one dedicated worker agent with the explicit `auto` model and MemFS disabled, or accepts an existing Letta agent ID.
- One default project conversation receives every watched change and remains the only route that can propose guarded local edits.
- The default watch set includes every non-excluded Markdown file, independent of folder naming or capitalization.
- Three named, filesystem-read-only conversations review connections, claim boundaries, and project continuity.
- Routes run sequentially, and specialist findings are not aggregated into the default conversation.
- Prompt rules select specialists by path. Concepts do not trigger project continuity, and project notes do not trigger claim review by default.
- The sample vault contains a local conventions file, an index, one concept, and two related project notes.
- A prepared two-file change reaches the default conversation and all three named routes in one debounced batch.
- Setup copies sample notes only into the ignored demo workspace. An explicit external vault path receives only the generated configuration.
- Setup preserves an existing configuration unless the user passes `--force`.
- Documentation explains that every matching conversation creates a turn, the initial baseline stores full watched text, and large vaults should narrow their include globs.
- Listener prompts treat receipt scope explicitly: receiving a diff proves only that the current route began, not that another route or downstream effect completed.

## Acceptance criteria

- [x] The generated configuration loads under the strict TOML schema.
- [x] Agent creation explicitly requests `model: "auto"` and `memfs: false`.
- [x] One concept change matches connections and claims but not continuity.
- [x] One project change matches connections and continuity but not claims.
- [x] An arbitrarily nested Markdown file reaches the default route and connections without requiring a recognized folder name.
- [x] Named routes remain filesystem-read-only under SPEC-0005.
- [x] Existing-agent setup does not create another agent.
- [x] Existing configuration is preserved without explicit replacement.
- [x] The runnable sample, reset command, prompt tests, real-vault adaptation, privacy boundary, and resource tradeoffs are documented.
- [x] Demo tests and the full repository checks pass.

## Non-goals

- Running specialist conversations concurrently.
- Assigning a different agent or model to each listener.
- Aggregating specialist output into a judge or editor conversation.
- Watching an entire large vault without explicit include and exclude review.
- Publishing, synchronizing, or indexing private vault content.

## Implementation links

- `demo/obsidian-watcher/hypervigilant.toml.example` owns path selection, batching, the conservative default editor, and the three named listeners.
- `demo/obsidian-watcher/scripts/setup.ts` creates the Auto worker, copies the sample only for the local demo, and writes a validated configuration.
- `demo/obsidian-watcher/scripts/run.ts` starts the sample or an explicitly selected vault.
- `demo/obsidian-watcher/scripts/introduce-change.ts` creates one batch that exercises every route.
- `demo/obsidian-watcher/tests/setup.test.ts` verifies model selection, config validation, route fan-out, existing-agent reuse, and overwrite protection.

Live acceptance used a 71-file Obsidian test vault. The first run established a no-send baseline, delivered one two-file batch through the default and all three named routes, applied three separately approved mechanical repairs, persisted four conversation IDs, and produced no edit feedback loop. After a clean stop, two offline edits dispatched once and resumed the same four conversations. The claims prompt was tightened after the first run incorrectly treated receipt of its own diff as evidence that all routes had completed.

A follow-up generalized the watch set to `**/*.md`. Eight Markdown files from previously unrecognized reference and skill folders were detected once, delivered through the default and connections routes, and produced two separately approved mechanical repairs without a feedback loop. A clean note under an otherwise unknown `Oddball/` directory then reached the same two general routes, proving that folder taxonomy is not part of default delivery authority.
