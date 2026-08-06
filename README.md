# Hypervigilant

**Trigger persistent Letta agents from file changes.**

Hypervigilant watches selected text files and turns their changes into persistent [Letta Agent SDK](https://docs.letta.com/agent-sdk) conversations. It sends exact unified diffs, preserves conversation context across restarts, and lets the agent review, use its attached Letta tools, or edit the watched project.

It is not tied to code or specifications. It can watch any directory of text files: a software project, an Obsidian vault, documentation, operational notes, infrastructure configuration, localization files, research, or prose.

## What it enables

- **The Doc:** Edit one document, save it, and let a persistent agent turn the new intent into the next project state.
- **Continuous code review:** Give a persistent agent every saved change from an IDE or coding agent.
- **Living knowledge bases:** Let an agent follow and revise notes over time. Per-file routing can give each note its own conversation.
- **Documentation maintenance:** Detect when source changes make documentation stale, then prepare repairs in an isolated Git worktree.
- **Standing specialist reviews:** Route the same change to persistent security, API, documentation, or test conversations.
- **Event-driven automation:** Let tools attached to the agent publish updates, create work items, search other systems, or notify people in response to a file change.
- **Configuration and infrastructure review:** Watch CI, Terraform, deployment configuration, SQL migrations, or environment templates before they reach CI.
- **Localization synchronization:** Let one language-file edit trigger review or updates for related locales.
- **Prose and research workflows:** Review contracts, RFCs, essays, reports, prompt files, CSVs, or other text as they change.
- **Agent-on-agent oversight:** Put an independent Letta agent over files another coding agent is editing.

The reusable primitive is simple: **a file changes, a persistent agent gets the diff and can act.**

## How it works

1. Hypervigilant records a baseline for matching files.
2. It watches additions, edits, and deletions.
3. Repeated saves are batched and collapsed.
4. Each batch becomes a unified diff against the last successfully delivered content.
5. The diff is sent to a persistent Letta conversation.
6. The agent reviews the change, uses its attached Letta tools, or makes scoped file edits.
7. Successful delivery advances the baseline. Failed delivery does not.

Changes made while Hypervigilant is stopped are detected at the next startup. The resulting diff describes the net change since the agent last received that file.

When the agent edits a watched file, Hypervigilant suppresses the resulting watcher event and folds the final text into the baseline. This prevents agent-edit feedback loops.

## Quick start

### Requirements

- [Bun](https://bun.sh) 1.2 or newer
- Node.js 22.19 or newer for the Agent SDK local runtime
- A Letta account and API key

```bash
bun install
cp .env.example .env
# Add LETTA_API_KEY=sk-let-... to .env

# Configure any directory with an existing Letta agent.
bun run dev -- init /path/to/project \
  --non-interactive \
  --agent-id agent-xxx \
  --project my-project

# Start watching it.
bun run dev -- watch /path/to/project
```

`init` can also create an agent interactively:

```bash
bun run dev -- init /path/to/project --create-agent
```

The first `watch` establishes a baseline. It does not send every existing file to the agent.

Build and link the command when you want to use `hypervigilant` directly:

```bash
bun run build
bun link
hypervigilant --help
```

## Examples

### Watch an Obsidian vault

```toml
version = 1
project = "notes"
agent_id = "agent-xxx"
include = ["**/*.md"]
exclude = [".obsidian/**", ".trash/**", ".hypervigilant/**"]
mode = "edit"
routing = "per-file"
instructions = "Keep each note accurate and internally consistent. Preserve the author's voice."
```

With `routing = "per-file"`, each note gets a persistent conversation. The default edit policy asks before every agent write.

### Watch a software project safely

```toml
version = 1
project = "application"
agent_id = "agent-xxx"
include = ["src/**", "tests/**", "docs/**", "*.md"]
exclude = ["node_modules/**", "dist/**", ".git/**", ".hypervigilant/**"]
mode = "edit"
routing = "project"
instructions = "Review changes in project context. Fix concrete regressions without unrelated refactors."

[worktree]
enabled = true
auto_commit = true
branch_prefix = "hypervigilant"
```

Worktree mode keeps the source checkout unchanged. Hypervigilant watches a generated branch, runs local file tools there, and commits each successful batch for explicit merge.

### Add persistent specialist reviewers

```toml
[[prompt_rules]]
name = "security-review"
match = ["src/auth/**", "infra/**", "**/*.tf"]
events = ["add", "change", "delete"]
prompt = "Review authentication, authorization, secret handling, and trust boundaries."
conversation = "security"

[[prompt_rules]]
name = "test-review"
match = ["src/**"]
prompt = "Check whether this change has adequate regression coverage."
conversation = "tests"
```

`security` and `tests` are logical names. Hypervigilant creates their conversations on first use, stores the returned IDs in private state, and resumes them later. Named specialist conversations cannot modify local files. They can still use tools attached to the Letta agent. The default project or per-file conversation remains the only local-file mutation owner.

One change can match several rules and be delivered to several named conversations. Rules sharing one name are combined in configuration order.

Inspect rule selection without contacting an agent:

```bash
hypervigilant prompts list /path/to/project
hypervigilant prompts test src/auth/login.ts \
  --event change \
  --project /path/to/project
```

After a named route has run, `prompts list` shows its persisted `conv-...` ID.

## Configuration

Configuration lives in `hypervigilant.toml` at the watched project root.

- [`hypervigilant.example.toml`](hypervigilant.example.toml) is a complete example.
- [`hypervigilant.schema.json`](hypervigilant.schema.json) describes accepted keys for editor tooling.
- Legacy `hypervigilant.json` files still load when no TOML file exists.

A minimal configuration is:

```toml
version = 1
project = "my-project"
agent_id = "agent-xxx"
include = ["**/*.md", "**/*.txt"]
exclude = ["node_modules/**", ".git/**", ".hypervigilant/**"]
mode = "edit"
routing = "project"
state_dir = ".hypervigilant"

[batching]
strategy = "debounce"
delay_ms = 500
max_wait_ms = 5000
window_ms = 2000

[tools]
auto_allow = []
ask = []

[worktree]
enabled = false
auto_commit = true
branch_prefix = "hypervigilant"
```

### File selection

`include` and `exclude` use project-relative globs. Hypervigilant skips files larger than `max_file_size_bytes` and rejects binary content by scanning for null bytes. It does not assume Markdown or source code.

Symbolic links are not followed.

### Batching

- `debounce`: Wait for inactivity, with a maximum wait. Repeated saves collapse to the newest content.
- `fixed-window`: Collect changes for a fixed interval.
- `immediate`: Flush on the next microtask.

Agent turns are serialized. Hypervigilant does not dispatch concurrent file editors.

### Conversation routing

- `project`: One persistent conversation receives the watched project's changes.
- `per-file`: Each file gets its own persistent conversation.
- Named prompt conversations: Matching rules dispatch filesystem-read-only specialist turns under logical names.

Changing the configured agent clears all stored conversation routes.

### Global and conditional instructions

`instructions` are sent with every delivery. `[[prompt_rules]]` add instructions for matching paths and events.

```toml
instructions = "Review changes in the context of this project."

[[prompt_rules]]
name = "documentation"
match = ["docs/**", "README.md"]
events = ["add", "change", "delete"]
prompt = "Check links, examples, and claims against current behavior."
conversation = "documentation"
```

Supported rule events are `add`, `change`, and `delete`. Prompt rules add message text only. They cannot grant tools, change permissions, or bypass guards.

Restart the watcher after changing prompt-rule configuration.

## Permissions

The configured `mode` supplies the default policy:

- `review`: Local file access is limited to Read, LS, Glob, and Grep.
- `edit`: Local file access also includes Edit and Write, with an approval prompt for each mutation.

A runtime override can change the next batch without restarting the watcher:

```bash
hypervigilant permissions status /path/to/project
hypervigilant permissions review /path/to/project
hypervigilant permissions ask /path/to/project
hypervigilant permissions yolo /path/to/project
hypervigilant permissions reset /path/to/project
```

YOLO auto-approves Edit and Write only after Hypervigilant checks the tool and path. It does not change configured client-tool policies or enable prohibited shell, process, subagent, interactive-input, memory-mutation, unguarded file-mutation, or unconfigured tools, paths outside the watched root, symlinked mutation paths, Hypervigilant control files, or Git metadata.

In direct mode, YOLO changes source files in place. In worktree mode, changes remain on the generated branch.

Named specialist conversations stay filesystem-read-only under every policy, including YOLO.

## Agent tools

Tools attached to the selected Letta agent remain available. These can search external systems, update another service, send a notification, or perform any other action implemented by the agent's tool configuration.

Hypervigilant separately controls tools that execute in its local Agent SDK runtime. Extra bundled client tools can be selected in TOML:

```toml
[tools]
auto_allow = ["ViewImage"]
ask = []
```

- `auto_allow` exposes each named tool and approves every call without a terminal prompt.
- `ask` exposes each named tool and asks before every call.
- Ask prompts show the tool name but hide arbitrary tool input because it can contain secrets.
- A missing interactive callback denies an `ask` tool.
- Tool names must match tools bundled with the active Letta Code runtime. An unknown name fails the delivery before the agent can process the change.
- Extra tools keep their native behavior. Hypervigilant's watched-root and worktree guards apply only to its managed Edit and Write tools.

`auto_allow` is an explicit authority grant. Configure only tools whose complete behavior you trust. An `ask` policy prevents silent execution, but its intentionally minimal prompt does not show arguments.

The local client toolset starts from `base: "none"`. Hypervigilant adds its mode-specific file tools and the names configured above. Read, LS, Glob, Grep, Edit, and Write are managed by Hypervigilant and cannot be listed. Local shell/process tools, subagent delegation, interactive input, worktree control, memory mutation, and alternate watched-filesystem editors remain prohibited. Hypervigilant rejects their snake_case and model-specific aliases too.

TaskCreate, TaskGet, TaskList, TaskUpdate, and TodoWrite only manage session task metadata, so they remain configurable. They do not launch subagents. The Task/Agent delegation tool is prohibited. `write_artifact_file` is also configurable under its native `~/.letta/artifacts` confinement; it cannot write into the watched project. Restart the watcher after changing `[tools]`.

The permission manager applies only to local Edit and Write calls. YOLO does not auto-approve tools under `ask`. Named specialist conversations keep configured extra tools but cannot use Edit or Write.

Tools attached to the Letta agent execute under their own Letta tool rules and are not selected or filtered by `[tools]`. Hypervigilant's terminal prompt cannot answer a server-side approval requested by an attached tool. Configure the agent's tool rules for unattended use.

## Isolated Git worktrees

Initialize with `--worktree` or set `worktree.enabled = true`.

The source repository must have a commit and a clean checkout. Hypervigilant creates one reusable branch and linked worktree outside the repository. Read, Edit, and Write operate there. Successful batches are committed with normal Git hooks.

```bash
hypervigilant worktree status /path/to/project
hypervigilant worktree merge /path/to/project
hypervigilant worktree cleanup /path/to/project
```

Normal cleanup requires a clean worktree and a branch already merged into the source `HEAD`. Explicit destructive cleanup is available when you intend to discard the branch:

```bash
hypervigilant worktree cleanup /path/to/project --discard
```

Hypervigilant does not push branches, bypass hooks, or change Git configuration.

## State and execution

The agent and conversations live in Letta Cloud. Tools attached to the agent execute through their configured Letta environment. Local file tools run through the Agent SDK's local App Server against the watched checkout or isolated worktree.

Private state stores:

- The last successfully delivered text, hash, and size for each file
- Project, per-file, and named conversation IDs
- The runtime permission override
- Worktree metadata and process locks when worktree mode is active

Full text is required to create exact incremental diffs after restart. Keep the state directory private. The default `.hypervigilant/` directory is excluded from Git.

API key lookup order is:

1. The watched project's `.env`
2. The invocation directory's `.env`
3. The ambient environment

The key must start with `sk-let-`. It is passed to the local Agent SDK runtime through its environment and is not stored in configuration or state.

## Safety model

- The local Agent SDK toolset starts from `base: "none"`; tools attached to the Letta agent remain available under their own rules.
- Review mode exposes local read tools plus explicitly configured extras.
- Edit and Write stay inside the watched root.
- Local shell/process, subagent-delegation, interactive-input, memory-mutation, worktree, watched-filesystem mutation bypasses, and unconfigured client tools are denied.
- Configured `ask` tools never receive automatic approval from YOLO.
- Client-tool approval prompts do not print tool input.
- Symlinked mutation paths are denied.
- Hypervigilant state, active configuration, and Git metadata cannot be changed by the agent.
- Failed delivery does not advance affected snapshots.
- A changed path waits for its default and all matching named conversations before it is complete.
- Ambiguous post-send failures are not retried automatically.
- Agent file writes are suppressed from the watcher to prevent feedback loops.
- Worktree commits contain only delivered and approved mutation paths.
- Process locks prevent overlapping worktree watchers, merges, and cleanup.

## Included demos

[`demo/the-doc/`](demo/the-doc/) is **The Doc**: one `PROJECT.md` file in a toolbar-free browser editor. Edit the formatted document and press Ctrl+S or Command+S. Each changed save dispatches the agent, and the agent's file revision appears in the open editor. The demo prompt tells the agent to make the diff true with verified workspace changes instead of only discussing it. A right-hand listener gutter shows which processes receive the diff and what each process is doing. Relative Markdown images render from guarded workspace assets.

```bash
bun run demo:the-doc
```

[`demo/spec-guardian/`](demo/spec-guardian/) shows a persistent agent reviewing TypeScript against `SPEC.md`. It demonstrates prompt rules, named reviewers, approval-gated edits, YOLO, worktree commits, merge, and cleanup.

Both demos use the same file-change-to-agent pipeline. They do not define Hypervigilant's product boundary.

## Commands

```text
hypervigilant init [path]                 Create project configuration
hypervigilant watch [path]                Start the watcher
hypervigilant watch [path] --config FILE  Use a non-default config path
hypervigilant permissions ...             Inspect or change runtime policy
hypervigilant prompts list ...            List prompt rules and named routes
hypervigilant prompts test ...            Test rule matching without an agent call
hypervigilant worktree status|merge|cleanup
hypervigilant version                       Print the installed version
hypervigilant help
```

Run `hypervigilant help` for all flags.

## Limits

- Hypervigilant watches text files only.
- A rename appears as a deletion and an addition.
- Batching reports the net text change, not every intermediate save.
- Prompt-rule configuration is loaded when the watcher starts.
- Agent turns and named specialist dispatches run sequentially.
- One watcher and one isolated worktree can own a state directory.
- Very large document collections need a different snapshot store than the current JSON file.

## Development

```bash
bun install
bun run check
bun run test:demo
bun audit
npm pack --dry-run
```

The opt-in live suite uses a real Agent SDK session and archives its temporary conversations:

```bash
HYPERVIGILANT_LIVE_TEST=1 \
HYPERVIGILANT_TEST_AGENT_ID=agent-xxx \
LETTA_API_KEY=... \
bun test tests/live.test.ts
```

## License

Apache-2.0
