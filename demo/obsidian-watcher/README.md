# Obsidian Watcher

**Write naturally. Let one persistent steward carry verified changes through the vault.**

Obsidian Watcher connects every non-state Markdown save to one dedicated Letta Auto agent. The agent reads the vault's local conventions, keeps one project conversation across saves and restarts, makes approval-gated edits, and stays quiet when nothing should change.

The user interacts with one steward, not a panel of reviewers. The steward may inspect links, evidence, indexes, project state, and nearby notes as needed, but those are parts of one job: keeping the vault trustworthy while the user writes.

## Run the controlled story

From the Hypervigilant repository root:

```bash
bun run demo:obsidian-watcher
```

The first run:

1. Copies [`sample/`](sample/) into ignored `workspace/`.
2. Creates one dedicated agent with `model: "auto"` and MemFS disabled.
3. Writes `hypervigilant.toml`.
4. Records the existing vault as a no-send baseline.
5. Starts watching every `*.md` file.

To reuse an existing agent:

```bash
bun run demo:obsidian-watcher -- --agent-id agent-xxx
```

After the watcher prints `Baseline established` and `Watching`, introduce one ordinary work event from another terminal:

```bash
bun demo/obsidian-watcher/scripts/introduce-change.ts
```

The script saves two files inside one idle window:

- `projects/publishing-log.md` gains a complete synthetic deployment receipt: URL, deployment ID, and successful readback.
- `Inbox/field-guide-release.md` asks `@watcher` to propagate that verified publication while preserving the handoff as source.

The steward should inspect `VAULT.md`, confirm the receipt, and propose these edits:

- Change `projects/field-guide.md` from `pending-publication` to `published`.
- Replace its publication step with the next real action: announce the release.
- Change the field guide's status marker in `index.md`.
- Append one evidence-backed receipt to `Watcher Inbox.md`.

Hypervigilant shows each target and diff before asking for approval. The source handoff remains unchanged because both the vault contract and the request tell the steward to preserve it; this is an approval-visible agent convention, not a filesystem lock. Agent-authored edits advance watcher state without generating a second delivery.

That single loop demonstrates the useful capacity: a captured fact becomes consistent durable state, under explicit authority, with an audit trail.

## The sample's trust contract

The agent reads the contract from [`sample/VAULT.md`](sample/VAULT.md). It does not receive a hard-coded universal Obsidian schema.

The sample contract establishes that:

- `@watcher` is an explicit request, not proof that its factual premises are true.
- Raw inbox and meeting notes remain source material.
- Exact local receipts can authorize state propagation through the approval gate.
- Ambiguous semantic choices go to `Watcher Inbox.md` instead of being silently resolved.
- Material work creates one receipt; a no-op creates none.

This split is intentionally based on evidence and meaning. It is not based on which internal reviewer happened to notice the problem.

## Why one Auto agent

One settled batch creates one agent turn. Letta Auto chooses the model; Hypervigilant owns the durable conversation, local tool boundary, approval flow, batching, snapshots, and restart behavior.

The debounce waits for 2.5 seconds of silence after the latest save instead of treating every Obsidian autosave as a separate thought. If saves continue, a ten-second maximum flushes the batch anyway. Adjust both values for the vault's actual writing cadence.

The agent can inspect additional files through read-only local tools. Hypervigilant sends only changed-file diffs in the event itself, rather than embedding the whole vault in every prompt.

## Use it with another vault

Setup writes a configuration into an explicit vault. It never copies the synthetic sample there:

```bash
bun run demo:obsidian-watcher:setup -- \
  --vault "$HOME/Documents/My Vault"
```

To select an existing agent:

```bash
bun run demo:obsidian-watcher:setup -- \
  --vault "$HOME/Documents/My Vault" \
  --agent-id agent-xxx
```

Setup preserves an existing configuration. `--force` refreshes the steward instructions while retaining its agent; combine `--force` with `--agent-id` to replace the agent selection.

Before starting, adapt the generated instructions to the vault's actual trust contract. A useful real vault usually documents:

- which local file defines conventions
- which changes are mechanical
- which receipts establish completion
- which authored notes must remain source material
- where unresolved questions and action receipts should go
- whether an inline command such as `@watcher` has authority

Then start the watcher:

```bash
bun run dev -- watch "$HOME/Documents/My Vault"
```

The default configuration watches `**/*.md` and excludes only Git, Letta, Obsidian, Hypervigilant, and trash state. Folder names and capitalization carry no hidden authority.

The first scan stores full text for every included file under `.hypervigilant/`. Narrow `include` deliberately if that local state is too large. Keep `.hypervigilant/` and `hypervigilant.toml` out of public version control when they expose private paths, prompts, or agent IDs.

## Reset the sample

Stop the watcher, then run:

```bash
bun run demo:obsidian-watcher:reset
```

Reset restores the sample files and removes the synthetic handoff without deleting the agent or its conversation ID. The next watcher start delivers the reset as one offline batch. Remove `demo/obsidian-watcher/workspace/` for a completely fresh baseline.
