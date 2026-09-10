# Antigravity transports

Orbit talks to the installed, signed-in `agy` CLI through one of two transports, selected once per conversation and never guessed from message content.

```text
renderer → preload → validated IPC → OrbitRuntime → AntigravityProvider → transport
```

## Model and reasoning effort

**Orbit owns its default model.** There is no state in which Orbit invokes
`agy` without naming a model and then waits to discover what `agy` chose.
Every run passes an explicit `--model`, the id is a real entry from the live
`agy models` catalogue, and the id Orbit stores and displays is the same id
it passed.

Source of truth: `src/shared/defaultModel.ts`. Precedence is

1. `OrbitPreferences.defaultModel` when the live catalogue still lists it —
   this is the hook a future "default model" setting writes to, and nothing
   else needs to change for it to become one;
2. the first of `ORBIT_PREFERRED_DEFAULT_MODELS` the catalogue contains
   (`gemini-3.8-flash` on the current one);
3. the catalogue's own first entry — so a future catalogue that renames
   everything still resolves concretely rather than deferring to `agy`.

It is enforced at three depths, each independently sufficient for what it
covers:

- **`OrbitRuntime.sendMessage`** resolves the session against the live
  catalogue *before* the turn is persisted or dispatched, and writes the
  resolved id back onto the conversation. This is the guarantee: no run
  begins on an unresolved session, whatever route reached it.
- **`AntigravityProvider.sendMessage`** refuses to spawn at all if the
  resolution produced no model (`provider.model_unresolved`), so no code
  path can reach `agy` without one.
- **The renderer** settles the active session the moment the catalogue
  loads, so the picker shows the real model from the session's first frame
  rather than after its first turn.

**What was removed.** `conversation.model === null` used to mean "let
Antigravity decide", and it was the state every new session started in. It
was surfaced as a selectable **"Default model" / "Antigravity's own
choice"** row in both the popover and the full browser, backed by a
`DEFAULT_MODEL_OPTION` sentinel (`antigravity:default`) that claimed all
three reasoning tiers. `resolveInvocation` then emitted no `--model` at all
for it. All of that is gone: `null` is now only the brief pre-resolution
moment, the picker offers real catalogue models exclusively, and
`resolveInvocation` never produces a model-less invocation while a catalogue
exists.

Two further cases used to end in `agy` choosing, and no longer do:

| case | before | now |
| --- | --- | --- |
| nothing selected | no `--model`, `agy` picks | `--model <Orbit's default> --effort <tier>` |
| multi-tier base with a missing or invalid tier | **model dropped entirely**, `agy` picks | model kept, tier resolved to the nearest one it genuinely publishes |

**Legacy sessions** carrying the old `null` (and any session naming a model
the catalogue has since dropped) are migrated the first time they are opened
or run, whichever comes first, and the migration is persisted. A session
holding a raw *combined* id (`gemini-3.8-flash-medium`) is left alone — `agy`
accepts it directly, so re-resolving it would silently move the user off a
model that works.

**Deliberate trade-off:** if `agy models` cannot be read at all there is
nothing concrete to name, and Orbit fails the turn
(`provider.model_unresolved`) rather than falling back to `agy`'s own
default. The catalogue fetch does not latch an empty result, so a transient
failure recovers on the next attempt.

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
- `retiring`: a model change is retiring the predecessor and this run is owed the replacement. Counts as busy, and holds ownership through the `Retirement` record — see "Retiring a PTY process" and "Cancelling a run that does not have a process yet".
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

PTY mode has no token-stream the way `stream-json` does; the screen is the only source, and it is read both progressively during a turn and once when it settles (see "Streaming assistant text" below). `extractResponseText` (in `TerminalInteractionDetector.ts`) reconstructs "what agy said" from the screen: everything after the echoed prompt line (`> ...`) — consuming however many rows the known prompt word-wrapped onto when the prompt is supplied, otherwise falling back to skipping non-blank rows until the first blank one — cut at the compose box, then stripping borders, footers, tool-activity (`●`/`▸`), Braille spinner and `└ Tip:` status rows. Verified against real captured transcripts covering short answers, word-wrapped prompts, fenced code blocks, Unicode/emoji content, multi-paragraph answers, and a resolved-permission-menu-plus-tool-activity turn (live-confirmed: a resolved menu is fully erased/redrawn away before the turn settles, so a real screen never actually contains both the menu and the final text — the fixture covering that shape is a deliberate defense-in-depth test, not a literal capture). This is a best-effort reconstruction of ordinary prose, not a pixel-perfect transcript of rich formatting (box-drawing tables are not specifically handled).

Considered and rejected alternatives: there is no evidence of a parallel structured channel available while a PTY session owns the terminal (Option A) — running one would risk double execution, which is why progressive text is read from the screen the session already owns rather than from a second agy process. AgentDock Pro's own screen buffer (Option C) is architecturally the same `@xterm/headless` approach already adapted here; its "response text" isn't extracted as one string at all (it classifies the screen into typed events for a heavier system Orbit doesn't need). Identifiable markers (Option B) don't exist for the response body specifically — only for its edges (the echo line, the footer). Option D (harden the current heuristic) was the pragmatic choice.

### Real bug found and fixed: numbered-list responses misread as a menu

**Confirmed live, agy 1.1.27:** asking agy to answer with a plain numbered list (an extremely common shape for ordinary AI prose — steps, options, summaries) was misdetected by `detectGenericInteraction` as a real interactive menu. Orbit then treated the finished turn as `waiting_for_interaction`; the test harness's generic "pick the first option" auto-responder wrote `1\r` into what was actually completed prose, and agy — with no real menu to answer — interpreted that as a brand-new, nonsensical chat message, corrupting the conversation. In real (non-test) Orbit usage this would instead have surfaced a bogus interaction UI showing options like `<fruit>`, `<fruit>`, `<fruit>` and blocked the composer.

Fixed with two layered guards in `detectGenericInteraction`, both confirmed live:
1. **Ready-footer exclusion**: no real captured menu (trust prompt, command-permission prompt) ever coexists on screen with the `? for shortcuts` ready footer — only a genuinely settled, completed turn shows it. If present, nothing below is even checked.
2. **Cursor-marker/permission-wording gate**: this alone doesn't cover a numbered list that happens to be on screen during a slow/paused *busy* period (footer still `esc to cancel` — the same footer text a real permission menu also uses, so it can't be excluded outright). Every real captured menu highlights one option with a cursor marker (`> 1. Yes`); ordinary prose never does. The numbered-menu branch now requires a cursor marker **or** explicit permission-shaped wording nearby before treating 2+ numbered lines as a real interaction.

Regression tests for both the ready-footer and busy-footer cases (using the exact real captured shapes) are in `test/main/terminalInteractionDetector.test.ts`.

## Streaming assistant text (issue #2)

**Symptom:** Orbit sat on `Working` / `Replying` and then displayed the whole
answer at once.

**Root cause — two independent causes, one per transport:**

1. **PTY had no incremental text path at all.** `AntigravityPtySession` only
   ever called `extractResponseText` once, in `settleTurn()`, and emitted the
   whole result with `run.completed`. Worse, the screen was only ever read on
   the transport's *idle-debounced* (450 ms) snapshot — and agy writes a long
   answer continuously, so that debounce never fires until the turn is
   already over. **Measured live:** a 14-second PTY turn produced exactly
   **one** screen snapshot, after completion. Every interactive conversation
   therefore showed `Working → nothing → entire answer`, 100% of the time.
2. **The renderer erased the streamed answer at completion.** `run.completed`
   deleted `runningRunByConversation` and `streamTextByRun` synchronously and
   only *then* awaited the project refresh that loads the persisted assistant
   message, so the finished reply was off screen for the whole round trip.

The structured transport's `stream-json` normalizer was **not** at fault —
see the evidence below. It already converted every incremental
`agent_response` delta into `text.delta` correctly.

### Real captured `agy 1.1.27` evidence

Raw `agy --print <prompt> --output-format stream-json --add-dir <ws>`,
one line per event, timestamped from process start:

```text
  7276ms init            conversation_id=0f204da1-…
  7482ms step_update     idx=0 DONE  user_input
 19519ms step_update     idx=1 ACTIVE agent_response  text_delta 156 chars
 19721ms step_update     idx=1 ACTIVE agent_response  text_delta 246 chars
 …  (deltas every ~200 ms) …
 21124ms step_update     idx=1 DONE   agent_response  text_delta 3710 chars
 21124ms result          SUCCESS  response 5718 chars
```

Verified across four captured turns of different lengths, including a
54,546-character one with 230 deltas and a tool-using turn:

- agy **does** emit assistant prose incrementally (`step_update` /
  `step_type: "agent_response"` / `text_delta`) — so this is case 1 of the
  issue, not case 2, for the structured transport.
- The concatenated deltas equal `result.response` **exactly**, byte for byte,
  in every captured turn.
- The final delta (`state: "DONE"`, same millisecond as `result`) carries
  whatever agy had not flushed yet — 62–73% of a long answer. That is agy's
  own behaviour and is not something Orbit can change.
- A turn can contain an `agent_response` step with **no** `text_delta` field
  at all (captured on a tool-using turn); a short answer arrives as a single
  `DONE` delta with nothing to stream before it.
- agy emits nothing at all during the model's thinking phase (12–18 s on
  these turns), which is the bulk of the perceived wait.

The PTY screen was captured the same way — `TerminalScreenBuffer` sampled
every 200 ms through one real turn. Six of those frames are checked in
verbatim as `test/main/fixtures/agyPtyStreamFrames.json`. They show the
answer genuinely growing on screen (426 → 826 → 1144 → 1426 → 4266
characters), which is what makes progressive PTY reading possible at all
without a second agy process.

### What changed

**PTY — progressive reading of the live screen.** No second process, no
parallel structured run, no fake reveal: the same single `agy` process and
the same `TerminalScreenBuffer` VT model that already backed the transport.

- `AntigravityPtyTransport` gained a second, **read-only** reader:
  `onStreamText`, sampled every 120 ms while output is arriving, and only
  when xterm has finished parsing what it was given (`TerminalScreenBuffer.
  isDrained`). It never classifies the screen — ready/busy/interaction
  detection remains the exclusive job of the idle-debounced snapshot, whose
  logic and edge-flag invariants are untouched.
- `AntigravityPtySession` turns each sample into ordinary `text.delta`
  events, and only while a turn is genuinely in flight: not during
  bootstrap (which would leak agy's startup banner, including the signed-in
  account's email), not while an interaction is pending, not during an image
  paste sequence, and not after a cancel.
- `run.completed`'s `finalText` is still the authoritative answer and is
  still extracted the same way. Nothing was removed.

**Extraction (`extractResponseText`) hardened with what the real screens
showed.** Each of these was a live-observed defect, not a hypothetical:

| Real screen behaviour | What it broke | Fix |
| --- | --- | --- |
| The blank line agy leaves under the echoed prompt disappears once the terminal scrolls | The "skip rows until the first blank" anchor then ate the first lines of the answer — mid-stream it read as a completely different answer and stalled streaming for the rest of the turn | The known prompt is now matched across however many rows it wrapped onto (`{ prompt }`), with the old blank-line heuristic kept as the fallback |
| A Braille spinner line (`⣽  Working...`, `⢿  Verifying Requirements Thoroughly...`) sits at the end of the answer and is rewritten every frame | Every frame looked different from the last | Spinner rows are chrome and are dropped |
| agy hangs a rotating hint off the working indicator: `└ Tip: Use /model to switch between available models.` | It was extracted **as the assistant's reply**, and because it rotates, everything after it stopped matching — this is what limited a real 10,907-character answer to a single delta | `└`-prefixed status rows are chrome and are dropped |
| agy prints that tip *below* the compose box | Walking up from the last row stopped at the tip and kept the whole box | The body is now cut **at** the compose box (`───` / `>` / `───`), so anything below it is gone by construction |
| Trailing cell padding shifts between redraws | Frames differed by invisible whitespace | Kept rows are right-trimmed |

**Comparing frames (`progressiveAppendIndex`).** agy's TUI is a full-redraw
display, so a new frame is not simply "the old text plus more": it re-wraps,
re-pads, scrolls, and resolves markdown emphasis a beat after drawing the raw
`**`. Comparison is therefore anchored on the **tail** of what has already
been streamed, over visible characters only, taking the last occurrence. A
frame whose tail is absent (a redraw sampled mid-write) is skipped and
recovers on the next one. If frames keep failing to line up — which happens
when agy rewrites text it had already drawn — the reader resynchronizes on
the current screen after 3 frames rather than freezing for the rest of the
turn. Nothing is ever re-emitted, so no text is duplicated; a resynchronized
stretch simply arrives with `run.completed`.

**Structured — no duplication, no lost tail.** `result.response` is now
streamed only for the part the deltas have not already delivered: the whole
thing when nothing streamed (**the final-response-only fallback is kept**),
the remainder when it continues what streamed, nothing when it merely repeats
it. A response that *diverges* from what streamed is left to `finalText`,
which is authoritative, rather than appended as a contradictory second copy.

**Renderer hand-off.** `run.completed` / `run.failed` / `run.cancelled` now
refresh the project **first** and retire the live run and its streamed text
only once the stored assistant message has arrived, so a finished reply is
never off screen for a frame.

### Live verification

Real Electron build, real signed-in `agy 1.1.27`, driven through the real UI
(prompt typed into the real composer, real Send button), sampling the real
transcript DOM:

```text
structured, 900-word essay          PTY (interactive), 1200-word essay
     3ms  "Antigravity is replying"      3ms  "Antigravity is replying"
 13029ms  177 chars                  19280ms  281 chars
 13232ms  429 chars                  19686ms  820 chars
 13635ms  988 chars                  20904ms  2183 chars
 15457ms  3127 chars                 22937ms  4497 chars
 15659ms  completed, 7928 chars      23547ms  completed, 10999 chars
```

A short interactive turn streams too (67 characters on screen ~400 ms before
completion). In every run the transcript row count never dropped at
completion — the streamed reply hands over to the persisted message without a
blank frame.

`test/main/antigravity-live.test.ts` carries two opt-in
(`ORBIT_REAL_AGY=1`) tests asserting the same property per transport: real
assistant text reaches Orbit as `text.delta` strictly before `run.completed`.
Both passed on three consecutive runs.

### Live-test flake rates measured on this branch

Live tests talk to a hosted model through a real CLI, so a handful of runs
behave differently. Measured across this branch's verification (macOS, agy
1.1.27):

| Test | Observed | Reading |
| --- | --- | --- |
| `streams a long PTY answer` | ~1 turn in 8 paints its whole answer in one repaint | agy's pacing; the test asks two turns and requires one to stream |
| `streams a long structured answer` | occasionally flushes a whole answer in one delta | same, same mitigation |
| `uses the installed signed-in agy runtime` | ~1 run in 8 fails a strict `toBe('ORBIT_AGENTDOCK_AGY_OK')` | pre-existing test asserting exact model output; left as is |
| `resumes a real native conversation` | was ~1 run in 8 settling with empty text | **root-caused and fixed** — it was the resume form of the premature-settle race (see State-machine hardening). 2/2 full live suites green since. |

None of these are deterministic-suite failures: `npm run verify` (369 tests)
is green, and every guarantee they probe is also asserted deterministically
against recorded frames and captured event shapes.

### Remaining limitations (agy's own behaviour, not Orbit's)

- **The structured transport exposes nothing during thinking.** agy emits no
  assistant prose *and no step of any kind* while the model reasons — 12–18 s
  on the captured turns, and the largest part of the perceived wait. Verified
  again against agy 1.1.28: an `agent_response` step covering a 2.6 s
  reasoning phase is only ever announced as `DONE`, after the fact, and there
  is no `ACTIVE` event to read while it is happening. There is therefore
  genuinely no "Thinking" state to show on this transport, and Orbit shows its
  restrained `Working…` rather than inventing one. **The PTY transport does
  have it** — agy draws `▸ Thought for 11s` on its own screen — which is why
  interactive turns can say so and structured ones cannot.
- **The structured transport dumps most of a long answer at the end.** The
  final `DONE` delta arrives in the same millisecond as `result` and carried
  62–73% of the answer in every captured turn. Orbit forwards it the instant
  it arrives; agy decides when that is.
- **A short answer cannot stream.** It arrives as one `DONE` delta (structured)
  or one screen repaint (PTY). There is nothing incremental to show, and
  Orbit does not invent any.
- **Occasionally a whole PTY answer arrives in one repaint.** agy paints the
  terminal at its own pace and sometimes lands an entire long answer between
  two samples, leaving nothing incremental to read; `run.completed` carries
  the complete text as always. Measured live at roughly one turn in eight,
  which is why the live streaming test asks two consecutive turns for
  progressive output and requires at least one to deliver it.
- **PTY mid-flight text is not always byte-identical to the settled answer.**
  agy draws raw markdown first and resolves emphasis afterwards, so a
  resynchronized stretch is skipped mid-stream and arrives with the final
  message. The persisted message is always the complete, settled text.
- The transient work-title agy prints above an answer ("Verifying Task
  Instructions", "Analyzing the Directive") is still included in the extracted
  response, as it was before this change — it is indistinguishable from an
  ordinary unindented heading on the screen. The *spinner-prefixed* form of
  the same title (`⣽  Verifying Requirements Thoroughly...`) is unambiguous
  and is now read as live activity instead (see "Live activity" below).

## Live activity (issue #1)

**Symptom:** the primary execution state was the fixed string `Antigravity is
replying` (or `Antigravity is working` once any step existed) for the whole of
every turn, including the long stretches where Antigravity was running
commands and reading files. It told the reader nothing, and it was wrong
whenever no text was being produced.

**Root causes — one per transport, plus one in the renderer:**

1. **Structured threw away everything except the tool's name.** `tool.activity`
   carried `label: step.tool_name` and nothing else. agy supplies
   `tool_info.parameters` alongside it — and Orbit was already reading that
   object, for artifact discovery — but the command and the path never
   reached the UI.
2. **PTY reported no activity at all.** `AntigravityPtySession` emitted no
   `tool.activity` events in any circumstance. agy draws its work on the
   screen the session already owns, and `extractResponseText` was parsing
   those rows out *as chrome and discarding them*.
3. **The renderer's primary indicator ignored the activity it did have.** The
   waiting bubble chose between two fixed strings; the real activity line was
   rendered only as a subordinate rail.
4. **A race dropped a turn's first steps.** The renderer seeded
   `activityByRun[run.id]` with an empty state *after* awaiting
   `messages.send`. The provider starts working the moment main dispatches
   the send, so any activity that arrived during that round trip was
   overwritten.

### Real captured `agy 1.1.28` tool steps

Verbatim, from a live `--output-format stream-json` run:

```text
run_command      { "CommandLine": "ls -a" }
view_file        { "AbsolutePath": "/ws/README.md" }
list_dir         { "DirectoryPath": "/ws" }
grep_search      { "Query": "hello", "SearchPath": "/ws" }
write_to_file    { "TargetFile": "/ws/notes.md" }
```

State is `ACTIVE` then `DONE` (or `ERROR`, carrying
`tool_info.error.message`), with agy's own `duration_seconds` on the
terminal event.

Note the casing: **1.1.28 uses PascalCase parameter names.** Orbit's existing
artifact discovery matched only `path` / `file_path` / `filename`, so every
file agy wrote went undiscovered — a real bug fixed in passing, since it is
the same lookup.

The interactive screen's equivalents, all real captured shapes:

```text
● Bash(npm run build) (ctrl+o to expand)
▸ Thought for 11s
⣽  Verifying Requirements Thoroughly...
```

### What changed

- `src/main/runtime/activityMapping.ts` classifies a real agy tool name into
  a small closed set of **observed** kinds and pulls the literal command,
  path or query out of its real parameters. Parameter lookup is
  case-insensitive and covers both spellings, so a version rename degrades to
  "no target" rather than to a wrong one.
- `ToolActivityEvent` now carries `kind`, `command`, `target` and
  `durationSeconds` alongside the existing `label` — **facts, not prose**.
  `label` remains agy's own word for the step and is never rewritten in the
  main process.
- `TerminalInteractionDetector.readScreenActivity` reads the same rows the
  response extractor strips, and `AntigravityPtySession` turns them into
  ordinary `tool.activity` events — off the frames the transport already
  samples, so no new process, no second reader, no extra sampling. It is
  guarded exactly as progressive text is: never during bootstrap (whose
  screen is agy's banner, including the signed-in account's email), never
  mid image-paste, never after a stop.
- `renderer/app/lib/activityCopy.ts` turns those facts into the line a person
  reads — the same separation `interactionCopy.ts` and `errorCopy.ts` already
  use. A shell command is passed through **verbatim**, in monospace, never
  replaced by a description of itself.
- The waiting bubble now shows that line. `Working…` is the only fallback,
  and it appears only when Antigravity has genuinely reported nothing.
- Elapsed time prefers agy's own `duration_seconds`; Orbit's own clock is
  used only for a step that is still running and therefore has no reported
  duration yet.

### Streaming, part two: the cost of recording it (issue #2, remainder)

The transports were already streaming correctly (see the evidence above).
What was not correct was what the runtime did with each delta.

`OrbitStore.addRunEvent` was called for **every** runtime event, including
every `text.delta`, and `OrbitDatabase.run` called `persist()` after every
statement. sql.js has no incremental writer: `persist()` calls `export()`,
which serializes the **whole** database, and then writes the whole file —
synchronously, on Electron's main thread. That is the same thread that reads
agy's stdout and forwards events to the renderer.

Measured on this branch, against an ordinary 6.8 MB Orbit database (40 prior
turns):

| | per delta | one 230-delta turn |
| --- | --- | --- |
| before | ~4.2 ms (max 9 ms) | **~970 ms of blocked event loop** |
| after | ~0.03 ms | **~8 ms** |

The cost also grew with the user's history, because the deltas were
themselves most of what made the database large — the same 40-turn history
now produces a 0.6 MB database rather than 6.8 MB.

Two changes, both at the layer the cost was actually incurred at:

- **`text.delta` is no longer written to `run_events`.** Nothing has ever
  read that table, and a run's text is reconstructible from the assistant
  message the turn ends with. Every other event type is still recorded.
- **`persist()` is coalesced** (120 ms), so a burst of writes costs one file
  rewrite rather than one per statement. `close()` and the new `flush()`
  write synchronously, so nothing that could read the file can observe a
  stale one. The runtime flushes at both turn boundaries — once the user's
  message and run exist, and once the turn settles — so coalescing costs
  throughput *during* a turn without costing durability *of* one. That is
  two synchronous writes per turn, against the several hundred there were
  before.

**A latent bug this exposed:** `listProjects`/`listProjectTree` and friends
ordered by `updated_at DESC` with no tiebreaker. Those timestamps are whole
milliseconds, and once writes stopped taking milliseconds each, two rows
could share one — SQLite then returns them in insertion order, the exact
opposite of "newest first". Every such query now carries an explicit
`rowid` tiebreaker, so the ordering holds on its own rather than because the
layer underneath is slow.

## Stop is not an error (issue #3)

**Symptom:** pressing Stop could show `Antigravity's response couldn't be
read… Your conversation is safe…`, and the partial answer was thrown away.

**Root causes:**

1. **The runtime discarded the partial answer and invented a message.**
   `run.cancelled` stored a literal `'Request cancelled.'` as the assistant's
   message, dropping the text that had actually streamed.
2. **Every failure path could outrun the cancellation.** In the structured
   provider, a stopped agy still reports its own death — a non-SUCCESS
   `result` written as SIGTERM lands, a pipe error, a non-zero exit. Only the
   `exit` handler checked `cancelled`; `handleLine` and the `error` handler
   did not, so those arrived as `provider.failed`.
3. **PTY swallowed a Stop whose process had already died.** `cancel()`
   returned silently when `transport.isRunning` was false, leaving
   `cancelRequested` unset — so `handleExit` reported the very exit the user
   had caused as `provider.exited`, "Antigravity's interactive session exited
   unexpectedly".
4. **Nothing stopped a late terminal event overwriting an earlier one.** A
   `run.failed` arriving after `run.cancelled` appended a second assistant
   message and flipped the run's state to `failed`.

**Fixes, each at the layer that makes it structural rather than remembered:**

- `AntigravityProvider.fail()` — the single funnel every failure path in that
  provider already went through — converts a failure into a cancellation when
  the run was stopped. Cancellation wins by construction, not by each caller
  checking.
- `AntigravityPtySession.cancel()` latches `cancelRequested` when the process
  is already gone, so the exit that follows reads as the stop it is. It also
  no longer acts at all unless a turn is genuinely in flight (`isBusy`),
  rather than writing Escape into an idle session.
- `OrbitRuntime.handleProviderEvent` drops a terminal event for a run that
  has already reached a terminal state. Deliberately about *terminality*, not
  cancellation specifically: a completed run cannot be failed either, and the
  rule holds for any provider.
- `run.cancelled` persists the text that actually streamed, marked
  `cancelled`. Nothing is invented; a turn stopped before it said anything
  stores an empty message.
- The renderer presents that status as `You stopped this response` beneath
  whatever was received — a transcript note, not an `ErrorNote`. Genuine
  failures keep their real code, their product copy and their diagnostics
  disclosure, untouched.

### Stop precedence

Accepting a Stop for a run that is still active decides the outcome. The run
is interrupted, and nothing the transport says afterwards changes that.

`'cancelling'` is not a waiting room — it **is** "Stop accepted", recorded
before the provider is even asked. `handleProviderEvent` then converts any
terminal event that lands while a run is in that state into the
interruption:

| ordering | outcome |
| --- | --- |
| SUCCESS finalized, then Stop pressed | **Completed** — `cancelRun` no-ops on an already-terminal run rather than dragging it into a stopping state it can never leave |
| Stop accepted while the run was active | **Interrupted** |
| Stop accepted, then a late SUCCESS | **Interrupted**, keeping the completion's own `finalText` |
| Stop accepted, then the exit/error the stop caused | **Interrupted**, keeping whatever had streamed |
| a genuine failure with no Stop | **Failure**, with its real code and diagnostics |

A converted completion keeps its `finalText` on exactly the terms the
ordinary completion path uses (`finalText || streamed`): the point is to
preserve everything Antigravity actually produced, not to punish the turn
for having been stopped.

This supersedes the earlier decision to let a post-Stop `SUCCESS` report a
completion. Both readings preserve the text; this one respects the user's
action, which is the behaviour the product wants.

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

**Known limitation (not an attachment bug), since fixed:** the *first* turn of
a brand-new PTY session occasionally settled with empty extracted prose —
observed once in three valid live runs. Root-caused while verifying issue #2
and fixed; see "A turn settling before it had started" under State-machine
hardening below. The attachment itself was still delivered in that run
(the sent thumbnail rendered, and the next turn in the same session answered
correctly). This is the same first-turn extraction flake already recorded for
the resume test above, not a regression in the attachment path.

## `node-pty`'s `spawn-helper` must be executable (fixed at install time)

**Confirmed against the registry artifact itself**, not inferred from a local
install:

```text
$ tar -tvf node-pty-1.1.0.tgz | grep spawn-helper
-rw-r--r--  …  package/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--  …  package/prebuilds/darwin-x64/spawn-helper
```

The published npm tarball records both macOS helper binaries as mode `0644`,
so this is not a umask, cache or extraction artifact — **every** clean
`npm install` lands a non-executable helper. node-pty passes that path
straight to `posix_spawnp`, which fails with the entirely unhelpful
`Error: posix_spawnp failed.`, and Orbit's interactive (PTY) transport is
dead on arrival. Reproduced and re-proved end to end: `chmod 644` → spawn
fails; run the fix → spawn succeeds.

Fixed deterministically in this repo by `scripts/ensureNodePtyPermissions.mjs`,
run from the root package's `postinstall`, so a plain `npm install` or
`npm ci` is all anyone needs:

- node-pty's location is resolved with `require.resolve('node-pty/package.json')`
  — never a hardcoded `node_modules/node-pty`, so hoisting and workspaces are
  fine.
- It adds `0o111` (preserving the rest of the mode) to the `spawn-helper` in
  **every** layout the package ships: `build/Release`, `build/Debug`, and each
  directory under `prebuilds/`, read from disk rather than hardcoded — so no
  node-pty version, and no CPU architecture, is baked in.
- Fixing every prebuild rather than only the current one is deliberate: the
  Node that runs the install and the Electron that later loads node-pty need
  not share an architecture (an x64 Node under Rosetta installing for an
  arm64 Electron, or an `--arch` cross-install), so keying the fix on
  `process.arch` alone would leave the binary that actually gets used broken.
  Apple Silicon and Intel are both covered by the same run.
- It then **verifies**: it finds the directory node-pty will really load
  `pty.node` from — using the same search order as node-pty's own
  `loadNativeModule` (`build/Release`, `build/Debug`,
  `prebuilds/<platform>-<arch>`) — and insists that `pty.node` is really
  there, failing the install with a specific message if it is not. On macOS it
  additionally requires the helper beside it to exist and be executable. A
  broken install is reported, never silently passed over.
- **`spawn-helper` is macOS-only.** node-pty's `binding.gyp` guards that
  target with `OS=="mac"`, and only the darwin prebuilds ship one; every other
  Unix forks the PTY directly and legitimately has `pty.node` and no helper
  beside it. Requiring one everywhere failed an otherwise healthy Linux
  install outright — `postinstall` throws, and takes `npm install` down with
  it. The helper is still chmod'ed wherever it exists, so a cross-install
  carrying darwin prebuilds is fixed no matter which platform ran it.
- Windows is skipped outright (no `spawn-helper`, no executable bit).

Unit-tested in `test/scripts/ensureNodePtyPermissions.test.ts` against
throwaway node-pty-shaped layouts (both macOS prebuilds at `0644`, source
build, mixed layout precedence, Windows skip, a non-darwin platform that never
builds a helper, a non-darwin install that still fixes darwin prebuilds,
missing helper, missing native module, idempotency, mode preservation), plus
assertions against the real installed package — including that the script
itself runs clean on whatever platform the suite is running on.

## Permission prompts depend on agy's own allow-list

The live PTY test's approve/deny half is conditional, and this is why.

agy keeps a user-level standing allow-list in
`~/.gemini/antigravity-cli/settings.json`. On the machine this branch was
verified on it contains:

```json
"permissions": { "allow": ["command(*)", "write_file(*)", "read_file(*)", …] }
```

`command(*)` grants every shell command up front, so agy never asks.
Confirmed by capturing the raw terminal for three separate commands —
`touch` inside the workspace, `rm -rf` on a path *outside* it, and a network
`curl` — all three ran with **no** permission prompt, no trust dialog, and
zero occurrences of `Requesting permission` / `Do you want to proceed` /
`do you trust` anywhere in the captured screens.

So there is nothing on screen for Orbit to detect, and the earlier failure of
that test was neither an agy version change nor an Orbit regression — it was
a stale assumption about the machine's permission posture. The test now
asserts everything about a prompt **when one appears**, and when none does it
requires the allow-list to explain the absence and logs which half it could
not exercise. Nothing was weakened to make it pass: a prompt that appeared
and was *missed* still cannot slip through, because the turn would stall
waiting on a response that never comes and the test would time out. Orbit
still never passes `--dangerously-skip-permissions` and never auto-approves
anything; detection of the two real captured menu shapes remains covered
deterministically in `test/main/terminalInteractionDetector.test.ts`.

## Electron's own installer on Node 24 (environment note)

Unrelated to Orbit, but worth knowing before deleting `node_modules` on this
machine: `electron@33`'s `install.js` can exit `0` having extracted only a
220 KB skeleton of `dist/`, leaving no `path.txt`, after which anything that
`require('electron')` fails with "Electron failed to install correctly". The
cached zip itself is intact (`unzip -t` passes, 255 files, 258 MB), and
`extract-zip@2.0.1` simply ends without settling its promise. Recovery is to
restore or re-extract `node_modules/electron/dist` and write `path.txt`.

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

## Retiring a PTY process (single ownership)

Two `agy` processes must never hold the same native conversation at once: the
replacement resumes it, and a still-live predecessor makes that resume replay
into a screen the extractor then reads as the answer.

`AntigravityPtyTransport.kill()` therefore only *requests* termination. It
deliberately does **not** flip `isRunning` — an earlier version did, which
meant a wait-for-exit returned immediately and a replacement could be spawned
while its predecessor was still alive. Only the real `onExit` callback clears
it, and `whenExited()` is how callers wait for that. `kill(signal)` takes an
optional signal so a polite request can be escalated.

Retirement (`AntigravityPtySession.retireThenSpawn`) is therefore:

```text
kill()  →  wait up to 4 s for the real exit
        →  still alive? kill('SIGKILL')  →  wait up to 2 s
        →  still alive? DO NOT SPAWN — fail the turn (provider.retire_failed)
```

A failed turn is recoverable; two agy processes writing into one conversation
is not.

### The ownership rule

One rule governs every path in `AntigravityPtySession`:

> A conversation has exactly one owner at a time. An owner is an **active**
> process (`transport`) **or** one being retired (`retirement.transport`) —
> whether that retirement is in flight or has given up. Ownership is released
> by exactly one event: the owner's confirmed exit. A new process may spawn
> only when there is no owner **and** the session is still valid for sends.

Retirement is therefore a first-class state, not a gap between states. A
`Retirement` record (`{ transport, done, blocked }`) is installed
*synchronously* in the same tick the transport is detached, so there is no
window in which a conversation appears ownerless. A model-change retirement
additionally puts the session in state `'retiring'` — which counts as busy —
because a replacement is already promised to the run that triggered it.

What a `send()` meets, and what it gets:

| Session state | Result |
| --- | --- |
| Released (conversation deleted) | rejected, `provider.session_released` |
| Busy — including `'retiring'` | rejected, `provider.session_busy`; **nothing is spawned or scheduled** |
| Retirement in flight (no run attached, e.g. after `shutdown()`) | claims the session and waits on `retirement.done` |
| Retirement `blocked` | rejected, retryable `provider.retire_failed` |
| No owner | spawns normally |

A send that waited then only spawns if the retirement resolved **true** *and*
the session is still valid; a retirement that resolved false fails it with
`provider.retire_failed`, and a session released meanwhile fails it with
`provider.session_released`. It can never spawn onto a discarded session.

**Refusing once is not enough.** A predecessor that survives everything keeps
its `Retirement` record rather than being forgotten — `this.transport` has
already been cleared by then, so without it the very next `send()` would see no
transport and no retirement and quietly become the second owner it had just
refused to be. Ownership is released by exactly one thing: its genuine exit,
observed through `whenExited()`. A later retry then spawns normally, still
resuming by `--conversation`.

`shutdown()` goes through the same `forceRetire`, so it records a survivor the
same way. And `releaseConversation` no longer drops a session that still owns a
live process — dropping it would put a fresh session, with no knowledge of that
process, in charge of the same native conversation. It keeps the session (inert:
a released session refuses every send) and drops it once
`whenOwnershipReleased()` confirms the process is gone.

Verified live by sampling the process table across a real model change — the
count for the workspace never exceeded 1, and the surviving process was
observably running the new `--model`/`--effort` with `--conversation <id>`.

Regression coverage (`test/main/modelInvocation.test.ts`) drives each window
deterministically, always issuing the second send **before** the retirement
resolves: a send during an in-flight model-change retirement (refused, nothing
spawned or scheduled, and the promised replacement still happens exactly once
after the real exit); a send queued behind a retirement that then becomes
unkillable (fails with `provider.retire_failed`, never spawns, and a retry works
after the genuine exit); a send arriving once a release is under way; and a send
already queued when the conversation is released (refused with
`provider.session_released` rather than spawning an orphan). Plus the blocked
sequence end to end: polite timeout, SIGKILL timeout, `provider.retire_failed`,
another send with no second process, then exit and a safe retry.

### Cancelling a run that does not have a process yet

Ownership answers "may this run spawn?". It does not, by itself, answer "has
the user stopped this run?" — and there is one window where those come apart.

Ordinary cancellation is agy's own native one: `cancel()` writes Escape into
the live process, `cancelRequested` is latched, and the turn settles as
`run.cancelled` on the next ready footer. That path needs a `transport`.

A run waiting on a retirement has none. Two states qualify, and in both the run
has been *promised* a process that does not exist yet:

| State | Why the run has no transport | Boundary that would spawn it |
| --- | --- | --- |
| `'retiring'` | its own model change detached the predecessor | `retireThenSpawn` |
| `'bootstrapping'`, `transport === null` | it arrived while a retirement was already in flight and queued behind it | `spawnAfterRetirement` |

`cancel()` used to fall straight through both (`!this.transport?.isRunning`)
and return silently: no `run.cancelled`, while `OrbitRuntime` had already moved
the run to `cancelling`. Stop looked like it worked, and when the predecessor
finally exited the replacement spawned and delivered the prompt the user had
stopped.

**Stop now voids the spawn the run is owed.** The run id is recorded in
`cancelledDeferredRuns`, and every asynchronous boundary that could still spawn
a process or deliver a prompt consumes that record before doing anything else.
So a cancelled run cannot cross one — and because the record is keyed by *run*
rather than by session state, a stale boundary belonging to a cancelled run can
neither spawn for itself nor disturb whichever run has since taken the session
over.

`run.cancelled` is emitted immediately, from `cancel()` itself. Not on the
predecessor's exit: the run has nothing left to do, and a predecessor that
survives every escalation would otherwise leave the Stop unanswered forever.
That also makes the event exactly-once by construction — the boundary consumes
the record and emits nothing, so there is only ever one emitter.

What is deliberately *not* done:

- The predecessor is **not** revived or reused. Its retirement continues
  normally, and it stays this conversation's owner until it genuinely exits.
- The cancelled run is **not** converted into a `provider.retire_failed` run if
  that retirement then becomes blocked. The cancellation check precedes the
  retirement outcome for exactly that reason: the user stopped it, so it stays
  stopped, and it never resurrects when the blocked process eventually exits.
- The session returns to `'idle'`, not `'ready'` — the promised replacement is
  void, so nothing is busy on this run's behalf, while the `Retirement` record
  still holds ownership. A later send therefore waits on it (or is refused
  while it is `blocked`) rather than spawning alongside a live predecessor, and
  spawns normally once the real exit releases ownership.

`OrbitRuntime.cancelRun` reads the run back from the store after the provider
call instead of returning the `'cancelling'` snapshot it wrote on the way in,
because this path settles the run synchronously.

Regression coverage: `test/main/modelInvocation.test.ts` drives the full
sequence — model change, retirement held in flight, one transport, Stop, then
the genuine exit — asserting exactly one `run.cancelled`, no replacement, the
prompt never delivered, no later `run.completed`, and a new run afterwards that
spawns and completes normally. A second test does the same with the retirement
becoming blocked (polite timeout, SIGKILL timeout, survivor retained), proving
the cancelled run stays cancelled rather than failing, does not resurrect on
the eventual exit, and that recovery afterwards is normal. Ordinary live-turn
cancellation is pinned by its own test (Escape sent, no kill, run settles on
the next ready footer, same process serves the next turn);
`test/main/antigravityPtySession.test.ts` covers the queued-behind-a-retirement
variant, and `test/main/runtime.test.ts` covers the runtime settling a
synchronously-cancelled run instead of leaving it in `cancelling`.

**Live-verified** against a real agy process (`AntigravityProvider live model
change > stops a run that is waiting on a real model-change retirement`, opt-in
via `ORBIT_REAL_AGY=1`): the predecessor is genuinely being terminated by the
OS when Stop arrives, nothing about the timing is simulated, and the test
samples the real process table throughout — **exactly one** agy process owns
the conversation across the whole retirement-and-cancellation window. The
cancelled prompt produces no `text.delta` at all, and the conversation still
recalls its context on the next turn. It fails against the previous code with
zero `run.cancelled` events.

Regression coverage: `test/main/antigravityPtyTransportLifecycle.test.ts`
drives a *real* PTY (a trivial `sh` that ignores `TERM`/`HUP`/`INT`) and
asserts `isRunning` stays true after `kill()`, that `whenExited()` does not
resolve on request alone, and that SIGKILL actually ends it. The fake
transports in every other suite now model the same distinction — the previous
fakes flipped `isRunning` synchronously in `kill()`, which is exactly what hid
the bug.

## Changing model on a live PTY conversation

A live `agy` process is bound to the flags it was launched with, so changing
model or effort means retiring it and resuming with `--conversation`. That is
only safe when there *is* something to resume with — and agy records no
conversation id for a workspace until its **second** prompt.

So a conversation that has had exactly one turn has no id, and the live
process is the only thing carrying its context. Retiring it there would
silently start the conversation over under the new model, losing everything
said so far. Orbit refuses:

| State when the model changes | What happens |
| --- | --- |
| No native conversation id yet | The change is **deferred**. The turn runs on the process the session already has, and a `run.notice` (`model.deferred`) tells the user in plain words that the new model applies from the next message. `spawnedInvocation` is left alone, so the mismatch is re-evaluated next turn. |
| A native id exists | The process is retired (above) and the replacement resumes the same conversation with the new flags. |
| No live process at all | A fresh spawn with the new flags, resuming by id when one is known. Nothing is lost that could have been kept. |

Because settling a turn is what lets Orbit read agy's history file, the
deferral resolves itself: the deferred turn *is* the second prompt, so the
next turn applies the change for real. Worst case, a model change takes effect
one message later — stated honestly, rather than pretended.

**Live-verified end to end** (`AntigravityProvider live model change`, and
again through the real Electron app): a secret established on turn 1 under
`claude-sonnet-4-6` was still recalled on turn 2 after switching to
`gemini-3.8-flash --effort low` (deferred, notice shown), and again on turn 3
after the change was really applied — with the live process observably running
`--model gemini-3.8-flash --effort low --conversation <id>`.

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

- **A turn settling before it had started** (found while verifying issue #2, pre-existing): agy can leave its `? for shortcuts` ready footer on screen for longer than the transport's 450 ms idle debounce after a prompt is submitted, and `write()` deliberately clears the ready edge so the next footer counts as a fresh transition. Together those let the *pre-prompt* screen be read as "this turn is finished": the run settled roughly half a second after being sent, with empty text, and the real answer was discarded when it arrived. This is the "first turn occasionally settles with empty extracted prose" flake recorded earlier in this document, now diagnosed. **Captured evidence**: two consecutive idle snapshots, byte-identical, both just the bare compose box and the ready footer, with no echo of the prompt anywhere. A second, subtler form was captured too — agy echoes a prompt into its compose box as it is *typed*, so the text is on screen before anything is submitted, and a screen caught mid-typing settled a run the same way. Fixed by requiring, before a running turn may settle, that the screen shows the prompt echoed **and** the compose box emptied (`promptHasBeenSubmitted`), latched once seen so a long answer that scrolls its own echo away still settles. Bounded by a 10 s grace so the guard can never strand a turn. A **third** shape was captured later, on a `--conversation` resume: agy replays the previous conversation, echoes the newly submitted prompt, and is *still* showing the ready footer from that replayed history — so "the prompt was submitted" was itself not enough, and the turn settled instantly with an empty answer while the replayed screen even carried the *previous* turn's reply. A turn may now settle only once it has also been seen working (the busy footer) **or** has a reply on screen to settle with. Requiring the busy footer alone would not do: an answer that streams continuously never produces an idle snapshot while it is being written, so the first one arrives at the end with the whole reply already on it. Measured live afterwards at 3/3 model-change runs and 2/2 full live suites, against roughly 1 in 2 for the resume case before.
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

**Verified** (live, against the installed signed-in `agy 1.1.27`, Linux/Wayland unless noted):
- **Progressive streaming, both transports, on macOS** (issue #2, this session): raw `stream-json` traces of four real turns; 200 ms screen samples of real PTY turns; opt-in provider-level live tests; and the real Electron build driven through its own UI. See "Streaming assistant text" above for the captured numbers.
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
- Whether agy ever exposes assistant prose during its thinking phase (nothing was observed on any captured turn, on either transport).
- Behavior of permission menus beyond the two captured shapes above (e.g. a plan-mode-specific prompt, or a menu with more than 4 options).
- Structured → PTY continuation safety.
- `node-pty`/ConPTY behavior, shell/executable invocation, and PTY resize on macOS or Windows — reviewed for obvious platform-specific bugs (none found: paths are resolved via `node:path` and `os.homedir()`, no POSIX-only assumptions in the PTY spawn/write/resize/kill calls) but **not live-verified** on either platform.

## Diagnostics (`ORBIT_PTY_DEBUG`)

Set to any truthy value to log one line per idle screen snapshot (session startup, transport-selection-adjacent state, interaction detection, image-attach confirmation progress, crash, and resume attempts are all observable from the resulting sequence of snapshots and the session's own `console.warn` calls). Reviewed for safety: it logs only the visible terminal *text* (already stripped of control bytes by the VT parser) — never clipboard contents, image bytes, or raw environment variables. It is not gated to development builds; a user enabling it in production would see plain conversation text in their own logs (the same text already visible in the Orbit UI), never anything Orbit doesn't already show them.
