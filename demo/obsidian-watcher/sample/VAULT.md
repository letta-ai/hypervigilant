---
type: guide
status: active
---

# Vault conventions

This synthetic vault demonstrates one lead steward carrying a verified change into durable project state.

- Every note starts with `type` and `status` frontmatter.
- A wikilink names an existing note. Search before changing an ambiguous link.
- A project note has `## Status` and `## Next step` sections.
- Project entries in [[index|Index]] end with the project's frontmatter status.
- A plan, a source change, and a verified external result are different facts. See [[concepts/delivery-receipts|Delivery receipts]].
- A publication is verified only when [[projects/publishing-log|Publishing log]] contains a URL, deployment identifier, and successful readback.

## Watcher contract

- An `@watcher` line is a direct request. Its factual premises still require evidence in this vault.
- Preserve an inbox or meeting note as source unless its own request explicitly permits moving or rewriting it.
- Mechanical repairs and explicitly requested propagation may be edited through Hypervigilant's approval gate.
- Do not silently make an interpretive choice. Put the exact question in [[Watcher Inbox]].
- After approved material changes, append one receipt to [[Watcher Inbox]] with changed paths, evidence, and unresolved questions.
- A no-op produces no receipt.
