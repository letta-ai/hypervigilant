---
id: SPEC-0005
title: Named prompt conversations
status: implemented
dependencies: [SPEC-0000, SPEC-0003, SPEC-0004]
supersedes: []
implementation_links: [src/config.ts, src/prompts.ts, src/agent.ts, src/state.ts, src/watch.ts, src/cli.ts, tests/config.test.ts, tests/agent.test.ts, tests/state.test.ts]
---

# Named prompt conversations

## Goal

Let one file change activate prompt rules in several persistent specialist conversations. Configuration uses portable logical names. Hypervigilant owns the name-to-conversation-ID mapping.

## Product behavior

- A prompt rule can set `conversation = "security"` with a safe logical name.
- Missing `conversation` keeps the rule in the existing default project/per-file delivery.
- Named rules are grouped by conversation name. Rules sharing one name are sent together in configuration order.
- A change matching several named conversation groups is delivered to each group.
- The default conversation still receives the complete batch and remains the only conversation allowed to mutate files.
- Named prompt conversations are always read-only for the local filesystem, regardless of ask or YOLO policy. Tools attached to the Letta agent remain available under their own tool rules.
- Each named group receives only the changes that match at least one rule in that group.
- Named conversations use the configured project agent and persist across watcher restarts.
- On first use, Hypervigilant stores `namedConversations[logicalName] = conversationId` in private state, including when the turn later fails. Later matches resume that ID instead of creating another conversation.
- Existing state without `namedConversations` remains valid. Changing the configured agent clears project, file, and named conversation routes.
- Logical conversation names are not raw conversation IDs. Names use letters, numbers, `.`, `_`, and `-`, start with a letter or number, and are at most 64 characters.
- `prompts list` and `prompts test` show each named route and state that its local filesystem access is read-only. After creation, `prompts list` also shows the persisted conversation ID.
- Named dispatch is sequential. It does not create concurrent file editors.
- A changed path is considered delivered only after its default and all matching named groups succeed.

## Acceptance criteria

- [x] Config, TOML serialization, JSON Schema, examples, and docs support optional logical conversation names.
- [x] Validation rejects unsafe, blank, and oversized conversation names while allowing several rules to share a name.
- [x] State parsing supports old state and persists named conversation mappings.
- [x] Agent changes clear named mappings with existing routes.
- [x] Default project/per-file delivery remains unchanged and receives only unnamed canned rules.
- [x] Named groups contain matching named rules and only their matching changes.
- [x] One change can dispatch to several named persistent conversations.
- [x] Rules sharing a named conversation combine in configuration order.
- [x] Named groups create once and resume their stored conversation IDs after restart.
- [x] Named groups cannot use local Edit or Write in ask or YOLO policy. They retain local read tools, SPEC-0006 configured client tools under their own policy, and attached Letta tools.
- [x] Delivered paths wait for every required named group to succeed.
- [x] CLI list/test output identifies named filesystem-read-only routes without API calls.
- [x] Legacy configs, rules without conversation names, and state without named mappings remain compatible.
- [x] README and spec-guardian demo show named specialist review lanes.
- [x] Unit, integration, full-suite, package, and CLI validation pass.

## Non-goals

- Accepting raw conversation IDs in project configuration.
- Selecting a different agent per named conversation.
- Allowing named specialist conversations to mutate files.
- Dispatching named conversations concurrently.
- Deleting old named conversations when a rule is removed.

## Implementation links

- `src/config.ts` validates and serializes optional logical conversation names on prompt rules.
- `src/prompts.ts` renders named routes explicitly as filesystem read-only.
- `src/agent.ts` groups named rules, dispatches matching change subsets sequentially, forces filesystem-read-only client sessions, persists IDs on success and failure, and waits for every required route before marking paths delivered.
- `src/state.ts` stores optional `namedConversations` mappings and clears them when the configured agent changes.
- `src/watch.ts` persists route state, keeps named reviewers out of mutation tracking, and reports each named dispatch.
- `src/cli.ts` shows logical routes and their persisted conversation IDs without an API call.
- `tests/config.test.ts`, `tests/agent.test.ts`, and `tests/state.test.ts` cover validation, multi-route dispatch, shared routes, resume, permission isolation, partial and transport failures, migration, persistence, and reset.
- Live acceptance created `implementation-review`, persisted its `conv-...` mapping, restarted the watcher, and resumed the same conversation ID on the next matching change.
