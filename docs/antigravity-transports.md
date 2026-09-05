# Antigravity transports

Orbit talks to the installed, signed-in `agy` CLI through one of two transports, selected once per conversation and never guessed from message content.

```text
renderer → preload → validated IPC → OrbitRuntime → AntigravityProvider → transport
```

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

## Removed: `/help` conversation-ID capture

An earlier version of this transport tried to capture agy's own conversation UUID via a scripted `/help` round trip (the approach AgentDock Pro's PTY adapter uses). **Live-tested against agy 1.1.27 and found to reliably hang the entire session** — after sending `/help`, no further screen activity was ever observed, and even a 6s bounded fallback timer never produced any effect (root cause not fully isolated; removed rather than shipped broken). See git history for the removed code if a future agent wants to re-investigate with a different mechanism.

**Consequence:** a PTY-owned conversation's `nativeConversationId` stays `null`. The live process itself carries the conversation for as long as it runs (full turn continuity, question continuity, and interaction handling all work); what's lost is resuming the *same* native conversation via `--conversation <id>` after Orbit itself restarts and the process is gone. This is an accepted, documented gap — not silently worked around.

## Response text extraction

PTY mode has no token-stream the way `stream-json` does. `extractResponseText` (in `TerminalInteractionDetector.ts`) reconstructs "what agy said" from the settled screen: everything after the last echoed prompt line (`> ...`), skipping every non-blank row immediately following it (a long prompt word-wraps across multiple physical rows with no blank line between them — confirmed live), then stripping borders, the empty compose box, footers, and tool-activity (`●`/`▸`) lines. This is a best-effort reconstruction of ordinary prose, not a pixel-perfect transcript of rich formatting (tables, code blocks with box-drawing, etc. are not specifically handled).

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

## Cross-platform clipboard notes

On this Linux/Wayland environment, Electron's `clipboard.writeImage()` genuinely depends on an external clipboard helper (`wl-copy`/`wl-paste` for Wayland, or `xclip`/`xsel` for X11) being installed on the system — it is **not** self-contained the way one might assume from Electron's cross-platform clipboard API. Confirmed live: image attachment failed with `no supported clipboard tool found (install wl-clipboard or xclip)` printed by agy itself until `wl-clipboard` was installed. Orbit does not install or manage this dependency; it is a documented host-environment prerequisite for native image attachment on Linux. macOS/Windows clipboard behavior is not verified by this work (implemented via the same Electron API, but never tested on those platforms).

## Build note: `@xterm/headless` packaging bug

`@xterm/headless@6.0.0`'s `package.json` `"module"` field points at a file that does not exist in the published package (`lib/xterm.mjs`); the real ESM entry is `lib-headless/xterm-headless.mjs`. Left unaliased, this either fails Vite/Rollup resolution outright, or — if naively marked `external` to work around that — produces a real production bundle that does `import { Terminal } from "@xterm/headless"` against Node's own ESM loader, which cannot synthesize that named export from the package's CJS build and **crashes the whole Electron app on launch**. Both failure modes were reproduced live. Fixed in `electron.vite.config.ts` with an explicit `resolve.alias` pointing straight at the real file, letting Rollup bundle it (and perform CJS/ESM interop) instead of externalizing it.

## Transport continuity

| From → To | Status |
| --- | --- |
| structured → structured | Unchanged, preserved (existing MVP behavior). |
| pty → pty | Verified: the same live process serves every turn while it stays alive. If the process has exited, the next `send()` spawns a fresh bare process and resumes via `--conversation <id>` **when a native id is known** — since PTY sessions currently never capture one (see above), a PTY session that outlives the current Orbit process cannot actually resume the same native conversation; it starts a new one. This is a real, accepted limitation, not a silent failure — resuming still "works" in the sense that it starts a fresh, functional session with the same `--add-dir` scope. |
| structured → pty | Not implemented, not tested. `setConversationTransport('pty')` starts the very next turn as a fresh PTY session (no native id to resume from). Whether a structured conversation's native id could safely seed a PTY resume was not investigated. |
| pty → structured | Deliberately not allowed. `setConversationTransport('structured')` on an already-`pty` conversation is a no-op (see `OrbitRuntime.setConversationTransport`) — once a conversation is interactive, it stays interactive rather than silently downgrading and losing the live session. |

## Verified / Orbit policy / Unknown upstream behavior

**Verified** (live, against the installed signed-in `agy 1.1.27`, this session, Linux/Wayland):
- Structured transport: plain messaging, streaming, conversation continuation, cancellation, headless-denial honesty (pre-existing, re-confirmed).
- PTY: workspace-trust/permission menu detection and approval; native free-text question asked and answered via composer continuity in the same live session; a second permission prompt approved and the command actually ran; a third permission prompt denied and the command did **not** run, and the session continued normally afterward; a stale/duplicate interaction response rejected.
- Native image attachment: one image attached and correctly described by agy; two images attached sequentially and both correctly distinguished in order.
- The production Electron build actually launches without crashing (previously would have crashed on the `@xterm/headless` import).

**Orbit policy** (our own choices, not agy behavior):
- Default transport is `structured`; `pty` is opt-in per conversation and sticky.
- 15 MB native-image size cap.
- PNG/JPEG/GIF/WebP only for native attachment; SVG routed to the `view_file` fallback instead.
- Never auto-approve any permission/trust prompt.

**Unknown / not verified:**
- macOS and Windows clipboard behavior for native image attachment.
- Whether a PTY session can safely resume a native conversation across an Orbit restart (no id is ever captured, so this has never actually been exercised).
- Behavior of permission menus beyond the two captured shapes above (e.g. a plan-mode-specific prompt, or a menu with more than 4 options).
- Structured → PTY continuation safety.
