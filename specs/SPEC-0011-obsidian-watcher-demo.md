---
id: SPEC-0011
title: Obsidian vault steward demo
status: implemented
dependencies: [SPEC-0000, SPEC-0001, SPEC-0003]
supersedes: []
implementation_links: [demo/obsidian-watcher/README.md, demo/obsidian-watcher/hypervigilant.toml.example, demo/obsidian-watcher/scripts/setup.ts, demo/obsidian-watcher/scripts/introduce-change.ts, demo/obsidian-watcher/tests/setup.test.ts, README.md]
---

# Obsidian vault steward demo

## Goal

Demonstrate one persistent Letta Auto agent turning an ordinary Markdown work event into consistent, approval-gated vault state. The useful object is a quiet steward with local evidence and durable context, not visible multi-agent review machinery.

## Product behavior

- Setup creates one dedicated worker with `model: "auto"` and MemFS disabled, or accepts an existing agent ID.
- Every non-state Markdown path reaches one persistent project conversation, independent of folder taxonomy or capitalization.
- A 2.5-second idle debounce and ten-second maximum collapse nearby Obsidian saves into one bounded turn.
- The steward discovers authority from vault-local conventions and treats `@watcher` as an explicit request whose premises still require evidence.
- The controlled change supplies a complete synthetic publication receipt and a preserved inbox handoff.
- The steward can propose edits to project state, the index, and the in-vault watcher inbox through Hypervigilant's approval boundary.
- Agent-authored edits update snapshots without producing a feedback delivery.
- A no-op produces `No vault action needed.` and no in-vault receipt.
- External-vault setup writes configuration only; it never copies the synthetic sample.
- Setup preserves an existing config unless `--force` is explicit.

## Acceptance criteria

- [x] The generated TOML loads under the strict schema and contains no hard-coded folder taxonomy.
- [x] Agent creation requests `model: "auto"` and `memfs: false`.
- [x] The agent's durable memory describes one quiet vault steward rather than specialist conversations.
- [x] Arbitrarily nested Markdown files match while control-state paths do not.
- [x] The sample contains a local trust contract, pending project state, a publication log, an index, and an in-vault watcher inbox.
- [x] The prepared change requires an existing watcher baseline, preserves its source handoff, and supplies exact publication evidence.
- [x] Reset restores every sample-owned file and removes the prepared handoff without clearing agent or conversation state.
- [x] Documentation explains the event-to-outcome story, approval boundary, idle batching, local state, privacy, and real-vault adaptation.
- [x] Live acceptance proves the steward updates project state and index, writes one receipt, preserves the handoff, suppresses edit feedback, and resumes the same conversation after restart.
- [x] Automated demo tests, package checks, security audit, and the full repository gate pass.

## Non-goals

- Defining one universal Obsidian schema or folder structure.
- Silently resolving semantic ambiguity.
- Treating every filesystem event as a separate agent turn.
- Exposing internal reviewer fan-out as the user experience.
- Publishing, synchronizing, or indexing private vault content outside the configured agent session.

## Implementation links

- `demo/obsidian-watcher/hypervigilant.toml.example` owns all-Markdown selection, idle batching, and saved-diff event semantics.
- `demo/obsidian-watcher/sample/VAULT.md` owns the synthetic vault's trust and receipt conventions.
- `demo/obsidian-watcher/scripts/setup.ts` creates the Auto worker, copies the sample only for the controlled demo, and writes validated configuration.
- `demo/obsidian-watcher/scripts/introduce-change.ts` creates one verified publication event and one explicit handoff inside a single idle window.
- `demo/obsidian-watcher/scripts/reset.ts` restores the controlled story without deleting persistent agent state.
- `demo/obsidian-watcher/tests/setup.test.ts` verifies setup safety, arbitrary Markdown matching, sample lifecycle, and overwrite protection.

Live acceptance used a dedicated Letta Auto agent and a fresh ignored packaged-demo workspace. The first run baselined six Markdown files without an agent turn. One two-file idle batch then carried a verified deployment log plus an explicit lowercase `inbox/` handoff into the persistent project conversation. The steward verified the vault-local publication criterion and completed three logical changes through five separately approved Edit calls: project state and next step, index status, and one in-vault receipt. The handoff remained byte-unchanged, all five affected snapshots matched disk, the watcher emitted no feedback delivery, and `Watcher Inbox.md` contained exactly one receipt.

After a clean stop, restart found no offline change and retained the same conversation ID. A new Markdown note under an otherwise unknown `scratch/` path reached that conversation, returned exactly `No vault action needed.`, advanced its snapshot, and left the receipt count at one. No watcher process remained after the acceptance run.
