---
id: SPEC-0007
title: The Doc demo
status: implemented
dependencies: [SPEC-0000, SPEC-0001, SPEC-0003]
supersedes: []
implementation_links: [demo/the-doc/PROJECT.md.example, demo/the-doc/index.html, demo/the-doc/app.js, demo/the-doc/activity.ts, demo/the-doc/styles.css, demo/the-doc/server.ts, demo/the-doc/scripts/run.ts, demo/the-doc/tests/server.test.ts, demo/the-doc/README.md, package.json, README.md]
---

# The Doc demo

## Goal

Show Hypervigilant through one editable Markdown file. The user writes intent, presses Ctrl+S or Command+S, and sees the agent revise the same document.

## Product behavior

- `PROJECT.md.example` is the canonical starting document. Setup copies it to the ignored `workspace/PROJECT.md` file only when the working document does not exist.
- The initial file contains:

  ```markdown
  # The Doc

  Whatever you type here will try its best to exist.

  Edit this file however you want, then hit "Save".

  Have fun.
  ```

- A local browser app renders the Markdown as editable formatted content. It does not show Markdown syntax during normal editing.
- The editor has no formatting toolbar. The document is the primary interface.
- Ctrl+S and Command+S save changed content to `PROJECT.md`.
- The Hypervigilant watcher dispatches each saved content change to the configured agent.
- The demo uses direct edit mode and a YOLO runtime override. Only `PROJECT.md` triggers deliveries; guarded tools can update that document and supporting assets inside the workspace while Hypervigilant control files stay protected.
- The agent treats each saved diff as desired reality and first tries to make it true with workspace edits. It preserves the user's intent, verifies artifacts before claiming success, and records one specific blocker only when the required change is outside the workspace or its tools.
- The browser receives external file changes without a page reload.
- An external change replaces the editor content only when the editor has no unsaved input.
- If an external change conflicts with unsaved input, the editor keeps both versions and asks the user which version to use.
- The save endpoint uses a content revision. A stale save returns a conflict instead of overwriting an agent revision.
- The server binds to `127.0.0.1`, serves fixed assets, writes one fixed file path, rejects oversized input, and writes atomically.
- A save indicator reports `Unsaved`, `Saving`, `Waiting for the agent`, `Agent revised`, `Saved`, and conflict states.
- The editor works on narrow screens, shows keyboard focus, and honors reduced-motion preferences.
- A reset command restores the initial Markdown file without changing agent configuration.
- On desktop, the document uses the left two-thirds of the app and a listener gutter uses the right third.
- The gutter lists every process that receives document diffs. The listener model is generic and does not assume that each process is an agent.
- Each listener reports one structured state: starting, listening, receiving, working, finished, failed, or offline.
- Each listener keeps a bounded event history with safe lifecycle summaries and timestamps. Arbitrary assistant output and tool input never enter the browser activity feed.
- The live connection sends a full listener snapshot on connect and sends updates when any listener changes.
- On narrow screens, the listener gutter moves below the document without covering the editor or save controls.
- Relative Markdown images such as `![A good boy](dog.svg)` render inside the document and serialize back to the same relative Markdown reference.
- The image route serves only regular files with allowlisted image extensions from inside the workspace. It rejects traversal, malformed paths, non-image files, oversized files, and symlinks that resolve outside the workspace.
- Workspace image responses use explicit content types, `nosniff`, a restrictive content security policy, and no raw filesystem path in errors.

## Acceptance criteria

- [x] `PROJECT.md.example` contains the exact initial content, and setup does not overwrite an existing working document.
- [x] The editor renders the heading and paragraph without visible Markdown markers.
- [x] Typing changes the editor state to `Unsaved`.
- [x] Ctrl+S and Command+S save changed Markdown to the fixed project file.
- [x] An unchanged save does not rewrite the file or create a false agent dispatch.
- [x] Stale revisions return HTTP 409 with the current document.
- [x] External file changes update a clean editor through a live connection.
- [x] External file changes do not overwrite unsaved editor input.
- [x] The user can choose the local or file version after a conflict.
- [x] The demo watcher includes only `PROJECT.md` and runs automatic guarded Edit/Write.
- [x] Agent instructions treat the saved diff as desired reality, permit supporting workspace assets, require verification before success, and use specific blocker text only for unavailable changes.
- [x] One run command starts the editor and watcher after setup.
- [x] The server accepts local requests only and enforces file and size boundaries.
- [x] Automated tests cover document reads, saves, unchanged saves, conflicts, and live notifications.
- [x] Browser validation proves editing, saving, responsive layout, keyboard focus, and live file revision.
- [x] README, package scripts, package contents, and demo instructions describe the workflow.
- [x] Desktop layout gives the document two-thirds and the listener gutter one-third of the available width.
- [x] The gutter renders generic listener snapshots and bounded event histories.
- [x] Hypervigilant lifecycle output maps to safe listener states without forwarding arbitrary assistant output or tool input.
- [x] WebSocket clients receive the current listener snapshot on connect and later structured updates.
- [x] Narrow layouts move listeners below the document and preserve editor controls.
- [x] Automated and browser tests prove listening, receiving, working, finished, failed, and reconnect behavior.
- [x] Relative Markdown image syntax renders the referenced workspace image and round-trips without changing its path or alt text.
- [x] The asset route serves allowlisted in-workspace image files with safe response headers.
- [x] Traversal, encoded traversal, outside-root symlinks, non-image files, directories, and oversized image files are rejected without path disclosure.
- [x] Browser validation proves the existing `dog.svg` renders at desktop and narrow widths.
- [x] Full checks, demo tests, audit, package inspection, and live agent acceptance pass.

## Non-goals

- A general Markdown editor or full Markdown parser.
- Multiple project files, tabs, folders, or file selection.
- Collaborative editing or multi-user conflict merging.
- Rich formatting controls, slash commands, or block drag-and-drop.
- Remote hosting, authentication, public network access, or Cloud document storage.
- Showing the agent transcript inside the editor.
- Running shell tools or allowing the agent to edit demo infrastructure.

## Implementation links

- `demo/the-doc/PROJECT.md.example` is the exact canonical starting document. Setup copies it into the ignored workspace without overwriting the current document or supporting assets.
- `demo/the-doc/index.html`, `app.js`, and `styles.css` implement the toolbar-free editor, Markdown conversion, relative image parsing and round-trip serialization, keyboard save, live updates, conflict choices, status states, the two-thirds/one-third listener layout, responsive images and stacking, and reduced-motion behavior.
- `demo/the-doc/activity.ts` implements a generic listener registry, bounded safe event histories, and the Hypervigilant lifecycle parser. It maps known status lines only and drops arbitrary assistant output, tool input, paths, and provider errors.
- `demo/the-doc/server.ts` serves fixed local assets, the document API, and allowlisted workspace images. It enforces revisions, text and size limits, atomic writes, unchanged-content detection, WebSocket file notifications, traversal and symlink boundaries, image size and type limits, and restrictive response headers without path disclosure.
- `demo/the-doc/hypervigilant.toml.example` watches only `PROJECT.md` and tells the agent to make each saved diff true with verified document and supporting-asset edits, or record one specific blocker when the needed change is unavailable.
- `demo/the-doc/scripts/setup.ts`, `run.ts`, and `reset.ts` configure the agent, enable guarded YOLO, start and stop the watcher and editor, and restore the exact initial file.
- `demo/the-doc/tests/activity.test.ts` covers generic listeners, bounded and sanitized histories, safe lifecycle mapping, and rejection of arbitrary output. `server.test.ts` covers the make-it-true prompt contract, reads, writes, unchanged saves, line-ending equivalence, stale revisions, invalid input, size limits, local binding, fixed routes and headers, external file events, listener snapshots and updates, allowlisted workspace images, traversal, hidden paths, malformed encoding, non-image and oversized files, directories, and outside-root symlinks.
- `demo/the-doc/README.md`, the root `README.md`, and `package.json` expose the one-command workflow and package every required asset.
- Browser acceptance proved formatted editing, Ctrl+S, clean live revision, both unsaved conflict choices, focus styling, the initial reset, the desktop listener gutter, and stacked 390-pixel layout. Image acceptance rendered the existing 200×200 `dog.svg`, rendered an encoded nested image path, preserved that path and alt text through a save, and constrained a forced 1000-pixel image to a 390-pixel viewport. Packaged live acceptance showed Hypervigilant listening before a save, then recorded receiving, two guarded edits, completion, and return to listening while the document updated without reload. The test conversation was archived.
- All acceptance conversations were archived, and temporary fixture state was removed. The current ignored workspace is user-owned and is never included in the package.
- Independent review found no high- or medium-severity defects. Follow-up hardening checks unchanged line endings, refreshes stale clean editors on save, announces conflicts, and cleans up the watcher when editor startup fails.
