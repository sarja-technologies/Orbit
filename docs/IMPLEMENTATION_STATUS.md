# Orbit MVP Implementation Status

## Current runtime

Orbit talks to `agy` through one of two transports — see `docs/antigravity-transports.md` for the full picture (state machine, interaction handling, native image attachment, and exactly what is verified vs. Orbit policy vs. unknown). Summary:

```text
Orbit renderer → typed preload → Electron main → OrbitRuntime
→ AntigravityProvider → structured (agy --print --output-format stream-json)
                       or pty (persistent interactive agy session)
→ user's signed-in Antigravity environment
```

The provider is Electron-main-owned. The renderer has no shell, raw IPC, process, credential, or unrestricted filesystem access. `structured` is the default and unchanged from the original MVP; `pty` is opt-in per conversation ("Enable interactive mode") and sticky once enabled.

- `agy` discovery uses `PATH`, with Unix `~/.local/bin/agy` fallback and optional `ORBIT_AGY_PATH` override.
- Native `conversation_id` values are persisted on Orbit conversations and passed back through `--conversation` for genuine multi-turn continuity (structured transport only — see the PTY known limitation below).
- Native JSONL `init`, `agent_response`, `tool`, and `result` events map to provider-neutral Orbit run events.
- Cancellation kills only the spawned one-shot run process and produces `run.cancelled` (structured); PTY cancellation sends Escape and keeps the process alive for a follow-up turn.
- Tool-derived artifact registration is conservative: only an explicit write/create/edit/save path inside the project workspace is considered.
- The provider does not read, store, copy, or request credentials. Account authentication remains the responsibility of `agy`.

## Verification results

- `npm run typecheck`: passed.
- `npm run test`: passed (1112 tests, 11 skipped without `ORBIT_REAL_AGY=1`).
- `npm run build`: passed — including a real Electron launch smoke check (see `docs/antigravity-transports.md`'s `@xterm/headless` build note; this used to crash on launch).
- `npm run test:agy` (real signed-in `agy`): passed — structured smoke test, plus a live PTY test covering native question continuity, permission approval (command actually ran), permission denial (command did not run), and stale-interaction rejection, all in one persistent session.
- Live, manually-driven verification (outside the automated suite, via a small Electron-hosted script — see `docs/antigravity-transports.md`): one native image attachment correctly described by agy, and two sequential native image attachments both correctly distinguished in order.

## Known limitations

- A PTY conversation's native id is captured from its **second** turn onward, never its first: agy has not minted one at the time the first prompt is logged. So a PTY session whose entire life is one turn starts a fresh native conversation if Orbit restarts. From the second turn on, resume works and is live-verified (`docs/antigravity-transports.md`). This is agy's own timing, not an Orbit gap.
- Two concurrent PTY sessions in the **same folder** sending **byte-identical** prompts cannot be told apart in agy's history file. Orbit declines to capture an id at all in that case rather than risk resuming the wrong conversation, which costs a resume and never cross-wires. Any difference in prompt text, or any gap between the sessions, resolves it.
- Structured → PTY and PTY → structured continuation safety is not implemented/verified; PTY is sticky by design (never silently downgrades).
- Native image attachment on Linux requires a system clipboard helper (`wl-clipboard` or `xclip`) to be installed — Electron's clipboard API is not self-contained here. Not verified on macOS/Windows.
- `extractResponseText`'s PTY reply reconstruction is a best-effort screen heuristic, not a pixel-perfect transcript of rich formatting.
- The retired Python SDK worker was removed; it is not part of startup, packaging, normal tests, authentication, or provider status.
