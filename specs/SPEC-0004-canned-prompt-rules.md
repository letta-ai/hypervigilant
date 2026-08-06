---
id: SPEC-0004
title: Canned prompt rules
status: implemented
dependencies: [SPEC-0000, SPEC-0003]
supersedes: []
implementation_links: [src/config.ts, src/prompts.ts, src/agent.ts, src/cli.ts, tests/config.test.ts, tests/prompts.test.ts, tests/agent.test.ts]
---

# Canned prompt rules

## Goal

Let projects attach reusable instructions to specific file paths and change events. Hypervigilant selects matching rules for each delivery group and shows users exactly which rules would activate before they run the watcher.

## Product behavior

- TOML adds ordered `[[prompt_rules]]` entries with `name`, `match`, `events`, and `prompt`.
- Rule names are unique and non-empty. Each rule has at least one glob and a non-empty prompt.
- Supported events are `add`, `change`, and `delete`. Missing `events` means all three.
- Paths use the same project-relative forward-slash form as watcher diffs.
- A rule activates once per delivery group when any changed path matches one of its globs and its event is selected.
- Activated rules stay in configuration order. Each section names the rule and the matching path/event pairs.
- When rules are configured but none match, the delivery states that no canned rule is active for that turn.
- Project routing matches against the full batch. Per-file routing matches each file independently.
- Global `instructions` remain supported and are sent before activated prompt rules.
- With no prompt rules, existing agent messages remain unchanged.
- Prompt rules add instructions only. They cannot select tools, change permission policy, bypass guards, or resolve approvals.
- `hypervigilant prompts list [project]` lists configured rules.
- `hypervigilant prompts test <changed-path> [--event add|change|delete] [--project path]` prints the exact matching rule section without contacting an agent.
- Unknown keys, duplicate names, invalid events, empty globs, and empty prompts fail strict configuration validation.

## Acceptance criteria

- [x] Config schema, TOML normalization, serialization, JSON Schema, and examples cover prompt rules.
- [x] Prompt rule validation rejects duplicate names, unknown keys, invalid events, empty match lists, and blank prompts.
- [x] Matching normalizes path separators and respects glob plus event filters.
- [x] A rule that matches several files appears once and lists every matching path/event pair.
- [x] Multiple matching rules preserve configuration order.
- [x] Project and per-file conversation routing receive the correct matched rules.
- [x] Global instructions remain before canned prompts and unified diffs remain last.
- [x] Projects with no rules produce the existing message shape.
- [x] Prompt rules do not alter mode, tools, approval callbacks, protected paths, or permission state.
- [x] CLI list and test commands work without API credentials or agent calls.
- [x] README, help output, and spec-guardian demo document prompt rules.
- [x] Unit, integration, full-suite, package, and CLI validation pass.

## Non-goals

- Loading prompt text from remote URLs.
- Letting prompts grant tools or change permissions.
- Running prompts on timers, test failures, or non-file events.
- Automatically generating prompt rules from repository content.
- Replacing the existing global `instructions` field.

## Implementation links

- `src/config.ts` validates strict ordered prompt rules and maps them through TOML and legacy configuration.
- `src/prompts.ts` owns event conversion, normalized glob matching, deduplication, ordering, and prompt section rendering.
- `src/agent.ts` selects rules per delivery group and places them between global instructions and unified diffs without changing permissions.
- `src/cli.ts` exposes credential-free prompts list and test commands.
- `tests/config.test.ts`, `tests/prompts.test.ts`, and `tests/agent.test.ts` cover strict parsing, matching, ordering, project/per-file routing, message order, inactive markers, and permission isolation.
- `demo/spec-guardian/hypervigilant.toml.example` and its README provide runnable spec and implementation rules.
