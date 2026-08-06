---
id: SPEC-0006
title: Configurable local client tools
status: implemented
dependencies: [SPEC-0000, SPEC-0003, SPEC-0005]
supersedes: []
implementation_links: [src/client-tools.ts, src/config.ts, src/agent.ts, src/watch.ts, src/cli.ts, tests/config.test.ts, tests/agent.test.ts, tests/integration.test.ts, hypervigilant.schema.json, README.md]
---

# Configurable local client tools

## Goal

Let a project expose additional local Agent SDK client tools from `hypervigilant.toml`, with an explicit per-tool approval policy. Keep local file permissions and tools attached to the Letta agent as separate authority boundaries.

## Product behavior

- TOML adds a strict `[tools]` table with `auto_allow` and `ask` arrays.
- Both arrays default to empty. Existing projects retain the current local file-only client toolset.
- Each configured name identifies a local Agent SDK bundled client tool. Hypervigilant passes configured names through `toolset.include` and `allowedTools` with the mode-specific file tools.
- `auto_allow` tools run without a Hypervigilant terminal prompt and represent an explicit grant of that tool's native authority.
- `ask` tools require approval for every invocation. The prompt shows only the tool name and never prints arbitrary tool input.
- Missing interactive approval support denies an `ask` tool.
- The permission manager continues to own local Edit and Write. YOLO does not auto-approve configured `ask` tools.
- Named prompt conversations cannot use Edit or Write but retain configured `auto_allow` and `ask` tools.
- Read, LS, Glob, Grep, Edit, and Write are reserved and cannot appear in `[tools]`.
- Interactive input, shell/process control, subagent delegation, local memory mutation, worktree control, and alternate tools that can mutate the watched filesystem without Hypervigilant's guards remain prohibited. This includes their bundled snake_case and model-specific aliases.
- TaskCreate, TaskGet, TaskList, TaskUpdate, TodoWrite, and their task-list aliases remain configurable because they only manage session task metadata; they do not launch subagents. The Task/Agent delegation tool remains prohibited.
- `write_artifact_file` remains configurable under its native `~/.letta/artifacts` confinement because it cannot mutate the watched filesystem.
- Tool names are non-empty, bounded, and contain only letters, numbers, `.`, `_`, `:`, and `-`. A name starts with a letter or number.
- Names are unique within and across both arrays.
- Configured extra tools keep their native behavior. Hypervigilant's watched-root and worktree guards apply only to its managed Edit and Write tools.
- Unknown bundled tool names fail the delivery before the agent can process the change.
- Tools attached to the Letta agent are not managed by `[tools]`. They remain available under server-side Letta tool rules.
- Hypervigilant does not print, log, persist, or include configured client-tool inputs in approval prompts or state.

## Acceptance criteria

- [x] Config defaults, strict validation, TOML normalization, serialization, JSON Schema, and examples cover `[tools]`.
- [x] Validation rejects reserved, prohibited, malformed, duplicated, and cross-policy tool names.
- [x] Existing configs produce the previous mode-specific `allowedTools` and `toolset.include` values.
- [x] Configured names are added once to `allowedTools` and `toolset.include`.
- [x] `auto_allow` returns allow without calling an interactive callback.
- [x] `ask` calls the generic approval callback for every invocation and follows its answer.
- [x] `ask` denies when no callback is available.
- [x] Tool input is never passed to the generic terminal approval callback.
- [x] Review and named conversations can use configured tools but cannot use Edit or Write.
- [x] Edit mode and YOLO preserve path guards and do not change configured-tool policies.
- [x] Agent instructions name configured local tools and their approval policy without changing no-config messages.
- [x] CLI status/help, README, root example, public exports, and demo documentation describe the client/server tool boundary.
- [x] Unit, integration, full-suite, demo, audit, package, and manual CLI validation pass.

## Non-goals

- Attaching, detaching, or filtering tools stored on the Letta agent.
- Registering custom SDK tool implementations from TOML.
- Configuring MCP server processes or credentials.
- Enabling prohibited local shell, process, subagent, memory-mutation, worktree, interactive-input, or alternate tools that bypass watched-filesystem mutation guards.
- Letting prompt text grant tools or change tool policy.
- Persisting tool inputs or approval decisions.

## Implementation links

- `src/client-tools.ts` defines configurable policy lookup plus reserved and prohibited local tool names.
- `src/config.ts` validates defaults, names, duplicates, policies, and strict TOML/JSON input; it also serializes `[tools]`.
- `src/agent.ts` combines safe configured extras with mode-specific file tools, enforces auto/ask decisions, filters invalid programmatic options, keeps named routes filesystem-read-only, and never passes arbitrary input to generic approval callbacks.
- `src/watch.ts` requires interactive support for configured `ask` tools, passes policy into every route, and reports active counts.
- `src/cli.ts` provides name-only interactive approval and documents the config surface.
- `hypervigilant.schema.json`, `hypervigilant.example.toml`, `README.md`, and the demo document the client/server boundary and native authority of configured tools.
- `tests/config.test.ts`, `tests/agent.test.ts`, and `tests/integration.test.ts` cover migration defaults, strict validation, aliases, session options, approval behavior, input hiding, YOLO isolation, named routes, and missing callbacks.
- Live acceptance loaded and auto-approved `TodoWrite` through `[tools]`, delivered a real file change, and verified two `TodoWrite` call/response records by tool name only. An unknown bundled name failed before agent processing without advancing the snapshot.
