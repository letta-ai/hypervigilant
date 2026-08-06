# Spec guardian demo

This demo shows a persistent agent reviewing a source change against a written contract.

## Files

- `SPEC.md` defines the greeting behavior.
- `src/greeting.ts` starts in a correct state.
- `tests/greeting.test.ts` proves the contract.
- `scripts/introduce-drift.ts` replaces the implementation with a smaller but incorrect version.
- `scripts/reset.ts` restores the correct implementation.
- `scripts/setup-worktree.ts` creates a standalone Git fixture for the isolated branch flow.

## 1. Configure the demo

From the Hypervigilant repository root:

```bash
bun demo/spec-guardian/scripts/setup.ts
```

The setup script reads the agent ID from the root `hypervigilant.toml` and writes an edit-mode demo config. Every proposed file change still requires approval. You can select another existing agent or use read-only review mode explicitly:

```bash
bun demo/spec-guardian/scripts/setup.ts --agent-id agent-xxx
bun demo/spec-guardian/scripts/setup.ts --mode review
```

The included `instructions` tell the agent to treat `SPEC.md` as the contract. Two canned prompt rules sharpen spec changes and implementation changes. The demo leaves `[tools]` empty; add bundled local client tools there only when the demo needs them. Hypervigilant checks that the selected agent exists before it creates a baseline.

Inspect the rules without sending an agent message:

```bash
bun run dev -- prompts list demo/spec-guardian
bun run dev -- prompts test SPEC.md --event change --project demo/spec-guardian
bun run dev -- prompts test src/greeting.ts --event change --project demo/spec-guardian
```

The first test selects `spec-change` in the persistent `spec-review` conversation. The second selects `implementation-check` in `implementation-review`. These named conversations cannot modify local files, although tools attached to the Letta agent remain available. The default project conversation still receives the full batch and owns any approved repair.

## 2. Confirm the clean implementation

```bash
bun test demo/spec-guardian/tests/greeting.test.ts
```

All three tests should pass.

## 3. Start Hypervigilant

```bash
bun run dev -- watch demo/spec-guardian
```

The first run records a baseline. Existing files are not sent.

## 4. Introduce contract drift

In another terminal:

```bash
bun demo/spec-guardian/scripts/run-demo.ts
```

The guarded runner compares the current file with Hypervigilant's saved snapshot. If the previous run already contains drift, it resets the file, waits for that delivery, and only then introduces a new drift. This prevents quick reset-and-drift writes from collapsing back to the saved content.

The replacement no longer trims names, uses the wrong greeting, and removes the empty-name fallback. Hypervigilant sends only the source diff. The persistent agent can read `SPEC.md` and the tests from the local demo folder.

### Example review

The exact wording varies by model. A successful review should identify these contract mismatches and propose the smallest repair:

```text
Three contract mismatches found in src/greeting.ts:

1. R1: name is used without trimming surrounding whitespace.
2. R2: an empty name returns "Hi, !" instead of "Hello, stranger!".
3. R3: non-empty names use "Hi," instead of the required "Hello," prefix.
```

```diff
 export function formatGreeting(name: string): string {
-	return `Hi, ${name}!`;
+	const normalized = name.trim();
+	return normalized ? `Hello, ${normalized}!` : "Hello, stranger!";
 }
```

This is the output shape produced during the live demo run. Edit mode is the default, so the agent can follow the review with an Edit proposal. Hypervigilant shows the target and diff before asking for approval. Bash remains unavailable.

Deny the repair or run in review mode, then run the tests to confirm the defect:

```bash
bun test demo/spec-guardian/tests/greeting.test.ts
```

## 5. Compare read-only mode

Stop the watcher and regenerate the demo config in review mode:

```bash
bun demo/spec-guardian/scripts/setup.ts --mode review
bun run dev -- watch demo/spec-guardian
```

Review mode exposes only Read, LS, Glob, and Grep. The agent reports the same contract mismatches but cannot propose a file mutation.

## 6. Run the isolated branch flow

Create a disposable standalone Git copy:

```bash
bun demo/spec-guardian/scripts/setup-worktree.ts --force
bun run dev -- watch /tmp/hypervigilant-spec-guardian-worktree
```

Copy the path from `Edit watched files in:`. In another terminal, introduce drift inside that worktree:

```bash
bun "<printed-worktree-path>/scripts/introduce-drift.ts"
```

Approve the proposed repair. Hypervigilant commits the observed drift and repair on the generated branch. The source checkout remains unchanged.

To run the same flow without a per-edit prompt, enable scoped YOLO before introducing drift:

```bash
bun run dev -- permissions yolo /tmp/hypervigilant-spec-guardian-worktree
```

YOLO auto-approves only Edit and Write inside the printed worktree. Bash and outside-root writes remain denied. The watcher reads the new policy before the next batch, so no restart is required. Restore prompts with `permissions ask` or remove the override with `permissions reset`.

After the repair, stop the watcher, then inspect and merge the result:

```bash
bun run dev -- worktree status /tmp/hypervigilant-spec-guardian-worktree
bun run dev -- worktree merge /tmp/hypervigilant-spec-guardian-worktree
bun run dev -- worktree cleanup /tmp/hypervigilant-spec-guardian-worktree
```

The source checkout changes only after the explicit merge command.

## 7. Reset

```bash
bun demo/spec-guardian/scripts/reset.ts
bun test demo/spec-guardian/tests/greeting.test.ts
```

Stop the watcher before removing its private state:

```bash
rm -rf demo/spec-guardian/.hypervigilant
rm demo/spec-guardian/hypervigilant.toml
```

The example file remains unchanged for the next run.
