# The Doc

**A document that evolves with each save.**

Edit one Markdown document. Each changed save dispatches an agent. The agent revises the same document, and the open editor shows the revision.

## Run the demo

Run the command from the Hypervigilant repository root:

```bash
bun run demo:the-doc
```

The command reads the agent ID from the root `hypervigilant.toml`, enables YOLO for the demo workspace, starts Hypervigilant, and starts the editor.

If the root config does not contain the agent that you want, configure the demo first:

```bash
bun run demo:the-doc:setup -- --agent-id agent-xxx
bun run demo:the-doc
```

Open the URL shown in the terminal. The default URL is `http://127.0.0.1:4317`.

## Make the project

The first run copies [`PROJECT.md.example`](PROJECT.md.example) to the ignored `workspace/PROJECT.md` file. Setup does not overwrite an existing document.

```markdown
# The Doc

Whatever you type here will try its best to exist.

Edit this file however you want, then hit "Save".

Have fun.
```

Type a direction anywhere in the document. Press Ctrl+S on Windows or Linux. Press Command+S on macOS.

The status changes from `Unsaved` to `Waiting for the agent`. Hypervigilant sends the changed Markdown to the agent. The agent treats the diff as desired reality and tries to make it true with guarded edits to `PROJECT.md` and supporting workspace assets. It verifies the result before claiming success. If the required change is outside the workspace or its tools, it records one specific blocker instead.

The browser loads the revised document without a page refresh. A save with no content change does not dispatch the agent.

## Add images

Use a relative Markdown image path:

```markdown
![A good boy](dog.svg)
![Diagram](images/system.png)
```

The editor displays the image and preserves the relative path and alt text when it saves Markdown. Images scale down to fit the document on narrow screens.

The local asset route serves AVIF, GIF, JPEG, PNG, SVG, and WebP files up to 8 MiB. It serves only regular files inside the workspace. Traversal, hidden paths, non-image files, oversized files, and symlinks outside the workspace return `404`.

## Watch the listeners

The right third of the desktop app lists every process that receives saved diffs. The current demo shows Hypervigilant as one agent listener.

The listener moves through `Starting`, `Listening`, `Receiving`, `Working`, `Finished`, `Failed`, and `Offline`. Its recent event history shows when it received a save and started or finished a guarded edit.

The activity feed contains structured lifecycle summaries only. It does not send assistant output, tool input, private paths, or provider errors to the browser. Future listener types can use the same feed without pretending that each process is an agent.

On narrow screens, the listener section appears below the document.

## Automatic file approval

The demo uses the YOLO permission policy. Hypervigilant still applies its file and path guards before each Edit or Write call.

The watched root is [`workspace/`](workspace/). It contains one project file. Hypervigilant protects its generated config and state files. The agent cannot edit the server, browser code, or other repository files through this demo session.

The prompt tells the agent to revise `PROJECT.md` on every delivery. If the document has no specific direction, the agent chooses a small project. Later saves evolve the existing document.

## Conflicting changes

The editor does not overwrite unsaved input. If `PROJECT.md` changes while you type, choose one option:

- **Use file version** discards the browser draft and loads the file.
- **Keep my draft** saves the browser draft over the file version.

The save API also checks a content revision. A stale browser save receives the current file instead of overwriting it.

## Reset the document

Stop the demo. Then run:

```bash
bun run demo:the-doc:reset
```

The reset command copies `PROJECT.md.example` over the working document. It does not remove agent configuration or conversation state.

## Run only the editor

Use the editor without an agent watcher:

```bash
bun run demo:the-doc:editor
```

This mode is useful for interface work. It still reads and writes `workspace/PROJECT.md`.

## Local boundaries

The server binds to `127.0.0.1`. It serves fixed demo assets, one document API, and allowlisted images from the workspace. The API writes only `workspace/PROJECT.md`, rejects stale revisions, limits document size to 256 KiB, and uses atomic replacement. The image route is read-only and does not expose document, config, state, or outside-workspace files.

The browser supports headings, paragraphs, lists, block quotes, code blocks, emphasis, links, and horizontal rules. It is a focused demo editor, not a general Markdown editor.
