# Hypervigilant

**Trigger persistent Letta agents from file changes.**

Hypervigilant watches selected local files and sends each saved change to a persistent [Letta Agent SDK](https://docs.letta.com/agent-sdk) conversation. Text files produce unified diffs. Binary files produce metadata events.

The agent can review changes, use attached Letta tools, or use guarded local file tools. Conversations and delivered-file state survive watcher restarts.

## Quick start

### Requirements

- [Bun](https://bun.sh) 1.2 or newer
- Node.js 22.19 or newer
- A Letta account and API key

Clone the repository and install its dependencies:

```bash
git clone https://github.com/letta-ai/hypervigilant.git
cd hypervigilant
bun install
cp .env.example .env
```

Set `LETTA_API_KEY=sk-let-...` in `.env`. Then create an empty watched directory and configure an agent:

```bash
mkdir -p ~/hypervigilant-demo
bun run dev -- init ~/hypervigilant-demo --create-agent
```

Start the watcher:

```bash
bun run dev -- watch ~/hypervigilant-demo
```

The first run records existing files without sending them. Keep the watcher running. In another terminal, create a watched file:

```bash
printf '# First change\n' > ~/hypervigilant-demo/README.md
```

Hypervigilant sends the addition to the agent. Later saves resume the same conversation.

If you already have an agent, configure it without prompts:

```bash
bun run dev -- init ~/hypervigilant-demo \
  --non-interactive \
  --agent-id agent-xxx \
  --project hypervigilant-demo
```

Build and link the command to use `hypervigilant` directly:

```bash
bun run build
bun link
hypervigilant help
```

## What Hypervigilant does

- Watches code, notes, documentation, configuration, prose, and file inboxes.
- Resumes one project conversation, one conversation per file, or named specialist conversations.
- Gives the default conversation guarded local file tools under `review`, `ask`, or `yolo` policy.
- Lets attached Letta tools react to a change through their existing tool rules.

## How delivery works

1. Hypervigilant records a baseline for files that match the configured globs.
2. It batches additions, changes, and deletions. Repeated saves collapse to the latest content.
3. It sends text diffs or binary metadata to the configured conversation routes.
4. It advances each snapshot only after all required deliveries succeed.
5. It suppresses agent file writes from the watcher and records their final state.

Hypervigilant detects changes made while it was stopped at the next startup. Agent turns run sequentially.

## Examples

### Tag new images in an inbox

This configuration sends new images to an image-capable agent. The agent records descriptions and tags in `catalog.md`.

```toml
version = 1
project = "image-inbox"
agent_id = "agent-xxx"
include = ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp"]
exclude = [".hypervigilant/**"]
max_file_size_bytes = 25000000
mode = "edit"
routing = "project"
instructions = "Use ViewImage for each added or changed image. Update catalog.md with its path, description, category, and tags."

[tools]
auto_allow = ["ViewImage"]
```

Start the watcher before you add images. If catalog writes must run without approval, use the following command:

```bash
hypervigilant permissions yolo /path/to/image-inbox
```

`auto_allow` gives `ViewImage` its native path access. If each image read needs approval, replace it with `ask = ["ViewImage"]`.

Hypervigilant reports image events but does not move files. File moves need a guarded client tool or an attached Letta tool.

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

Each note gets a persistent conversation. The default edit policy asks before each agent write.

### Watch a software project in a worktree

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

Hypervigilant runs local file tools in a linked worktree. It commits each successful batch for an explicit merge into the source checkout.

### Maintain a changelog

Watch source files and let the agent append a summary to `CHANGES.md` for each batch.

```toml
version = 1
project = "changelog"
agent_id = "agent-xxx"
include = ["src/**", "tests/**"]
exclude = ["node_modules/**", ".git/**", ".hypervigilant/**", "CHANGES.md"]
mode = "edit"
routing = "project"
instructions = "Append a one-line entry to CHANGES.md for each batch. Describe what changed and why."
```

The agent writes to `CHANGES.md` in the watched root. Hypervigilant suppresses the resulting watcher event, so the changelog update does not trigger another delivery.

### Add specialist reviewers

Add the following rules to an existing configuration:

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

Hypervigilant creates each named conversation on its first match and resumes it later. Named conversations can use attached tools but cannot modify local files.

Test rule selection without contacting an agent:

```bash
hypervigilant prompts list /path/to/project
hypervigilant prompts test src/auth/login.ts \
  --event change \
  --project /path/to/project
```

## Configuration

Hypervigilant reads `hypervigilant.toml` from the watched project root. A configuration requires the following three fields:

```toml
version = 1
project = "my-project"
agent_id = "agent-xxx"
```

The remaining fields have defaults. See the following files for the complete configuration:

- [`hypervigilant.example.toml`](hypervigilant.example.toml) contains every common section.
- [`hypervigilant.schema.json`](hypervigilant.schema.json) describes each accepted key.

Legacy `hypervigilant.json` files load only when no TOML file exists.

| Configuration key | Default | Purpose |
| --- | --- | --- |
| `include` | Markdown and text files | Select project-relative paths. |
| `exclude` | Git, `node_modules`, and state paths | Remove matching paths from the watch set. |
| `max_file_size_bytes` | `1048576` | Skip files above this size. |
| `mode` | `edit` | Select read-only or approval-gated local file tools. |
| `routing` | `project` | Use one project conversation or one conversation per file. |
| `state_dir` | `.hypervigilant` | Store private snapshots and route IDs. |
| `[batching]` | `debounce` | Control when saved changes form a batch. |
| `[tools]` | no extra tools | Expose selected Agent SDK client tools. |
| `[worktree]` | disabled | Run local file tools on an isolated Git branch. |
| `[[prompt_rules]]` | none | Add path-specific prompts and named conversations. |

`include` and `exclude` use project-relative globs. Hypervigilant does not follow symbolic links.

Text files produce unified diffs. A file with a null byte in its first 8 KiB produces a metadata-only binary event.

Batching supports the following strategies:

- `debounce` waits for inactivity and enforces a maximum wait.
- `fixed-window` collects changes for a fixed interval.
- `immediate` flushes changes on the next microtask.

Prompt rules match `add`, `change`, and `delete` events. They add message text but cannot grant tools or change permissions.

Restart the watcher after you change prompt rules, tools, or other project configuration.

## Permissions and tools

Hypervigilant uses the following local file policies:

| Policy | Local file tools | Approval |
| --- | --- | --- |
| `review` | `Read`, `LS`, `Glob`, and `Grep` | No file mutations. |
| `ask` | `Read`, `LS`, `Glob`, `Grep`, `Edit`, and `Write` | Ask before each mutation. |
| `yolo` | `Read`, `LS`, `Glob`, `Grep`, `Edit`, and `Write` | Approve guarded mutations automatically. |

The configuration mode `review` selects the `review` policy. The mode `edit` selects the `ask` policy.

Change the runtime policy without restarting the watcher:

```bash
hypervigilant permissions status /path/to/project
hypervigilant permissions review /path/to/project
hypervigilant permissions ask /path/to/project
hypervigilant permissions yolo /path/to/project
hypervigilant permissions reset /path/to/project
```

Hypervigilant confines managed `Edit` and `Write` calls to file paths inside the watched root. It denies control files, Git metadata, and symbolic-link paths.

The local toolset starts from `base: "none"`. Hypervigilant denies shell tools, process tools, subagent delegation, interactive input, memory mutation, and alternate file editors.

The `[tools]` section can expose other tools bundled with the local Letta Code runtime:

```toml
[tools]
auto_allow = ["ViewImage"]
ask = []
```

- `auto_allow` approves every call to the named tool.
- `ask` requests approval for each call.
- Ask prompts show the tool name but hide its input because the input can contain secrets.
- Extra tools keep their native authority. Watched-root guards apply only to managed `Edit` and `Write` calls.

Tool names must exist in the active Letta Code runtime. An unknown name stops delivery before the agent processes the change.

`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, and `TodoWrite` manage session metadata. They do not launch subagents. `write_artifact_file` keeps its native `~/.letta/artifacts` boundary.

Tools attached to the selected Letta agent remain under their Letta tool rules. The `[tools]` section does not select or restrict attached tools.

The Hypervigilant terminal cannot answer approvals from attached server tools. Configure attached-tool rules before an unattended run.

YOLO applies only to managed `Edit` and `Write` calls. It does not approve tools under `ask` or change attached-tool rules.

## Isolated Git worktrees

Enable worktree mode with `--worktree` during initialization or set `worktree.enabled = true`.

The source repository must have a commit and a clean checkout. Hypervigilant creates one linked worktree and branch outside the source repository.

Use the following commands to inspect and finish worktree changes:

```bash
hypervigilant worktree status /path/to/project
hypervigilant worktree merge /path/to/project
hypervigilant worktree cleanup /path/to/project
```

Normal cleanup requires a clean worktree and a branch merged into the source `HEAD`. If you intend to delete unmerged work, add `--discard`:

```bash
hypervigilant worktree cleanup /path/to/project --discard
```

Hypervigilant runs normal Git hooks. It does not push branches, bypass hooks, or change Git configuration.

## State and safety

Agents and conversations live in Letta Cloud. Managed local file tools run through the Agent SDK local App Server.

Hypervigilant stores private state under `.hypervigilant/` by default:

- Full text, hash, and size for each delivered text file
- Hash, size, and file kind for each delivered binary file
- Project, per-file, and named conversation IDs
- Permission overrides, worktree metadata, and process locks

Keep the state directory private. Hypervigilant excludes its default state directory from Git.

The API key lookup order is:

1. The watched project's `.env`
2. The invocation directory's `.env`
3. The ambient environment

The key must start with `sk-let-`. Hypervigilant passes it to the local runtime but does not store it in configuration or state.

The following rules protect delivery and local files:

- Failed deliveries do not advance affected snapshots.
- Ambiguous post-send failures do not retry automatically.
- Agent file writes do not trigger feedback deliveries.
- Binary event prompts and snapshots do not contain file bytes.
- Worktree commits contain only delivered paths and approved mutation paths.
- Process locks prevent overlapping worktree watchers, merges, and cleanup.

## Demos

[The Doc](demo/the-doc/) turns one browser-edited `PROJECT.md` file into a persistent project interface:

```bash
bun run demo:the-doc
```

The demo sends each saved change to an agent. Verified agent edits appear in the open editor without a page reload.

[Spec Guardian](demo/spec-guardian/) reviews TypeScript changes against a local `SPEC.md`. It demonstrates prompt rules, named reviewers, approvals, YOLO, and worktree lifecycle commands.

[Obsidian Watcher](demo/obsidian-watcher/) connects any Markdown change to one persistent Letta Auto steward that follows vault-local conventions, propagates verified state, and records approved work inside the vault:

```bash
bun run demo:obsidian-watcher
```

## Commands

```text
hypervigilant init [path]                    Create project configuration
hypervigilant watch [path]                   Start the watcher
hypervigilant watch [path] --config FILE     Use another config file
hypervigilant permissions ...                Inspect or change runtime policy
hypervigilant prompts list ...               List prompt rules and routes
hypervigilant prompts test ...               Test rule matching without an agent
hypervigilant worktree status|merge|cleanup  Manage the isolated worktree
hypervigilant version                        Print the installed version
hypervigilant help                           Show all commands and flags
```

## Limits

- Binary classification checks for null bytes in the first 8 KiB. Hypervigilant can treat other binary formats as text.
- A rename appears as a deletion and an addition.
- Batching reports the net change instead of each intermediate save.
- Prompt rules and tool configuration load when the watcher starts.
- Agent turns and named specialist turns run sequentially.
- One watcher and one isolated worktree can own a state directory.
- The JSON state store rewrites stored text snapshots as one file. Storage cost grows with total watched text.

## Development

Run the complete local checks:

```bash
bun install
bun run check
bun run test:demo
bun audit
npm pack --dry-run
```

The opt-in live suite creates a real Agent SDK session and archives its temporary conversations:

```bash
HYPERVIGILANT_TEST_AGENT_ID=agent-xxx \
LETTA_API_KEY=... \
bun run test:live
```

## License

Apache-2.0
