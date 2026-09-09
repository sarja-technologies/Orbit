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

The implementation is adapted from AgentDock Pro's Antigravity transports — both the structured `stream-json` path and, more recently, the interactive PTY path (native questions, permission prompts, and clipboard image attachment). See `docs/antigravity-transports.md` for the full picture: transport selection, the PTY session's state machine, interaction handling, and exactly what has been live-verified vs. is Orbit policy vs. remains unknown upstream behavior.

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

## Projects, sessions and naming

A project owns the workspace configuration — its name and the real folder `agy` runs in — so creating one opens a dialog. A session owns nothing: it is created in one click with no dialog, inherits its project's folder, and starts life called `New Session`.

Session naming is Orbit's concern, not Antigravity's. `agy` 1.1.28 exposes no conversation title Orbit can read live: `history.jsonl` records only prompt/timestamp/workspace/conversationId; `conversation_summaries.db` has a `title` column but is written only for gracefully-exited sessions (Orbit's cancel and shutdown paths kill `agy` abruptly, and the table was empty in practice); the per-conversation `conversations/<id>.db` files have no title at all. So `OrbitRuntime.sendMessage` derives a short title locally from the user's first substantive prompt (`src/shared/sessionTitle.ts`) — deterministic and synchronous, costing no second `agy` process and never able to delay or fail a turn. It applies at most once, only while the session still carries the default title, and never over a title the user set themselves (`conversations.title_is_custom`).

## Security and authentication

The renderer receives only the typed preload API. It cannot launch a process, control a PTY, access raw IPC, access credentials, or read arbitrary paths.

Orbit never reads browser cookies, OAuth tokens, keychain entries, Gemini keys, Google keys, Vertex credentials, or service accounts. Authentication is wholly owned by the installed Antigravity CLI. Normal operation requires neither Python nor the `google-antigravity` SDK.

## Lifecycle

Runs are tracked by Orbit run ID. Cancelling a run terminates its single child process and emits `run.cancelled`; app shutdown cancels every active provider child. A provider process is not shared by conversations, preventing cross-conversation process state leakage.

## Current constraints

Structured print mode does not expose a live approval/question response channel — Orbit reports only events truthfully derivable from its JSON protocol, and surfaces a skipped/denied native interaction as an honest, non-actionable `interaction.required` rather than a false success. Conversations that need live interaction or native image attachment opt into the `pty` transport instead (see `docs/antigravity-transports.md`); once opted in, a conversation never silently downgrades back to `structured`. PTY sessions do not currently capture a resumable native conversation id — see that document's "known limitation" for why and what it costs.
