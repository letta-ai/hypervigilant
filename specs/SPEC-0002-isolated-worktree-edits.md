---
id: SPEC-0002
title: Isolated worktree edits
status: implemented
dependencies: [SPEC-0000, SPEC-0001]
supersedes: []
implementation_links: [src/worktree.ts, src/watch.ts, src/cli.ts, tests/worktree.test.ts, demo/spec-guardian/scripts/setup-worktree.ts]
---

# Isolated worktree edits

## Goal

Let users opt into a Git worktree where both watched changes and approved agent repairs live on an isolated branch. The source checkout stays unchanged. Hypervigilant commits each successfully delivered batch so the user can inspect and merge it later.

## Product behavior

- TOML adds a `[worktree]` table with `enabled`, `auto_commit`, and `branch_prefix`.
- Direct project editing remains the backward-compatible default.
- `hypervigilant init --worktree` enables isolated worktree mode.
- On first watch, Hypervigilant requires a Git repository with a valid `HEAD` and a clean source checkout, creates a branch and linked worktree, and stores durable metadata under the configured private state directory.
- Later watcher starts reuse the same registered worktree and branch rather than creating another branch.
- The watcher, Agent SDK session `cwd`, Read/Edit/Write tools, baselines, and file safeguards operate against the isolated worktree.
- Startup output names the source checkout, worktree path, and branch so users know where to edit.
- After a successful delivery, Hypervigilant stages and commits only the delivered watched paths and approved agent mutation paths from that batch.
- Git hooks run normally. Hypervigilant never bypasses hooks or rewrites Git configuration.
- A commit failure leaves the worktree changes intact and reports the failure with the branch and path. It does not silently claim that the batch was committed.
- Successful commits print the commit ID and a merge command for the source repository.
- `worktree status` reports the source/worktree paths, branches, cleanliness, watcher state, commits ahead, and merge state.
- `worktree merge` requires clean checkouts and explicit user invocation. It never pushes.
- Normal `worktree cleanup` requires a clean branch already merged into the current source `HEAD`. `cleanup --discard` is the explicit destructive path.
- A PID lock blocks a second watcher and prevents merge or cleanup while the watcher is active.
- Existing direct-project mode, review mode, conversation routing, approval gates, restart recovery, and legacy configurations keep working.

## Acceptance criteria

- [x] Config parsing, TOML serialization, JSON Schema, examples, and README document isolated worktrees.
- [x] Config rejects unsafe branch prefixes and unknown worktree keys.
- [x] Init supports `--worktree` and interactive worktree selection.
- [x] First startup fails before baseline creation when the project is not a Git repository, has no `HEAD`, or the source checkout is dirty.
- [x] First startup creates a registered linked worktree and a unique branch without modifying the source checkout.
- [x] Restart reuses the stored worktree and branch.
- [x] The watcher and Agent SDK tools operate inside the isolated worktree.
- [x] Successful delivery commits only batch input paths and approved agent mutation paths.
- [x] Unrelated dirty or staged paths are not included in the generated commit.
- [x] Commit hooks are not bypassed.
- [x] Commit failures preserve changes and produce an actionable error.
- [x] Startup and commit statuses name the worktree path, branch, commit, and merge command.
- [x] Status, merge, normal cleanup, and explicit discard commands enforce clean/merged state as applicable.
- [x] A live watcher lock blocks second-watcher, merge, and cleanup races and recovers from stale PIDs.
- [x] Direct-project mode remains unchanged.
- [x] Unit, integration, full-suite, package, and live CLI validation pass.

## Non-goals

- Merging or pushing without an explicit user command.
- Creating a branch that contains only an agent delta while the user edits another checkout.
- Supporting isolated workspace creation outside Git repositories.
- Automatically removing merged worktrees or branches.
- Bypassing commit hooks or repairing a user's Git identity.

## Implementation links

- `src/worktree.ts` owns worktree creation, metadata, scoped commits, process locks, status, merge, cleanup, and discard.
- `src/watch.ts` moves the watcher and Agent SDK execution root into the isolated worktree and auto-commits successful batches.
- `src/cli.ts` exposes init selection plus worktree status, merge, and cleanup commands.
- `tests/worktree.test.ts` covers creation, reuse, concurrent setup, scoped commits, hooks, lock recovery, merge, cleanup, discard, and dirty-state failures.
- `demo/spec-guardian/scripts/setup-worktree.ts` and `demo/spec-guardian/README.md` provide the standalone branch-to-merge walkthrough.
