# Route workloads to different models

One Hypervigilant configuration selects one model. Run multiple configurations when workloads need different models, prompts, or file routes.

This demo starts two watchers on one directory. Both watchers use the same agent. Each watcher owns a separate conversation and state directory.

- `code/**` uses `letta/auto` for source review.
- `notes/**` uses `openai/gpt-5.6-luna` for lower-cost note triage.

Start both watchers:

```bash
bun demo/model-routing/run.ts --agent-id agent-xxx
```

Wait for both watchers to record their baselines. Then edit the sample files in another terminal:

```bash
printf '\nexport const answer = 42;\n' >> /tmp/hypervigilant-model-routing/code/example.ts
printf '\nFollow up with the documentation team.\n' >> /tmp/hypervigilant-model-routing/notes/inbox.md
```

The script prefixes each watcher output with `code` or `notes`. Press Ctrl-C to stop both watchers.

Use other model handles when needed:

```bash
bun demo/model-routing/run.ts \
  --agent-id agent-xxx \
  --primary-model letta/auto \
  --economy-model letta/auto-fast
```

Use `--prepare-only` to write the workspace and print separate watcher commands without starting them.

The `include` globs do not overlap in this demo. If two configurations select the same file, both watchers receive that file change.
