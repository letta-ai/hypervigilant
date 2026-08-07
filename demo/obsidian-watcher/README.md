# Obsidian watcher

**Give one Markdown vault several persistent kinds of attention.**

This demo runs one Hypervigilant watcher and one dedicated Letta Auto agent. Saved notes reach a default maintenance conversation plus the named specialist conversations selected by their paths:

| Listener | Matches | Job |
| --- | --- | --- |
| Default maintainer | Every watched note | Apply only unambiguous, approval-gated mechanical repairs. |
| Connections | Every watched note | Check wikilinks, index membership, and likely duplicate concepts. |
| Claims | Concepts, research, companies, AI, and agent-infrastructure notes | Separate observed or current facts from inference, plans, and history. |
| Continuity | Projects, work, and meetings | Check status, next steps, dates, receipts, and handoffs. |

The listeners are persistent conversations on one agent, not four agents. Hypervigilant runs matching routes sequentially, starting with the default conversation. Named conversations are filesystem-read-only. Their findings remain independent terminal output; Hypervigilant does not feed them back into the default maintainer. The default conversation is the only route that can propose a local edit, and each edit still needs approval.

## Run the sample vault

From the Hypervigilant repository root:

```bash
bun run demo:obsidian-watcher
```

The first run copies [`sample/`](sample/) into the ignored `workspace/` directory, creates a dedicated agent with `model: "auto"` and MemFS disabled, writes the demo config, and establishes a baseline. Every route uses that agent and submits its turn through Letta Auto.

To reuse an existing agent instead:

```bash
bun run demo:obsidian-watcher -- --agent-id agent-xxx
```

After the watcher prints `Baseline established` and `Watching`, run the prepared change in another terminal. This script targets only the ignored sample workspace; it never accepts an external vault path:

```bash
bun demo/obsidian-watcher/scripts/introduce-change.ts
```

The script saves two files inside one debounce window:

- A concept note equates a source commit with user-visible delivery, omits required frontmatter, and links to a missing note.
- A project note says a field guide is public while its publishing log still says no deployment receipt exists.

That batch reaches four routes:

```text
default project conversation
connections
claims
continuity
```

The exact findings vary by model. The connection listener should find the unresolved wikilink, the claim listener should separate a commit from a delivery receipt, and the continuity listener should catch the contradictory publication state. The default maintainer may propose a mechanical repair. Hypervigilant prints the target and diff before asking for approval.

Inspect the fan-out without contacting the agent:

```bash
bun run dev -- prompts test concepts/shipping-is-done.md \
  --event add \
  --project demo/obsidian-watcher/workspace

bun run dev -- prompts test projects/field-guide.md \
  --event change \
  --project demo/obsidian-watcher/workspace
```

## Why this uses one Auto agent

Every matching conversation produces an agent turn. A careless configuration that sends every note to six specialists is just a committee meeting with a token budget.

This demo bounds the work in three ways:

1. One dedicated worker agent owns all routes. Its setup explicitly selects Letta Auto and disables MemFS, avoiding a separate git-backed memory repo for a worker whose durable context already lives in conversations and Hypervigilant route state.
2. Specialist rules match only the note classes that need them. A concept does not trigger project continuity. A meeting note does not trigger claim review unless the configuration says it should.
3. Debouncing collapses nearby saves into one batch, and the initial scan records a baseline without sending the existing vault to the agent.

Use `hypervigilant prompts test` before adding a listener. The useful question is not whether another reviewer sounds helpful. It is which file change should be expensive enough to wake it.

## Adapt the demo to a real vault

Pass a vault path to setup. The command writes `hypervigilant.toml` but does not copy the sample notes into an external vault:

```bash
bun run demo:obsidian-watcher:setup -- \
  --vault "$HOME/Documents/My Vault"
```

The setup command does not replace an existing config. Pass `--force` to refresh the listener rules while keeping the configured agent, or combine `--force` with `--agent-id` to replace the agent selection. You can also select an existing agent during first setup:

```bash
bun run demo:obsidian-watcher:setup -- \
  --vault "$HOME/Documents/My Vault" \
  --agent-id agent-xxx
```

Review these parts of the generated config before starting the watcher:

- **`include`** starts with active concepts, notes, projects, work, meetings, MOCs, inboxes, research, companies, AI and agent-infrastructure notes, and public writing. Common lowercase and title-cased Obsidian folder names are both included. Journals, reports, consolidation logs, and large reference archives are intentionally omitted.
- **`exclude`** removes Obsidian state, trash, attachments, Hypervigilant state, and common high-volume archive directories.
- **`instructions`** permits only conservative mechanical repairs. Change it to match the vault's actual conventions.
- **`[[prompt_rules]]`** define listener cost. Delete any route that does not produce decisions or repairs you will use.

Start the configured vault explicitly:

```bash
bun run dev -- watch "$HOME/Documents/My Vault"
```

The first scan stores full text for included Markdown files under the private `.hypervigilant/` state directory. Narrow `include` before the first run on a large vault. The state directory and `hypervigilant.toml` can expose local structure and agent IDs, so keep both out of public version control.

## Reset the sample

Stop the watcher, then run:

```bash
bun run demo:obsidian-watcher:reset
```

Reset restores the sample notes and preserves the dedicated agent, route IDs, and delivery state. On the next watcher start, Hypervigilant sends the reset as an offline change; wait for that delivery before introducing the prepared change again. Remove `demo/obsidian-watcher/workspace/` if you want a completely fresh demo.
