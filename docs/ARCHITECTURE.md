# Orbit architecture

## Runtime boundary

```text
React renderer
  → typed preload API
  → validated Electron IPC
  → OrbitRuntime
  → AgentProvider
  → AntigravityProvider
  → installed agy CLI (`--print --output-format stream-json`)
  → existing signed-in Antigravity account/environment
```

The implementation is adapted from AgentDock Pro's current structured Antigravity transport. AgentDock's older interactive PTY path remains the reference for future native approval/question and clipboard-image support; Orbit's normal path uses the structured transport because it delivers explicit, streamable JSON events without terminal-screen parsing.

## Provider behaviour

`AntigravityProvider` is owned exclusively by Electron main and starts one `agy` process per Orbit run. It discovers the executable through `PATH`, falling back to `~/.local/bin/agy` on Unix; `ORBIT_AGY_PATH` is an optional absolute-path override.

The provider maps native stream events into Orbit-neutral events:

| Antigravity event | Orbit event |
| --- | --- |
| `init` | `run.started` and persisted native conversation ID |
| `agent_response` text delta | `text.delta` |
| tool state update | `tool.activity` |
| explicit workspace write path | `artifact.discovered` |
| `result: SUCCESS` | `run.completed` |
| `result: ERROR` / process failure | `run.failed` |
| process termination requested by Orbit | `run.cancelled` |

The native `conversation_id` is stored on the Orbit conversation and supplied as `--conversation` on later runs. This preserves actual Antigravity conversation context and keeps separate Orbit conversations isolated.

## Security and authentication

The renderer receives only the typed preload API. It cannot launch a process, control a PTY, access raw IPC, access credentials, or read arbitrary paths.

Orbit never reads browser cookies, OAuth tokens, keychain entries, Gemini keys, Google keys, Vertex credentials, or service accounts. Authentication is wholly owned by the installed Antigravity CLI. Normal operation requires neither Python nor the `google-antigravity` SDK.

## Lifecycle

Runs are tracked by Orbit run ID. Cancelling a run terminates its single child process and emits `run.cancelled`; app shutdown cancels every active provider child. A provider process is not shared by conversations, preventing cross-conversation process state leakage.

## Current constraints

Structured print mode does not expose a live approval/question response channel. Orbit intentionally reports only events that can be truthfully derived from its JSON protocol. A future enhancement can adapt AgentDock Pro's PTY fallback only for interactions that require it. Attachment directories are passed as explicit `--add-dir` roots; native clipboard image-paste support is not yet ported.
