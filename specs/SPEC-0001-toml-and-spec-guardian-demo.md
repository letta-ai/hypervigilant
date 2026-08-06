---
id: SPEC-0001
title: TOML configuration and spec guardian demo
status: implemented
dependencies: [SPEC-0000]
supersedes: []
implementation_links: [src/config.ts, src/init.ts, src/agent.ts, demo/spec-guardian/README.md, tests/config.test.ts]
---

# TOML configuration and spec guardian demo

## Goal

Make Hypervigilant configuration easy to read and edit by hand. Add a small demo that shows a persistent agent reviewing source changes against a written specification.

## Product behavior

- `hypervigilant.toml` is the primary project configuration file.
- TOML uses snake-case keys and a `[batching]` table.
- Hypervigilant uses Bun's native TOML parser. It does not add a YAML dependency.
- `hypervigilant init` writes deterministic, atomic TOML.
- Explicit `.json` config paths and an existing default `hypervigilant.json` continue to load as a legacy compatibility path.
- Machine-managed snapshots remain JSON under the private state directory.
- Configuration can include optional project-specific agent instructions.
- New configurations default to approval-gated edit mode. Users can select read-only review mode explicitly.
- The spec guardian demo includes a written behavior contract, a correct implementation, a controlled script that introduces drift, a reset script, a TOML example, and a short walkthrough.

## Acceptance criteria

- [x] Init creates valid `hypervigilant.toml` with the selected agent, mode, routing, globs, state directory, and batching values.
- [x] TOML parser errors name the file and explain that the content is invalid TOML.
- [x] Unknown TOML keys and invalid values fail through the existing strict configuration schema.
- [x] Snake-case TOML keys map exactly to the internal configuration model.
- [x] Watch uses `hypervigilant.toml` by default.
- [x] A legacy `hypervigilant.json` still loads when no TOML config exists.
- [x] Explicit TOML and JSON `--config` paths both work.
- [x] Project instructions are included in agent delivery prompts.
- [x] New configs and the demo default to edit mode while explicit review mode remains read-only.
- [x] The demo starts from a clean baseline and can introduce a source change that violates `SPEC.md`.
- [x] The demo walkthrough explains expected review output, edit-mode behavior, reset, and cleanup.
- [x] Existing project configuration is migrated to TOML without changing its effective values.
- [x] Unit, integration, CLI, package, and live demo checks pass.

## Non-goals

- Supporting YAML.
- Changing the state-file format from JSON.
- Automatically rewriting arbitrary comments or formatting in user-authored TOML.
- Adding a graphical demo interface.
- Automatically applying agent edits without approval.

## Dependencies

- `SPEC-0000` defines the existing watcher, persistence, routing, and permission behavior.

## Implementation links

- `src/config.ts` parses snake-case TOML, validates strict keys, writes deterministic TOML, and supports legacy JSON.
- `src/init.ts` writes the primary TOML configuration atomically.
- `src/agent.ts` carries project instructions into reviews and directs edit-mode repairs through tool approval.
- `demo/spec-guardian/README.md` owns the runnable walkthrough.
- `tests/config.test.ts` covers TOML parsing, serialization, errors, precedence, and legacy fallback.
