# Run a Cloud agent on this device

This demo keeps agent memory and conversations in Letta Cloud while running the Hypervigilant harness and filesystem tools on the current computer. It does not create or select a managed Cloud sandbox.

The proof is behavioral:

1. The script writes a random marker to `device-only-proof.txt` in a temporary local directory.
2. Hypervigilant watches only `trigger.md`, so the marker is absent from the delivered diff and instructions.
3. A Cloud agent must use the local `Read` tool to retrieve the excluded file.
4. The script checks that the exact marker appears in the response.
5. The temporary Cloud conversation is archived and the local directory is deleted.

Export a Letta Cloud API key, then pass an existing Cloud agent ID:

```bash
export LETTA_API_KEY=sk-let-...
bun demo/cloud-local-device/run.ts --agent-id agent-xxx
```

The default conversation model is `letta/auto`. Override it with `--model <handle>`.

Add `--keep` to retain the temporary local workspace after the proof. The Cloud conversation is still archived.

The underlying configuration is ordinary Hypervigilant Cloud mode:

```toml
[connection]
backend = "cloud"
```

Hypervigilant uses Letta Cloud for agent and conversation state, then starts a local App Server against the Cloud API for the session. The session receives the real local `cwd` and guarded local tools. No `sandbox` option is supplied.

The relevant Agent SDK split is:

```ts
const cloud = new LettaAgentClient({
  backend: "cloud",
  apiKey: process.env.LETTA_API_KEY,
});
await cloud.agents.retrieve(agentId);

const device = new LettaAgentClient({
  backend: "local",
  appServer: { harnessBackend: "api", pinGlobalAgent: false },
});
await using session = device.createSession(agentId, {
  cwd: "/absolute/path/on/this/device",
  env: { LETTA_API_KEY: process.env.LETTA_API_KEY },
});
```

The Cloud client manages the agent resource. The local client owns this session's harness and tool execution while pointing the harness state backend at the Cloud API, so the resulting conversation still persists in Letta Cloud.

For the general Agent SDK distinction between managed sandboxes, bring-your-own-machine environments, local agents, and App Server deployments, see [Deploying your agents](https://docs.letta.com/agent-sdk/deployment/index.md). If you want to select the machine from `chat.letta.com` or the Letta app rather than connect a local controller directly, use a [remote environment](https://docs.letta.com/platform/computers/byom/index.md).
