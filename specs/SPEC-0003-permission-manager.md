---
id: SPEC-0003
title: Runtime permission manager
status: implemented
dependencies: [SPEC-0000, SPEC-0002]
supersedes: []
implementation_links: [src/permissions.ts, src/watch.ts, src/agent.ts, src/cli.ts, tests/permissions.test.ts, tests/agent.test.ts, tests/state.test.ts]
---

# Runtime permission manager

## Goal

Let users change Hypervigilant's edit policy without rewriting configuration or restarting the watcher. Add an explicit YOLO policy that removes per-call prompts while preserving tool and path safety guards.

## Product behavior

- Effective permission policies are `review`, `ask`, and `yolo`.
- Without an override, existing `mode = "review"` maps to `review` and `mode = "edit"` maps to `ask`.
- `hypervigilant permissions status|review|ask|yolo|reset [path]` manages a private project-local override.
- The override is stored atomically under the configured state directory, not in the human TOML file.
- The watcher reads the effective policy before every delivered batch. A policy change applies without restart to the next batch.
- `review` limits local file access to Read, LS, Glob, and Grep. Explicitly configured non-file client tools from SPEC-0006 remain available under their own policy.
- `ask` exposes Edit and Write but requires the existing interactive approval for every mutation.
- `yolo` auto-approves Edit and Write only after the existing tool-name and watched-root path guards pass.
- Prohibited or unconfigured local client tools and paths outside the watched root remain denied in every policy. Tools attached to the Letta agent remain governed by their own tool rules.
- Path guards resolve existing ancestors so in-root symlinks cannot redirect writes outside the watched root.
- Hypervigilant state, the active config file, and Git metadata are protected control paths that the agent cannot modify.
- YOLO output states its exact scope. Direct-project mode warns that changes affect the source checkout; worktree mode states that changes remain isolated.
- Corrupt or unsupported permission state fails closed before a batch is delivered.
- A policy change does not resolve an approval prompt that is already waiting for input.

## Acceptance criteria

- [x] Permission state parsing and atomic persistence cover all policies, reset, malformed state, and configured fallback.
- [x] CLI status reports configured, override, and effective policies.
- [x] CLI can enable review, ask, or yolo and can reset to the configured default.
- [x] The watcher applies permission changes to the next batch without restart.
- [x] Review mode remains read-only for the local filesystem even when the project configuration normally enables edits.
- [x] Ask mode still invokes the interactive callback for every Edit or Write.
- [x] YOLO permits Edit and Write inside the watched root without invoking the interactive callback.
- [x] YOLO still denies prohibited or unconfigured client tools and outside-root mutations; it does not auto-approve SPEC-0006 `ask` tools.
- [x] YOLO denies writes through symlinks that resolve outside the watched root.
- [x] Every edit policy denies agent writes to permission/state files, active configuration, and Git metadata.
- [x] Approved YOLO mutations still participate in watcher suppression and isolated-worktree batch commits.
- [x] Legacy configs and projects with no permission override preserve current behavior.
- [x] README, help output, and the spec-guardian demo document the policies and YOLO warning.
- [x] Unit, integration, full-suite, package, and live CLI validation pass.

## Non-goals

- Letting YOLO itself enable local Bash or change configured client-tool policy.
- Allowing writes outside the watched root.
- Automatically answering an approval that is already pending.
- Replacing Letta Code's global permission system.
- Editing or reformatting user-authored TOML when a runtime policy changes.

## Implementation links

- `src/permissions.ts` owns permission state, configured fallback, atomic overrides, reset, and policy-to-agent-mode mapping.
- `src/watch.ts` reloads policy per batch, wires automatic approval, protects control paths, and keeps worktree mutation suppression and commits policy-independent.
- `src/agent.ts` enforces tool, root, control-path, and symlink guards before ask or YOLO policy callbacks.
- `src/cli.ts` exposes status, review, ask, yolo, and reset commands with direct-project and worktree warnings.
- `tests/permissions.test.ts`, `tests/agent.test.ts`, and `tests/state.test.ts` cover persistence, fallback, routing, protected control files, and symlink escapes.
- Live CLI validation switched one running watcher from ask to YOLO, auto-approved an Edit without input, suppressed the feedback event, and committed the net repair on its isolated branch.
