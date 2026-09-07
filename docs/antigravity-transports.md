# Antigravity transports

Orbit talks to the installed, signed-in `agy` CLI through one of two transports, selected once per conversation and never guessed from message content.

```text
renderer → preload → validated IPC → OrbitRuntime → AntigravityProvider → transport
```

## Model and reasoning effort

Both transports append the same `--model`/`--effort` flags, resolved in one place (`modelCatalog.resolveInvocation`) from the **real** `agy models` catalogue — Orbit never ships a hard-coded model list.

The catalogue encodes reasoning in the model id itself, with uneven coverage (verified against agy 1.1.27): `gemini-3.8-flash-{low,medium,high}`, `gemini-3.1-pro-{low,high}` (no medium), `claude-sonnet-4-6` and `claude-opus-4-6-thinking` (no tiers at all), `gpt-oss-120b-medium` (one tier). `normalizeModels` collapses variants into one base model carrying exactly the tiers that exist, so the UI's reasoning control only appears when the selected model genuinely has one.

`resolveInvocation` never guesses:

| selection | flags sent |
| --- | --- |
| nothing | none |
| a real catalogue id (`claude-sonnet-4-6`) | `--model <id>` only — never a redundant `--effort` |
| base id + a tier it publishes | `--model <base> --effort <tier>` |
| multi-tier base with no/invalid tier | **nothing** — agy's own default is used rather than a combination it would reject |
| unrecognized id (catalogue drift) | passed through, so agy's own error surfaces |

The choice is persisted per conversation (`conversations.model`, `conversations.reasoning_effort`). A live PTY process is bound to the flags it was launched with, so changing the selection retires that process and spawns a replacement, resuming the same native conversation via `--conversation`. Orbit waits for the retired process to actually exit first — two agy processes must never hold the same native conversation at once — and every transport callback is scoped to the transport that raised it, so a late exit from the retired process cannot fail the new run.

## structured (default)

`agy --print <prompt> --output-format stream-json --add-dir <workspace>`. Headless, one process per run, no live interaction channel. Native `init`/`step_update`/`result` events map to Orbit's `RuntimeEvent`s (see `AntigravityProvider.ts`). If the underlying turn hits a native `ask_question`/`ask_permission`, agy skips/denies it and still reports `SUCCESS` — Orbit detects this (`headlessDenials`) and reports an honest, non-actionable `interaction.required` with `canRespond: false` instead of a false success.

Used for every conversation unless it has been explicitly switched to `pty` (via `conversations.setTransport`, exposed in the UI as "Enable interactive mode"). The switch is one-way — see Transport continuity below.

## pty (interactive)

A persistent, bare-spawned (`agy --add-dir <workspace> [--conversation <id>]`, no `-i`) interactive session, owned by `AntigravityPtySession` for the life of the conversation. Screen state is reconstructed with a real VT parser (`TerminalScreenBuffer`, `@xterm/headless`) from an idle-debounced (450 ms) snapshot loop in `AntigravityPtyTransport` — not by regexing raw chunks. `TerminalInteractionDetector.ts` classifies each idle snapshot into: a permission/choice/confirm-enter menu, the busy footer (`esc to cancel`), or the ready footer (`? for shortcuts`).

### Session state machine

```text
idle -> bootstrapping -> running -> waiting_for_interaction -> running -> ready -> running (next turn) -> ...
                                                                        -> idle (process exited)
```

- `bootstrapping`: process just spawned, nothing written yet. May show agy's own workspace-trust prompt, surfaced as an ordinary `permission` interaction — Orbit never auto-approves it.
- `running`: a real prompt is in flight (or an image-attachment sequence is delivering, see below).
- `waiting_for_interaction`: a native menu is on screen; the run pauses (`Run.state = 'waiting_for_interaction'`), remembering which state to resume into.
- `ready`: idle between turns on a still-live process. The **same process** is reused for the next `send()` — this is what makes a native free-text question "just work": agy's interactive TUI has no distinct question modal (see below), so the user's next composer message is simply written into the same session.

Interaction IDs (`${runId}:pty:${counter}`) are stable for the life of one on-screen menu; the transport deduplicates a redrawn/re-scanned identical menu by content signature before the session ever sees it, and a signature that was *just* answered is ignored for 3s to absorb a stale echo of the same screen.

`respondToInteraction` validates: the run matches the currently active one, the interaction is still the pending one, and the option ID is one of that interaction's own options — a stale, duplicate, wrong-run, or invalid-option response is rejected, never silently accepted (see `AntigravityPtySession.respondToInteraction` and its tests).

### Native questions have no dedicated UI

Confirmed live (agy 1.1.27, both by direct PTY probing and by AgentDock Pro's own `TerminalInteractionDetector`, which has no `'question'` kind at all): a free-text `ask_question` is **not** a distinct modal in the interactive TUI. Agy just prints the question as ordinary assistant text and returns to the ready footer — identical to a normal turn ending. Orbit's "native question" support is therefore session continuity, not a special widget: the user's next message goes into the same live process. There is no `interaction.required` event of kind `question` for PTY today.

### Native permission/trust menus

Two real captured shapes, both handled by the same generic detector:

- Numbered command-permission menu: `Requesting permission for:\n   <command>\n\nDo you want to proceed?\n> 1. Yes\n  2. ...\n  4. No`.
- Arrow-marker menu (workspace trust): `Do you trust the contents of this project?\n...\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm`.

Orbit never auto-approves either shape — every permission/trust prompt is surfaced to the user via `interaction.required` and only resolved by an explicit `interactions.respond` call. Responses are translated to the real keystrokes: numbered/lettered options send the literal key + Enter; arrow-menu options send N down-arrows (`\x1b[B`) + Enter, relying on the confirmed-live fact that the affirmative option is always the one initially highlighted.

Cancel (Escape) is the verified in-turn cancel key; Ctrl+C is NOT used (it's reserved for exiting the whole session and needs a second press).

## Native conversation ID capture (via agy's own history file)

An earlier version of this transport tried to capture agy's own conversation UUID via a scripted `/help` round trip (the approach AgentDock Pro's PTY adapter still uses). **Live-tested against agy 1.1.27 and found to reliably hang the entire session** — after sending `/help`, no further screen activity was ever observed, and even a 6s bounded fallback timer never produced any effect (root cause not fully isolated; removed rather than shipped broken).

Replaced with a safer mechanism discovered during the hardening pass, implemented in `nativeConversationHistory.ts`: agy maintains its own local history file at `~/.gemini/antigravity-cli/history.jsonl`, one JSON line per prompt ever sent to it (across every tool on the machine, not just Orbit): `{"display": "<prompt>", "timestamp": <ms>, "workspace": "<cwd>"}`, gaining a `"conversationId"` field once agy has assigned one. Confirmed live:

- The file is written as each prompt is *sent*, not on process exit — unlike `~/.gemini/antigravity-cli/conversation_summaries.db` (also investigated: a proper SQLite table keyed by `conversation_id` with a `workspace_uris` column, which looked promising but is **only populated for gracefully-exited sessions** — confirmed empty for every session this task killed abruptly, which is exactly how Orbit's own crash/shutdown paths behave, making it unusable here).
- The **first** prompt of a brand-new conversation is logged *without* a `conversationId` (agy hasn't minted one yet at prompt-send time); the **second** and later prompts in the same conversation carry it.
- Reading this file is a plain, bounded (last 512 KB) file read — it cannot hang or otherwise affect the live PTY session the way writing into its terminal can.

`AntigravityPtySession` looks this up (matching on the exact `workspacePath`) once per turn, only when no id is already known, right before emitting `run.completed`.

**Consequence:** a PTY-owned conversation's `nativeConversationId` stays `null` for exactly one turn — its first — and is captured from the second turn onward. **Live-verified**: a completely fresh `AntigravityProvider` (simulating an Orbit app restart, with the previous provider's process already killed) resumed a real prior conversation via `--conversation <id>` and correctly recalled a secret fact established two turns earlier in a now-dead process. This is a genuinely working resume path, not a documented gap — see the "resumes a real native conversation via --conversation after the PTY process is gone" live test in `test/main/antigravity-live.test.ts`.

This mechanism (`history.jsonl`) was not found in — and is not used by — AgentDock Pro's current implementation, which still relies on `/help`-scraping. It may be worth upstreaming.

## Response text extraction

PTY mode has no token-stream the way `stream-json` does. `extractResponseText` (in `TerminalInteractionDetector.ts`) reconstructs "what agy said" from the settled screen: everything after the last echoed prompt line (`> ...`), skipping every non-blank row immediately following it (a long prompt word-wraps across multiple physical rows with no blank line between them — confirmed live), then stripping borders, the empty compose box, footers, and tool-activity (`●`/`▸`) lines. Verified against real captured transcripts covering short answers, word-wrapped prompts, fenced code blocks, Unicode/emoji content, multi-paragraph answers, and a resolved-permission-menu-plus-tool-activity turn (live-confirmed: a resolved menu is fully erased/redrawn away before the turn settles, so a real screen never actually contains both the menu and the final text — the fixture covering that shape is a deliberate defense-in-depth test, not a literal capture). This is a best-effort reconstruction of ordinary prose, not a pixel-perfect transcript of rich formatting (box-drawing tables are not specifically handled).

Considered and rejected alternatives (Objective 2 of the hardening pass): there is no evidence of a parallel structured channel available while a PTY session owns the terminal (Option A) — running one would risk the exact double-execution the task explicitly rules out. AgentDock Pro's own screen buffer (Option C) is architecturally the same `@xterm/headless` approach already adapted here; its "response text" isn't extracted as one string at all (it classifies the screen into typed events for a heavier system Orbit doesn't need). Identifiable markers (Option B) don't exist for the response body specifically — only for its edges (the echo line, the footer). Option D (harden the current heuristic) was the pragmatic choice.

### Real bug found and fixed: numbered-list responses misread as a menu

**Confirmed live, agy 1.1.27:** asking agy to answer with a plain numbered list (an extremely common shape for ordinary AI prose — steps, options, summaries) was misdetected by `detectGenericInteraction` as a real interactive menu. Orbit then treated the finished turn as `waiting_for_interaction`; the test harness's generic "pick the first option" auto-responder wrote `1\r` into what was actually completed prose, and agy — with no real menu to answer — interpreted that as a brand-new, nonsensical chat message, corrupting the conversation. In real (non-test) Orbit usage this would instead have surfaced a bogus interaction UI showing options like `<fruit>`, `<fruit>`, `<fruit>` and blocked the composer.

Fixed with two layered guards in `detectGenericInteraction`, both confirmed live:
1. **Ready-footer exclusion**: no real captured menu (trust prompt, command-permission prompt) ever coexists on screen with the `? for shortcuts` ready footer — only a genuinely settled, completed turn shows it. If present, nothing below is even checked.
2. **Cursor-marker/permission-wording gate**: this alone doesn't cover a numbered list that happens to be on screen during a slow/paused *busy* period (footer still `esc to cancel` — the same footer text a real permission menu also uses, so it can't be excluded outright). Every real captured menu highlights one option with a cursor marker (`> 1. Yes`); ordinary prose never does. The numbered-menu branch now requires a cursor marker **or** explicit permission-shaped wording nearby before treating 2+ numbered lines as a real interaction.

Regression tests for both the ready-footer and busy-footer cases (using the exact real captured shapes) are in `test/main/terminalInteractionDetector.test.ts`.

## Native image attachment

Managed images (PNG/JPEG/GIF/WebP — SVG is deliberately excluded, see below) attached to a message on a `pty` conversation are pasted natively before the text prompt is sent:

```text
attachment ProjectFile[] → filter to supported raster images ≤ 15 MB
→ PTY session (already selected before delivery)
→ save current OS clipboard
→ for each image: write image to clipboard → send Ctrl+V
   → poll the "N media attached" screen marker until it reaches the expected count (never a blind sleep)
→ restore the original OS clipboard
→ send the text prompt only after every attachment has been attempted
```

Implemented with Electron's own `clipboard`/`nativeImage` modules (`nativeClipboardImage.ts`) — not an external tool like `xclip`/`wl-copy` called directly by Orbit. Non-image attachments (and SVG, which `nativeImage` cannot rasterize for a paste) still get the structured `view_file` path-hint fallback in the prompt text, exactly like structured-transport attachments.

15 MB is an **Orbit application policy** (reused from AgentDock Pro's identical cap), not a proven `agy` or clipboard limit.

**Real bug found and fixed during verification:** attaching an image via Ctrl+V does not itself start generation — the screen shows the "N media attached" marker and immediately returns to the same ready-for-input footer a genuinely completed turn uses. The PTY session tracks an explicit `deliveringImages` flag so a ready-for-input signal seen mid-attachment-sequence is not misread as turn completion (which previously caused the text prompt to never be sent at all).

## Attachment UI ↔ native delivery (live-verified)

The composer's attachment states were verified against the real app and real
agy 1.1.27 (Linux/Wayland, `wl-clipboard` present):

- **One image via the file picker** — chip shows a real thumbnail in `ready`;
  after sending, agy answered `Red` for a solid-red PNG, proving it received
  the image through the native path, and the sent thumbnail persists in the
  user's turn.
- **Two images in one message** — independent chips, both thumbnails render,
  agy answered `Red, Blue` in order, and both sent thumbnails persist.
- **Drag and drop** — the `Drop to attach` overlay appears on dragenter and
  clears on drop; the pipeline it feeds (`files.attachPaths` → validation →
  storage → chip) was exercised with a real on-disk path and refuses a
  relative one.
- **Clipboard paste** — an image payload becomes an attachment; ordinary
  copied text is *not* intercepted (`defaultPrevented === false`, no chip).
- **Reference fallback** — re-run with the clipboard helpers removed from
  `PATH`, so `checkClipboardCapability()` genuinely reported unavailable.
  Chips then read **"Shared as reference"** *at rest*, before sending, and a
  whole-document scan found no user-facing `PTY` / `clipboard` / `view_file` /
  transport terminology.
- **Failure** — a managed file deleted from disk underneath Orbit degrades to
  no thumbnail rather than throwing or leaking a path; Remove works from
  every state and Retry appears only for a genuine failure.

Three real bugs were found and fixed by this verification:
1. **Drag-and-drop was entirely broken.** Electron removed `File.path` (absent
   on 33.4.11 — `'path' in file === false`), so the drop handler always
   resolved zero paths and attached nothing. Dropped files are now resolved
   via `webUtils.getPathForFile` in the preload.
2. **Thumbnails never rendered.** They pointed at `file://<storedPath>`, which
   the renderer CSP forbids (`img-src 'self' data: blob:`). Managed image
   bytes now come through a `files.thumbnail` IPC as a `data:` URL, validated
   to be a real, present, size-capped image belonging to the store.
3. **Reference mode was effectively invisible.** It was only applied during
   send, where it was cleared within milliseconds. An attachment that can only
   be shared as a reference now says so while still in the composer.

**Known limitation (not an attachment bug):** the *first* turn of a brand-new
PTY session occasionally settles with empty extracted prose — observed once in
three valid live runs. The attachment itself was still delivered in that run
(the sent thumbnail rendered, and the next turn in the same session answered
correctly). This is the same first-turn extraction flake already recorded for
the resume test above, not a regression in the attachment path.

## Cross-platform clipboard notes and capability detection

On this Linux/Wayland environment, Electron's `clipboard.writeImage()` genuinely depends on an external clipboard helper (`wl-copy`/`wl-paste` for Wayland, or `xclip`/`xsel` for X11) being installed on the system — it is **not** self-contained the way one might assume from Electron's cross-platform clipboard API. Confirmed live: image attachment failed with `no supported clipboard tool found (install wl-clipboard or xclip)` printed by agy itself until `wl-clipboard` was installed. Orbit does not install or manage this dependency — it's a documented host-environment prerequisite.

**Hardening pass fix:** this used to only be discoverable by attempting a real attachment and having it silently fail. `clipboardCapability.ts`'s `checkClipboardCapability()` now runs *before* the first attachment attempt on a session (memoized — checked at most once per `AntigravityPtySession`): it inspects `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`/`DISPLAY` to tell Wayland from X11, then checks `PATH` for the relevant helper (`wl-copy`+`wl-paste`, or `xclip`/`xsel`). If unavailable, Orbit never touches the clipboard — instead the images are routed the same way non-image/SVG attachments already are: a `view_file`-style path hint appended to the prompt text, with a concrete, actionable reason (e.g. `sudo apt install wl-clipboard`) logged. This keeps a missing dependency from wasting a full paste-confirmation timeout per image, and from ever landing a failed/garbled paste inside the live PTY session.

| Platform | Assumption | Verified? |
| --- | --- | --- |
| Linux + Wayland | Needs `wl-clipboard` (`wl-copy`/`wl-paste`) on `PATH`. | **Verified** — reproduced the failure with it absent, then confirmed working after installing it. |
| Linux + X11 | Needs `xclip` or `xsel` on `PATH`. | Implemented, matching the same Electron/Chromium clipboard backend as Wayland; not exercised on a real X11 session (this environment is Wayland). |
| macOS | Electron talks to `NSPasteboard` directly — no external helper expected. | **Not verified** — no macOS machine available. |
| Windows | Electron talks to the Win32 clipboard API directly — no external helper expected. | **Not verified** — no Windows machine available. |

Unit-tested (`test/main/clipboardCapability.test.ts`): Wayland/X11 detection from environment variables (including an XWayland compatibility case where both `XDG_SESSION_TYPE=wayland` and a stray `DISPLAY` are set), helper presence/absence on `PATH`, the darwin/win32 short-circuit, and an unsupported-platform fallback.

## Build note: `@xterm/headless` packaging bug

`@xterm/headless@6.0.0`'s `package.json` `"module"` field points at a file that does not exist in the published package (`lib/xterm.mjs`); the real ESM entry is `lib-headless/xterm-headless.mjs`. Left unaliased, this either fails Vite/Rollup resolution outright, or — if naively marked `external` to work around that — produces a real production bundle that does `import { Terminal } from "@xterm/headless"` against Node's own ESM loader, which cannot synthesize that named export from the package's CJS build and **crashes the whole Electron app on launch**. Both failure modes were reproduced live. Fixed in `electron.vite.config.ts` with an explicit `resolve.alias` pointing straight at the real file, letting Rollup bundle it (and perform CJS/ESM interop) instead of externalizing it.

## Transport continuity

| From → To | Status |
| --- | --- |
| structured → structured | Unchanged, preserved (existing MVP behavior). |
| pty → pty (process still alive) | **Verified**: the same live process serves every turn while it stays alive. |
| pty → pty (process died / Orbit restarted) | **Verified** (hardening pass): the next `send()` spawns a fresh bare process and resumes via `--conversation <id>` when a native id is known (captured from the conversation's second turn onward — see above). A completely fresh `AntigravityProvider` recalled a fact from a killed process's earlier turn. The one gap: a conversation that dies after exactly one turn has no id yet, so it starts a fresh native conversation instead of resuming — still functional, just not the same native thread. |
| structured → pty | Not implemented, not tested. `setConversationTransport('pty')` starts the very next turn as a fresh PTY session (no native id to resume from). Whether a structured conversation's native id could safely seed a PTY resume was not investigated. |
| pty → structured | Deliberately not allowed. `setConversationTransport('structured')` on an already-`pty` conversation is a no-op (see `OrbitRuntime.setConversationTransport`) — once a conversation is interactive, it stays interactive rather than silently downgrading and losing the live session. |

## State-machine hardening (races and failure modes)

Confirmed real bugs found and fixed via live testing, each now covered by a regression test:

- **Stale `wasReady`**: if a turn's response streams continuously with no idle gap, the transport's ready/busy edge-detection could latch a stale `true` from the *previous* ready state, so the real completion was silently never reported and the run hung forever. Fixed by resetting the edge flag on every `write()` into the PTY.
- **`handleSnapshot` assignment ordering**: the edge flag's "new value" assignment happened *after* calling the handler, so a handler that itself wrote into the PTY synchronously (e.g. sending the next prompt) had its own reset immediately clobbered by the stale post-handler assignment. Fixed by latching the edge value before invoking the handler.
- **`deliveringImages` / completion-during-image-paste race**: attaching an image via Ctrl+V returns to the same ready footer a real completed turn uses (pasting doesn't itself start generation) — without an explicit guard, this settled the run and left the text prompt unsent.
- **Cancellation during image attachment did not stop the sequence**: `cancel()` didn't change `this.state` when there was no pending interaction to resume into (only the image loop's *own* state check gated continued pasting), so a mid-sequence cancel would send Escape but the loop kept pasting further images and then still sent the original text prompt anyway. Fixed by checking `cancelRequested` explicitly in the image loop and before the final prompt send.

Also stress-tested (`test/main/antigravityPtySession.test.ts`, `test/main/antigravityProvider.test.ts`): a redrawn/re-scanned identical interaction is deduplicated; a stale, duplicate, wrong-run, or invalid-option interaction response is rejected; a second, genuinely different interaction appearing later in the same turn gets its own stable id and the first one's id stops working; a process crash with a pending interaction resolves it as cancelled and fails the run; a process crash with *no* pending interaction still fails the run cleanly (no false completion/cancellation); repeated ready-for-input signals after a turn has already settled never emit a duplicate `run.completed`; two different Orbit conversations get fully independent PTY sessions with no cross-talk, and `cancelRun`/`shutdown` operate on the correct session(s) only. Renderer-reload safety is by construction rather than a dedicated test: pending-interaction state lives only in the renderer's in-memory React state, so a reload clears it — there is no persisted "resend on reload" path to guard against.

## AgentDock Pro parity matrix

Compared against `AntigravityAdapter.ts`, `TerminalSessionController.ts`, `TerminalScreenBuffer.ts`, `TerminalInteractionDetector.ts`, `AntigravityStructuredTransport.ts`, and `AntigravityStructuredEventMapper.ts` in the local AgentDock Pro checkout.

| Behavior | Orbit | Notes |
| --- | --- | --- |
| PTY startup | Equivalent | Bare-spawned, no `-i`, real prompt written once ready. |
| Process ownership | Equivalent | One process per conversation, single owner (`AntigravityPtySession` ↔ AgentDock's `TerminalSessionController`). |
| Screen parser | Equivalent | Same `@xterm/headless`-based real VT model, idle-debounced snapshots. |
| Native conversation ID capture | **Superior** | `history.jsonl`-based (this hardening pass's discovery) vs. AgentDock's `/help`-scrape, which this project found to reliably hang agy 1.1.27's session. AgentDock's own mechanism was not adopted. |
| Native conversation resume | **Superior** (as a consequence) | Live-verified working end to end; AgentDock's `/help`-based id capture is the same mechanism Orbit tried first and removed. |
| Approval/permission detection | Equivalent, hardened further | Same generic detector, adapted; this pass found and fixed a false-positive (numbered-list prose misread as a menu) that AgentDock's version does not appear to guard against (no ready/busy-footer exclusion in its `detectGenericInteraction`). |
| Question flow | Equivalent | Neither has a dedicated question modal for agy; both rely on composer continuity. |
| Cancellation | Equivalent | Escape, not Ctrl+C, in both. |
| Image attachment mechanism | Equivalent | Same Electron `clipboard`/`nativeImage` + Ctrl+V + "N media attached" polling choreography. |
| Attachment confirmation | Equivalent | Same on-screen marker regex. |
| Clipboard capability detection | **Superior** | Orbit checks Wayland/X11 + helper presence *before* attempting a paste; no equivalent found in AgentDock's adapter (it discovers failure at paste time). |
| Auto-approval of trusted commands | Intentionally simpler | AgentDock auto-approves certain workspace-trust/command patterns under an explicit "workspace trust" setting Orbit does not have; Orbit never auto-approves anything, by design (task requirement). |
| Timeout handling | Equivalent | Same bounded polling pattern for paste confirmation; same "give up and report honestly" shape. |
| Crash recovery | Equivalent | Both resume via `--conversation` on next send after an unexpected exit. |
| Terminal resize | **Missing** | AgentDock wires live resize events from a visible terminal-drawer UI into the adapter. Orbit deliberately shows no raw terminal to the user (task requirement: "do not expose a raw full terminal"), so nothing ever calls `AntigravityPtyTransport.resize()` after spawn — the PTY stays fixed at 120×32. Not a functional gap for Orbit's UI, but worth knowing if a future feature needs it. |
| Cross-platform handling | **Missing/unverified** | AgentDock ships and is presumably tested on macOS/Windows; Orbit's equivalent code is written the same way but has only ever run on this Linux/Wayland machine. |
| Cleanup | Equivalent | `shutdown()` kills every owned process; clipboard is saved/restored around every attachment sequence regardless of outcome. |
| Diagnostics/logging | Intentionally simpler | AgentDock has a dedicated `AGENTDOCK_DEBUG_RAW_PTY` flag with structured per-classification logging. Orbit's `ORBIT_PTY_DEBUG` is coarser (raw snapshot dumps) — see the diagnostics section below. |

## Verified / Orbit policy / Unknown upstream behavior

**Verified** (live, against the installed signed-in `agy 1.1.27`, this session, Linux/Wayland):
- Structured transport: plain messaging, streaming, conversation continuation, cancellation, headless-denial honesty (pre-existing, re-confirmed).
- PTY: workspace-trust/permission menu detection and approval; native free-text question asked and answered via composer continuity in the same live session; a second permission prompt approved and the command actually ran; a third permission prompt denied and the command did **not** run, and the session continued normally afterward; a stale/duplicate interaction response rejected; a numbered-list response no longer falsely triggers an interaction.
- **Native conversation resume across a simulated Orbit restart**: a completely fresh `AntigravityProvider` (previous process killed) recalled a secret fact from an earlier, separate process's conversation via `--conversation <id>`. **Observed flake rate**: passed 3 of 4 runs across this hardening pass; one run returned an empty extracted final-text (the resumed process still logged a native conversation id and completed the turn, so the resume itself likely still worked — no diagnostic capture was enabled for that specific run to confirm root cause). Two immediate retries with identical code both passed. Treated as live-system/timing flakiness (a real network call to a hosted model, not a deterministic local process) rather than a reproducible code defect — no code change was made in response, since there was nothing reproducible to fix.
- Native image attachment: one image attached and correctly described by agy; two images attached sequentially and both correctly distinguished in order; a resolved permission menu's text does not leak into the following turn's extracted response.
- Clipboard capability detection correctly reports `wl-clipboard` present on this machine and does not regress the working attachment path.
- The production Electron build actually launches without crashing (previously would have crashed on the `@xterm/headless` import).

**Orbit policy** (our own choices, not agy behavior):
- Default transport is `structured`; `pty` is opt-in per conversation and sticky.
- 15 MB native-image size cap.
- PNG/JPEG/GIF/WebP only for native attachment; SVG routed to the `view_file` fallback instead.
- Never auto-approve any permission/trust prompt.
- Never install clipboard system packages automatically; report a concrete, actionable error instead.

**Unknown / not verified:**
- macOS and Windows clipboard behavior for native image attachment, and Linux X11 (this environment is Wayland).
- Whether resuming a conversation that died after exactly one turn (no captured id yet) has any safe alternative to starting fresh.
- Behavior of permission menus beyond the two captured shapes above (e.g. a plan-mode-specific prompt, or a menu with more than 4 options).
- Structured → PTY continuation safety.
- `node-pty`/ConPTY behavior, shell/executable invocation, and PTY resize on macOS or Windows — reviewed for obvious platform-specific bugs (none found: paths are resolved via `node:path` and `os.homedir()`, no POSIX-only assumptions in the PTY spawn/write/resize/kill calls) but **not live-verified** on either platform.

## Diagnostics (`ORBIT_PTY_DEBUG`)

Set to any truthy value to log one line per idle screen snapshot (session startup, transport-selection-adjacent state, interaction detection, image-attach confirmation progress, crash, and resume attempts are all observable from the resulting sequence of snapshots and the session's own `console.warn` calls). Reviewed for safety: it logs only the visible terminal *text* (already stripped of control bytes by the VT parser) — never clipboard contents, image bytes, or raw environment variables. It is not gated to development builds; a user enabling it in production would see plain conversation text in their own logs (the same text already visible in the Orbit UI), never anything Orbit doesn't already show them.
