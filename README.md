# Hypervigilant

**Trigger persistent Letta agents from file changes.**

Hypervigilant watches selected local files and sends each saved change to a persistent [Letta Agent SDK](https://docs.letta.com/agent-sdk) conversation. Text files produce unified diffs. Binary files produce metadata events.

The agent can review changes, use attached Letta tools, or use guarded local file tools. Conversations and delivered-file state survive watcher restarts.

## Quick start

### Requirements

- [Bun](https://bun.sh) 1.2 or newer
- Node.js 22.19 or newer
- A Letta Cloud account, a configured local model provider, or a self-hosted Letta App Server

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

To send files that already exist in the directory, run one scan:

```bash
bun run dev -- scan ~/hypervigilant-demo
```

A scan sends every current file selected by the configuration and exits. A later watcher reuses the saved snapshots and conversation routes. Another scan sends the selected files again.

Build and link the command to use `hypervigilant` directly:

```bash
bun run build
bun link
hypervigilant help
```

## Agent backends

Hypervigilant uses the Agent SDK across three [deployment shapes](https://docs.letta.com/agent-sdk/deployment). The configured backend owns both agent identity and conversation routes; switching it resets saved routes without discarding file snapshots.

### Letta Cloud

Cloud is the default. Agent state lives in Letta Cloud while an SDK-owned local App Server executes guarded filesystem tools on the watcher machine:

```toml
[connection]
backend = "cloud"
```

Set `LETTA_API_KEY=sk-let-...` in the watched project's `.env`, the invocation directory's `.env`, or the process environment.

### Fully local agents

Local mode starts one command-scoped App Server with the Letta local backend. Agent state, model access, and filesystem tools remain on the watcher machine. The server is reused for setup and delivery, then stopped when the scan or watcher exits. Configure a local provider in Letta Code first, then initialize Hypervigilant without a Cloud key:

```bash
letta --backend local connect ollama
bun run dev -- init /path/to/project --backend local --create-agent --non-interactive
```

The resulting configuration contains:

```toml
[connection]
backend = "local"
```

Local agents can use only models exposed by the local backend. `letta/auto` is a Cloud router, not a client-side policy for choosing among local models.

### User-managed App Server

Remote mode connects directly to a [Letta App Server](https://docs.letta.com/platform/app-server) you operate:

```bash
letta server --backend local --listen ws://127.0.0.1:4500

bun run dev -- init /path/to/project \
  --backend remote \
  --server-url ws://127.0.0.1:4500 \
  --agent-id agent-local-xxx \
  --mode review \
  --non-interactive
```

```toml
[connection]
backend = "remote"
url = "ws://127.0.0.1:4500"
shared_filesystem = false
```

Remote connections are diff-only by default. Hypervigilant sends saved diffs but exposes none of its managed filesystem tools because those tools would execute on the App Server machine rather than necessarily against the watched checkout. Tools attached directly to the selected agent remain governed by their App Server rules and must be configured independently.

Set `shared_filesystem = true` or pass `--shared-filesystem` only when the App Server sees the watched project at the same absolute path. With worktree mode, the generated isolated worktree must also exist at the same absolute path. That explicit contract enables the normal read and edit tools.

Non-loopback App Servers require TLS and bearer authentication. Keep the token outside the configuration:

```toml
[connection]
backend = "remote"
url = "wss://agents.example.com"
auth_token_env = "LETTA_APP_SERVER_TOKEN"
shared_filesystem = false
```

Hypervigilant resolves the named variable from the same project-first `.env` chain and sends it as the WebSocket bearer token. It never stores the token in configuration or state. Plaintext and unauthenticated remote connections are accepted only for loopback hosts.

## What Hypervigilant does

- Sends existing matching files once or watches for later changes.
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

`scan` uses the same file selection, routes, permissions, and state. It presents each current file as an `add` event. Before delivery, it prints file, byte, and estimated token totals. It blocks scans above the configured file or text-byte limits. After success, it removes stale matching snapshots without reporting deletion events.

## Examples

### Route workloads to different models

One configuration selects one model. Run multiple configurations when files need different models or instructions.

Each configuration must use a separate `state_dir`. Use non-overlapping `include` globs when each file must go to only one model.

The model-routing demo starts two watchers with the same agent:

```bash
bun demo/model-routing/run.ts --agent-id agent-xxx
```

The code watcher uses `letta/auto`. The notes watcher uses `openai/gpt-5.6-luna` for lower-cost triage. Each watcher owns a separate conversation.

See [`demo/model-routing`](demo/model-routing/README.md) for the generated configurations, sample edits, and model override flags.

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

Add `model` to select a model for the project:

```toml
model = "letta/auto"
```

The setting applies to every project, per-file, and named conversation in one configuration. It does not change the agent default or unrelated conversations.

If you omit `model`, each watcher conversation keeps its existing effective model. A `prompt_rule` cannot override the setting.

Run another configuration when one prompt or file group needs a different model.

The remaining fields have defaults. See the following files for the complete configuration:

- [`hypervigilant.example.toml`](hypervigilant.example.toml) contains every common section.
- [`hypervigilant.schema.json`](hypervigilant.schema.json) describes each accepted key.

Legacy `hypervigilant.json` files load only when no TOML file exists.

| Configuration key | Default | Purpose |
| --- | --- | --- |
| `model` | inherited | Select the model for Hypervigilant-owned conversations only. |
| `include` | Markdown and text files | Select project-relative paths. |
| `exclude` | Git, `node_modules`, and state paths | Remove matching paths from the watch set. |
| `max_file_size_bytes` | `1048576` | Skip files above this size. |
| `max_scan_files` | `100` | Block a scan with more selected files. |
| `max_scan_text_bytes` | `65536` | Block a scan with more total text bytes. |
| `[connection]` | `cloud` | Select Cloud, fully local, or user-managed App Server agent state. |
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

Restart the watcher after you change project configuration. Each scan loads the current configuration before delivery.

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

Agents and conversations live in the configured backend. Cloud mode runs guarded file tools through an SDK-owned local App Server. Local mode keeps state and execution on the watcher machine. Remote mode uses the user-managed App Server and remains diff-only unless a same-path shared filesystem is explicit.

Hypervigilant stores private state under `.hypervigilant/` by default:

- Full text, hash, and size for each delivered text file
- Hash, size, and file kind for each delivered binary file
- Project, per-file, and named conversation IDs
- Permission overrides, worktree metadata, and process locks

Keep the state directory private. Hypervigilant excludes its default state directory from Git.

Cloud API keys and explicitly named remote bearer-token variables use this lookup order:

1. The watched project's `.env`
2. The invocation directory's `.env`
3. The ambient environment

Cloud keys must start with `sk-let-`. Remote bearer tokens have no prefix requirement. Hypervigilant passes credentials to the selected transport but does not store their values in configuration or state.

The following rules protect delivery and local files:

- Failed deliveries do not advance affected snapshots.
- Ambiguous post-send failures do not retry automatically.
- Agent file writes do not trigger feedback deliveries.
- Binary event prompts and snapshots do not contain file bytes.
- Worktree commits contain only delivered paths and approved mutation paths.
- Process locks prevent overlapping worktree scans, watchers, merges, and cleanup.

## Demos

[The Doc](demo/the-doc/) turns one browser-edited `PROJECT.md` file into a persistent project interface:

```bash
bun run demo:the-doc
```

The demo sends each saved change to an agent. Verified agent edits appear in the open editor without a page reload.

[Spec Guardian](demo/spec-guardian/) reviews TypeScript changes against a local `SPEC.md`. It demonstrates prompt rules, named reviewers, approvals, YOLO, and worktree lifecycle commands.

## Commands

```text
hypervigilant init [path]                    Create project configuration
hypervigilant scan [path]                    Send matching files once and exit
hypervigilant status [path]                  Show read-only configuration and state overview
hypervigilant watch [path]                   Start the watcher
hypervigilant watch [path] --config FILE     Use another config file
hypervigilant permissions ...                Inspect or change runtime policy
hypervigilant prompts list ...               List prompt rules and routes
hypervigilant prompts test ...               Test rule matching without an agent
hypervigilant worktree status|merge|cleanup  Manage the isolated worktree
hypervigilant version                        Print the installed version
hypervigilant help                           Show all commands and flags
```

### Status overview

Show configuration, file selection, snapshot state, routing, and worktree status without contacting the Letta API or mutating state:

```bash
hypervigilant status /path/to/project
```

## Limits

- Binary classification checks for null bytes in the first 8 KiB. Hypervigilant can treat other binary formats as text.
- A rename appears as a deletion and an addition.
- Batching reports the net change instead of each intermediate save.
- With project routing, a scan sends all matching files to the default conversation in one turn.
- Prompt rules and tool configuration load when each scan or watcher starts.
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
