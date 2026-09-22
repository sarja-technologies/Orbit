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
| `result: SUCCESS` | `run.completed` |
| `result: ERROR` / process failure | `run.failed` |
| process termination requested by Orbit | `run.cancelled` |

Generated files are not read off the event stream (agy's tool events carry no output path, and a PTY turn has no tool stream); see "Generated files" below.

The native `conversation_id` is stored on the Orbit conversation and supplied as `--conversation` on later runs. This preserves actual Antigravity conversation context and keeps separate Orbit conversations isolated.

## Projects, sessions and naming

A project owns the workspace configuration — its name and the real folder `agy` runs in — so creating one opens a dialog. A session owns nothing: it is created in one click with no dialog, inherits its project's folder, and starts life called `New Session`.

Session naming is Orbit's concern, not Antigravity's. `agy` 1.1.28 exposes no conversation title Orbit can read live: `history.jsonl` records only prompt/timestamp/workspace/conversationId; `conversation_summaries.db` has a `title` column but is written only for gracefully-exited sessions (Orbit's cancel and shutdown paths kill `agy` abruptly, and the table was empty in practice); the per-conversation `conversations/<id>.db` files have no title at all. So `OrbitRuntime.sendMessage` derives a short title locally from the user's first substantive prompt (`src/shared/sessionTitle.ts`) — deterministic and synchronous, costing no second `agy` process and never able to delay or fail a turn. It applies at most once, only while the session still carries the default title, and never over a title the user set themselves (`conversations.title_is_custom`).

## Generated files

A turn's outputs are established from the filesystem when the run ends, identically on both transports, and registered as `artifacts` rows attributed to that run (`creator_run_id`). The assistant message for the turn carries the same `run_id`, which is how the conversation draws each output under the reply that produced it — after a restart as well, because both rows are persisted.

```text
send → snapshot workspace outputs (outputScan.ts)
end  → diff workspace            ┐
     → provider.findGeneratedOutputs (agy brain folder, generatedOutputs.ts)
     → selectTurnOutputs (turnOutputs.ts): deliverable formats only; .md/.txt only if new, named in the reply and not a
       repository document (README, CHANGELOG, AGENTS.md…); provably complete files only on a stopped/failed turn;
       dedupe by path, by content, and by picture (a generated JPEG the agent re-encoded into the project as PNG)
     → ArtifactService.registerOutput: canonicalize, require containment in the recorded root, copy bytes into Orbit storage
     → artifact.produced, then the assistant message and run state
```

- **Persistence.** `artifacts.project_id` is nullable, so an Unsorted session owns its outputs (stored under `conversations/<id>/artifacts`). Assigning the session to a project moves them; deleting an Unsorted session deletes them and their copies.
- **Each turn keeps its own bytes.** A later turn overwriting `mountain.png` gets a new artifact; the earlier card is unchanged.
- **Security.** The renderer names an artifact by id only (`artifacts.describe/open/reveal`), and never receives a path. Open and reveal re-resolve the real path at click time: the original is used only while it is still a regular file physically inside its recorded root (and, for open, still byte-identical); otherwise Orbit's stored copy, which must itself be inside Orbit's data folder. Only the closed list of deliverable formats (`shared/outputArtifacts.ts`) is ever handed to the OS to open.
- **Missing files** degrade to a "No longer available" card; nothing throws.
- **Storage cleanup** (`main/artifacts/artifactStorageGc.ts`). Copies are written under a temporary name and renamed into place, and removed if their row cannot be written. Deleting an artifact, or a session (which takes what its turns produced, and everything it held while Unsorted; a project's user imports stay), deletes the rows first and then removes only copies no remaining row references. A startup sweep reclaims any Orbit-named file in `<data>/{projects,conversations}/<id>/artifacts` that no row references, and any incomplete copy. Cleanup never follows a symlink, never touches a file Orbit did not name, never leaves those two roots, and never ages out a referenced copy — retained history is data, not garbage. There is no project deletion in Orbit today; if one is added, its artifact rows cascade and the sweep reclaims the copies.

## Security and authentication

The renderer receives only the typed preload API. It cannot launch a process, control a PTY, access raw IPC, access credentials, or read arbitrary paths.

Orbit never reads browser cookies, OAuth tokens, keychain entries, Gemini keys, Google keys, Vertex credentials, or service accounts. Authentication is wholly owned by the installed Antigravity CLI. Normal operation requires neither Python nor the `google-antigravity` SDK.

## Lifecycle

Runs are tracked by Orbit run ID. A provider process is not shared by conversations, preventing cross-conversation process state leakage.

### Stop terminates the whole execution

Captured live (agy 1.2.2): agy runs every `run_command` in a **new process group of its own**. Signalling agy — or agy's group — never reaches it, and once agy exits the command is reparented to launchd and keeps running (a real Python writer did exactly that after Stop, and could have finished its file during the next turn). `main/process/processTree.ts` therefore snapshots the tree **before** anything is killed, while the parent links still exist, and addresses each process directly:

- Identity is pid **plus start time**, so a reused pid is never signalled. A process group is signalled only when its leader is in the snapshot (the tree created it) and it is not Orbit's own group.
- POSIX (macOS, Linux): `ps -A -o pid,ppid,pgid,lstart`; SIGTERM to the groups and pids, a bounded wait (1.5 s), then SIGKILL to what is verifiably still the same process.
- Windows: a CIM process listing and `taskkill /T /F` per target while parents still exist, then a kill of any snapshot survivor. (Implemented and unit-tested against a scripted table; not run on a real Windows machine.)

| Transport | Stop | Quit / retire |
| --- | --- | --- |
| structured | agy is spawned `detached` (its own group) on POSIX. Stop terminates agy and its whole tree; `run.cancelled` is emitted only after that, once, and output lines after Stop are ignored. Repeated Stops join the first. | same as Stop |
| pty | Escape, as before. When agy acknowledges it, the session enters `stopping` (busy) and terminates only the process groups the turn **created** — descendants in a group other than agy's that did not exist when the turn began — then emits `run.cancelled`. agy (the live session) and anything already running before the turn (an MCP helper, a dev server an earlier turn started) are left alone. | the tree is snapshotted before agy is killed, and leftovers are reaped after it exits |

The runtime drops stream events (`text.delta`, `tool.activity`, …) that arrive for a run that has already ended, and a Stop on an ended run returns it unchanged. On quit, every still-active run is given its `cancelled` ending after the provider has terminated it; a run left unfinished by a crash is settled at the next launch as failed (`app.interrupted`, "Orbit closed before this response finished").

## Reopening where the user left off

The main process resolves the launch session before the renderer draws anything (`main/startup/startupSession.ts`): the conversation recorded as last active, if it still exists — with its project read from the conversation row *now*, so a session moved into a project reopens there — else the most recently updated conversation, and a new Unsorted session **only** when none exist. The answer is memoized per launch, so a remount or reload cannot re-resolve or create anything.

`preferences.lastActiveConversationId` / `lastActiveProjectId` are written only through `conversations.markActive(id)`, which the renderer calls whenever the open session changes (Unsorted included); `preferences.set` can no longer overwrite them with a stale object. Deleting the remembered session clears them; assigning it to a project updates the project.

## What the transcript claims about a turn

Every row that represents the working AI is labelled from the run's **own** record, not from the session's live settings. `sendMessage` writes the model and reasoning tier onto `runs.metadata` at the moment the turn is launched, from the same value handed to the provider, so it is a record of what was sent rather than a second opinion about it. The renderer resolves each turn's identity from that record (`renderer/app/lib/agentIdentity.ts`, `runModelId`).

Without it the transcript had only the session's *current* selection to work with, so switching a session's model silently restamped its entire history with a model that had never seen it. Runs written before this carry no model and still fall back to the session selection — the only datum that exists for them.

## Long replies

A settled assistant message longer than a screenful opens on its own opening, with the rest behind one button (`renderer/app/lib/reportPreview.ts`). Three rules keep that honest, each pinned by a test:

- the preview is a real prefix of the real message — never a generated or paraphrased summary — and the button states how many lines are behind it;
- the cut lands on a blank line outside any fence, so what is shown renders as itself rather than as a fragment. A message with no safe boundary is shown whole;
- anything in the hidden tail that reads like a problem keeps the message fully expanded. A turn can report a failure and still have *succeeded* as a run, and that report is exactly what must not end up behind a button. The check is deliberately broad and fails open.

Failed and cancelled turns never reach the fold — they have their own presentation. Neither does a reply the reader watched stream in: folding that the instant it settled would hide the text they were reading. The window remembers which runs streamed; reopening Orbit later is when the fold earns its keep.

## Data integrity: foreign keys

**Real bug fixed:** `PRAGMA foreign_keys` is per connection, and sql.js's `export()` — called after every write to persist the database — reopens the connection, silently turning enforcement off. No `ON DELETE CASCADE` / `SET NULL` had ever run after the first write: deleted sessions left their messages, runs, run events and artifact versions behind. `OrbitDatabase` now re-enables foreign keys after every export, and on open repairs, idempotently, exactly the rows those cascades would have removed or nulled.

## Current constraints

Structured print mode does not expose a live approval/question response channel — Orbit reports only events truthfully derivable from its JSON protocol, and surfaces a skipped/denied native interaction as an honest, non-actionable `interaction.required` rather than a false success. Conversations that need live interaction or native image attachment opt into the `pty` transport instead (see `docs/antigravity-transports.md`); once opted in, a conversation never silently downgrades back to `structured`. PTY sessions do not currently capture a resumable native conversation id — see that document's "known limitation" for why and what it costs.
