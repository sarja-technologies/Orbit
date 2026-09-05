# Orbit MVP Implementation Status

## Current runtime

Orbit's default provider is the AgentDock Pro-derived native Antigravity CLI transport:

```text
Orbit renderer → typed preload → Electron main → OrbitRuntime
→ AntigravityProvider → agy --print --output-format stream-json
→ user's signed-in Antigravity environment
```

The provider is Electron-main-owned. The renderer has no shell, raw IPC, process, credential, or unrestricted filesystem access.

- `agy` discovery uses `PATH`, with Unix `~/.local/bin/agy` fallback and optional `ORBIT_AGY_PATH` override.
- Native `conversation_id` values are persisted on Orbit conversations and passed back through `--conversation` for genuine multi-turn continuity.
- Native JSONL `init`, `agent_response`, `tool`, and `result` events map to provider-neutral Orbit run events.
- Cancellation kills only the spawned one-shot run process and produces `run.cancelled`.
- Tool-derived artifact registration is conservative: only an explicit write/create/edit/save path inside the project workspace is considered.
- The provider does not read, store, copy, or request credentials. Account authentication remains the responsibility of `agy`.

## Verification results

- `npm run typecheck`: passed.
- `npm run test`: passed (13 tests).
- `npm run build`: passed.
- Real signed-in `agy` structured run: `Reply with exactly: ORBIT_AGENTDOCK_AGY_OK` returned exactly `ORBIT_AGENTDOCK_AGY_OK`.
- Real native session-resume check: a first turn stored `NEBULA`; a second `--conversation` turn returned `NEBULA`.

## Known limitations

- The structured headless transport is deliberately used for normal Orbit runs because it emits clean streaming JSON. Antigravity's native interactive approval/question channel is not yet surfaced in Orbit; a future implementation should port AgentDock Pro's PTY fallback for those specific interactions.
- Attachments are exposed as explicitly scoped additional `--add-dir` roots. Clipboard-native image paste from AgentDock's interactive transport is not yet part of Orbit's structured path.
- The retired Python SDK worker was removed; it is not part of startup, packaging, normal tests, authentication, or provider status.
