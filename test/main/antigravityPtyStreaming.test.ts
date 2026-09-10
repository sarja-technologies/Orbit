import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AntigravityPtySession } from '../../src/main/runtime/providers/antigravity/AntigravityPtySession'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport, PtyInteraction } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import { progressiveAppendIndex } from '../../src/main/terminal/TerminalInteractionDetector'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

// Every frame below is modelled line-for-line on real `agy 1.1.27` screens
// captured while investigating issue #2 (raw capture and analysis in
// docs/antigravity-transports.md): agy's banner, the short rule under it,
// the echoed prompt, a `▸ Thought for Ns` line, a transient work-title, the
// 2-space-indented answer, a Braille spinner progress line, and the compose
// box (wide rule / `>` / wide rule / footer). The prose is shortened; the
// structure, and every transition exercised here, is what agy really does.
const WIDE = '─'.repeat(120)
const PROMPT = 'Write a short essay about the history of the bicycle.'

const BANNER = ['', '                  Antigravity CLI 1.1.27', '                  someone@example.com', '                  Gemini 3.6 Flash (Medium)', '                  /tmp/workspace', '              ', '', '─'.repeat(60)]
const COMPOSE = [WIDE, '>', WIDE, 'esc to cancel                                                       Gemini 3.6 Flash · medium']
const SETTLED_COMPOSE = [WIDE, '>', WIDE, '? for shortcuts                                                     Gemini 3.6 Flash · medium']

/** A frame in which the blank line agy normally leaves under the echo is
 *  still present. */
const frame = (body: string[], compose = COMPOSE): string[] => [...BANNER, `> ${PROMPT}`, '', '▸ Thought for 11s', ...body, ...compose]

/** The same screen one row after the terminal has scrolled: agy's blank
 *  separator under the echo is gone. Confirmed live — and it is exactly
 *  what used to make the old blank-line anchor swallow the first lines of
 *  the answer mid-stream. */
const scrolledFrame = (body: string[], compose = COMPOSE): string[] => [...BANNER.slice(1), `> ${PROMPT}`, '▸ Thought for 11s', ...body, ...compose]

const P1 = '  The bicycle stands as one of the most efficient machines ever built.'
const P2 = '  It began in 1817 with Baron Karl von Drais and his Laufmaschine.'
const P3 = '  The safety bicycle of 1885 set the shape every modern bicycle still keeps.'

class FakeTransport implements IAntigravityPtyTransport {
  isRunning = true
  mediaAttachedCount = 0
  handlers: AntigravityPtyHandlers | null = null
  sentPrompts: string[] = []
  cancelCalls = 0
  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
  }
  /** Real agy goes busy once a prompt is submitted, and a fake that never
   *  does lets a test settle a turn the session has no evidence ever ran.
   *  Switched off to model the captured resume case, where the busy footer
   *  is never observed because no idle snapshot lands while agy works. */
  autoBusyOnPrompt = true
  sendPrompt(prompt: string): void {
    this.sentPrompts.push(prompt)
    if (this.autoBusyOnPrompt) this.handlers?.onBusy()
  }
  respond(_pending: PtyInteraction, _optionId: string): boolean {
    return true
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {
    this.cancelCalls++
  }
  /** Mirrors the real transport: `kill()` only *requests* termination, and
   *  `isRunning` stays true until `exit()` is called to simulate the OS
   *  process actually going away. Tests that flip `isRunning` synchronously
   *  here cannot see the retirement race this models. */
  killCalls = 0
  killSignals: (string | undefined)[] = []
  private markExited: () => void = () => undefined
  private exited: Promise<void> = new Promise<void>((resolve) => {
    this.markExited = resolve
  })
  kill(signal?: string): void {
    this.killCalls++
    this.killSignals.push(signal)
  }
  whenExited(): Promise<void> {
    return this.exited
  }
  /** Simulates the OS process finally exiting. */
  exit(code = 0): void {
    this.isRunning = false
    this.markExited()
    this.handlers?.onExit(code)
  }
  resize(): void {}
  /** What AntigravityPtyTransport does on its throttled, drained sample. */
  stream(lines: string[]): void {
    this.handlers?.onStreamText?.(lines)
  }
  /** What it does on an idle classification snapshot. */
  snapshot(lines: string[]): void {
    this.handlers?.onScreenText?.(lines)
  }
}

function input(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    prompt: PROMPT,
    nativeConversationId: null,
    workspacePath: '/tmp/workspace',
    saveDir: '/tmp/workspace',
    attachments: [],
    referencedArtifacts: [],
    transport: 'pty',
    model: null,
    reasoningEffort: null,
    ...overrides
  }
}

function harness() {
  const transports: FakeTransport[] = []
  const session = new AntigravityPtySession(
    {
      executable: 'agy',
      createTransport: () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      },
      findConversationId: () => null
    },
    'conversation_1'
  )
  const events: RuntimeEvent[] = []
  const start = (overrides: Partial<ProviderSendInput> = {}, options: { autoBusy?: boolean } = {}): FakeTransport => {
    session.send(input(overrides), (event) => events.push(event))
    const transport = transports.at(-1)!
    if (options.autoBusy === false) transport.autoBusyOnPrompt = false
    transport.handlers!.onReadyForInput() // bootstrap complete -> the prompt is written
    return transport
  }
  return { session, transports, events, start }
}

const deltas = (events: RuntimeEvent[]): string[] =>
  events.filter((event): event is Extract<RuntimeEvent, { type: 'text.delta' }> => event.type === 'text.delta').map((event) => event.delta)

const activities = (events: RuntimeEvent[]): Array<Extract<RuntimeEvent, { type: 'tool.activity' }>> =>
  events.filter((event): event is Extract<RuntimeEvent, { type: 'tool.activity' }> => event.type === 'tool.activity')

describe('AntigravityPtySession progressive response streaming', () => {
  it('emits the answer as text.delta while agy is still drawing it, in order and without repetition', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '⣽  Working...']))
    transport.stream(frame([P1, P2, '⣷  Working...']))
    transport.stream(frame([P1, P2, P3, '⣟  Working...']))

    expect(deltas(events).join('')).toBe([P1, P2, P3].join('\n').trim())
    expect(deltas(events).length).toBe(3)
    // Streaming happened strictly before completion — the whole point.
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
  })

  it('never streams the spinner progress line agy rewrites on every frame', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '⣽  Verifying Requirements Thoroughly...']))
    transport.stream(frame([P1, P2, '⢿  Working...']))

    for (const delta of deltas(events)) {
      expect(delta).not.toMatch(/[⠀-⣿]/)
      expect(delta).not.toContain('Working...')
    }
  })

  it('keeps streaming across the scroll that removes agy’s blank line under the echo', () => {
    // Real captured regression: the old blank-line anchor read the frame
    // before the scroll and the frame after it as two unrelated answers, so
    // the stream stalled for the rest of the turn.
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '⣽  Working...']))
    transport.stream(scrolledFrame([P1, P2, '⣷  Working...']))

    expect(deltas(events).join('')).toBe([P1, P2].join('\n').trim())
  })

  it('skips a frame caught mid-redraw and resumes cleanly on the next one', () => {
    // Real captured shape: a sampled frame in which a line agy is
    // rewriting is briefly missing, then present again.
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, P2, '⣽  Working...']))
    transport.stream(frame([P1, '  While the Draisienne lacked pedals, it introduced two-wheeled balance.', '⣷  Working...']))
    transport.stream(frame([P1, P2, P3, '⣟  Working...']))

    expect(deltas(events).join('')).toBe([P1, P2, P3].join('\n').trim())
    expect(deltas(events).join('')).not.toContain('Draisienne')
  })

  it('resumes streaming after agy rewrites text it had already drawn', () => {
    // Real captured cause: agy draws raw markdown first (`**Rover Safety
    // Bicycle**`) and resolves the emphasis a beat later, so the tail that
    // was streamed stops appearing on screen. One or two odd frames are
    // skipped; a sustained mismatch must not freeze the rest of the turn.
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '  The **Rover Safety **', '⣽  Working...']))
    const afterFirst = deltas(events).join('')
    expect(afterFirst).toContain('Rover Safety')

    for (const extra of ['Bicycle of 1885 set the shape.', 'Bicycle of 1885 set the shape. Wire', 'Bicycle of 1885 set the shape. Wire spokes', 'Bicycle of 1885 set the shape. Wire spokes followed.']) {
      transport.stream(frame([P1, `  The Rover Safety ${extra}`, '⣷  Working...']))
    }

    // Streaming resumed rather than stalling for the rest of the turn: the
    // rewritten stretch is skipped (run.completed still carries it) and new
    // text keeps arriving.
    expect(deltas(events).length).toBeGreaterThan(1)
    expect(deltas(events).at(-1)).toContain('followed.')
    // Nothing was ever shown twice.
    expect(deltas(events).join('').match(/Rover Safety/g)?.length).toBe(1)
  })

  it('does not stream the previous turn’s answer while its screen is still showing', () => {
    const { events, session, start } = harness()
    const transport = start()
    transport.stream(frame([P1, '⣽  Working...']))
    transport.snapshot(frame([P1, P2], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput() // turn 1 settles

    const before = events.length
    session.send(input({ runId: 'run_2', prompt: 'And what about the tricycle?' }), (event) => events.push(event))
    // agy has not redrawn yet: the screen still shows turn 1's echo and answer.
    transport.stream(frame([P1, P2], SETTLED_COMPOSE))

    const turn2Deltas = events.slice(before).filter((event) => event.type === 'text.delta')
    expect(turn2Deltas).toEqual([])
  })

  it('completes with the whole answer, and the streamed text is a prefix of it', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '⣽  Working...']))
    transport.stream(frame([P1, P2, '⣷  Working...']))
    transport.snapshot(frame([P1, P2, P3], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput()

    const completed = events.find((event) => event.type === 'run.completed') as { finalText: string } | undefined
    const finalText = [P1, P2, P3].join('\n').trim()
    expect(completed?.finalText).toBe(finalText)
    expect(finalText.startsWith(deltas(events).join(''))).toBe(true)
  })

  it('stops streaming once the turn is cancelled and reports run.cancelled', () => {
    const { events, session, start } = harness()
    const transport = start()

    transport.stream(frame([P1, '⣽  Working...']))
    session.cancel()
    transport.stream(frame([P1, P2, P3, '⣷  Working...']))
    transport.handlers!.onReadyForInput()

    expect(deltas(events).join('')).toBe(P1.trim())
    expect(events.at(-1)).toMatchObject({ type: 'run.cancelled' })
    expect(transport.cancelCalls).toBe(1)
  })

  it('streams nothing while a native interaction is waiting for the user', () => {
    const { events, start } = harness()
    const transport = start()

    transport.handlers!.onInteraction({ signature: 'sig', kind: 'permission', prompt: 'Do you want to proceed?', options: [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }] })
    transport.stream(frame([P1, '⣽  Working...']))

    expect(deltas(events)).toEqual([])
    expect(events.some((event) => event.type === 'interaction.required')).toBe(true)
  })

  it('does not settle a turn on the pre-prompt screen that is still showing when it is sent', () => {
    // Captured live (agy 1.1.27): agy can leave its ready footer up for
    // longer than the transport's idle debounce after a prompt is submitted,
    // so the very next snapshot is the byte-identical *pre-prompt* screen —
    // no echo, no answer. Reading that as completion settled the run about
    // half a second after sending, with empty text, and the real answer was
    // discarded when it finally arrived.
    const { events, start } = harness()
    const transport = start()
    const prePrompt = [...BANNER, ...SETTLED_COMPOSE]

    transport.snapshot(prePrompt)
    transport.handlers!.onReadyForInput()

    expect(events.some((event) => event.type === 'run.completed'), 'the turn had not started yet').toBe(false)

    // The same is true one beat later, while agy is still echoing the prompt
    // into its compose box: the text is on screen, but nothing has been
    // submitted, and the ready footer is still the previous state's. This is
    // the screen a real run was captured settling on, with an empty answer.
    transport.snapshot([...BANNER, WIDE, `> ${PROMPT.slice(0, 30)}`, WIDE, '? for shortcuts                    Gemini 3.6 Flash · medium'])
    transport.handlers!.onReadyForInput()

    expect(events.some((event) => event.type === 'run.completed'), 'the prompt was still in the compose box').toBe(false)

    // Once agy really takes the turn on, the ordinary flow settles it.
    transport.stream(frame([P1, '⣽  Working...']))
    transport.snapshot(frame([P1, P2], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput()

    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({ finalText: [P1, P2].join('\n').trim() })
  })

  it('does not settle on the echo alone when a resumed process is still idle', () => {
    // Captured live on a `--conversation` resume: agy replays the previous
    // conversation, echoes the newly submitted prompt, and is *still*
    // showing the ready footer from that replayed history. Treating "the
    // prompt was submitted" as sufficient settled the turn instantly with an
    // empty answer and discarded the real reply when it arrived.
    const { events, start } = harness()
    const transport = start({}, { autoBusy: false })

    // Echo present, compose box emptied, ready footer — but no reply yet and
    // agy has not been seen working.
    transport.snapshot(frame([], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput()
    expect(events.some((event) => event.type === 'run.completed'), 'nothing has been answered yet').toBe(false)

    // The reply arrives; now the ready footer really does mean finished.
    transport.snapshot(frame([P1, P2], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput()
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({ finalText: [P1, P2].join('\n').trim() })
  })

  it('does not settle on the previous turn\u2019s replayed answer after a resume', () => {
    // The same replay carries the *old* answer on screen. Anchoring on this
    // turn's own prompt is what stops that being reported as this turn's
    // reply — which would look like a pass while silently answering from
    // stale history.
    const { events, start } = harness()
    const transport = start({}, { autoBusy: false })
    const previousAnswer = '  The secret word is BANANA-COMET-7.'
    transport.snapshot([...BANNER, '> An older question', '', previousAnswer, ...SETTLED_COMPOSE])
    transport.handlers!.onReadyForInput()

    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
    expect(deltas(events)).toEqual([])
  })

  it('never strands a turn: a refused ready footer still settles once the grace period passes', async () => {
    // The guard above must not be able to hold a run open forever. If agy
    // somehow never shows the prompt as submitted, the held-back footer is
    // honoured after a bounded wait rather than hanging.
    vi.useFakeTimers()
    try {
      const { events, start } = harness()
      const transport = start()
      transport.snapshot([...BANNER, ...SETTLED_COMPOSE])
      transport.handlers!.onReadyForInput()
      expect(events.some((event) => event.type === 'run.completed')).toBe(false)

      await vi.advanceTimersByTimeAsync(11_000)
      expect(events.some((event) => event.type === 'run.completed')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still settles a long answer whose own prompt echo has scrolled away', () => {
    // The guard latches the moment the echo is seen, so an answer long
    // enough to push its own echo out of the scrollback cannot hang.
    const { events, start } = harness()
    const transport = start()

    transport.snapshot(frame([P1]))
    transport.stream(frame([P1, '⣽  Working...']))
    // Echo gone; only the answer and the settled compose box remain.
    transport.snapshot([P1, P2, P3, ...SETTLED_COMPOSE])
    transport.handlers!.onReadyForInput()

    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
  })

  it('streams nothing before the prompt has actually been written into the session', () => {
    // A bare, freshly spawned process shows agy's banner — which contains
    // the signed-in account's email and the workspace path. It must never
    // reach the transcript as assistant text.
    const { transports, session, events } = harness()
    session.send(input(), (event) => events.push(event))
    transports.at(-1)!.stream([...BANNER, ...SETTLED_COMPOSE])
    expect(deltas(events)).toEqual([])
  })
})

// The interactive transport has no structured step channel: agy's own
// screen is the only account of what it is doing there. Every line replayed
// below is a real captured shape (see the frame fixture and
// docs/antigravity-transports.md).
describe('AntigravityPtySession live activity from the interactive screen', () => {
  it('reports the exact command agy shows itself running', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame(['● Bash(npm run build) (ctrl+o to expand)', P1]))

    const running = activities(events).filter((event) => event.status === 'running')
    expect(running.at(-1)).toMatchObject({ kind: 'running', command: 'npm run build', status: 'running' })
    // The keyboard affordance agy appends is chrome, not part of the command.
    expect(running.at(-1)!.command).toBe('npm run build')
  })

  it('reports agy\'s own word for what it is doing, not a generic one', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame(['⣽  Verifying Requirements Thoroughly...', P1]))

    expect(activities(events).at(-1)).toMatchObject({ kind: 'working', label: 'Verifying Requirements Thoroughly', status: 'running' })
  })

  it('does not treat a rotating spinner glyph as new work', () => {
    const { events, start } = harness()
    const transport = start()

    // The same status, redrawn with the next Braille frame — real captured
    // behaviour, eight times a second.
    transport.stream(frame(['⣽  Working...', P1]))
    transport.stream(frame(['⢿  Working...', P1]))
    transport.stream(frame(['⣻  Working...', P1]))

    expect(activities(events).filter((event) => event.label === 'Working')).toHaveLength(1)
  })

  it('reports the thinking agy says it did, with the duration agy measured', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame([P1]))

    // `▸ Thought for 11s` describes work that is already over.
    expect(activities(events).find((event) => event.kind === 'thinking')).toMatchObject({
      status: 'completed',
      durationSeconds: 11
    })
  })

  it('completes a step once agy has taken it off screen', () => {
    const { events, start } = harness()
    const transport = start()

    transport.stream(frame(['● Bash(npm run build) (ctrl+o to expand)', P1]))
    transport.stream(frame([P1, P2]))

    const command = activities(events).filter((event) => event.command === 'npm run build')
    expect(command.map((event) => event.status)).toEqual(['running', 'completed'])
  })

  it('never reports agy\'s startup banner or a clipboard receipt as activity', () => {
    const { session, events, transports } = harness()
    session.send(input(), (event) => events.push(event))
    const transport = transports.at(-1)!

    // Still bootstrapping: this screen is agy's banner, which carries the
    // signed-in account's email.
    transport.stream(BANNER)
    expect(activities(events)).toHaveLength(0)

    transport.handlers!.onReadyForInput()
    transport.stream(frame(['▸ 📎 1 media attached (clipboard, 141 B, image/png)', P1]))
    // The paste confirmation shares the marker but is a transport receipt.
    expect(activities(events).some((event) => event.label.includes('media'))).toBe(false)
  })

  it('stops reporting activity once the turn has been stopped', () => {
    const { session, events, start } = harness()
    const transport = start()
    transport.stream(frame(['● Bash(npm run build) (ctrl+o to expand)', P1]))
    const before = activities(events).length

    session.cancel()
    transport.stream(frame(['● Bash(rm -rf build) (ctrl+o to expand)', P1, P2]))

    expect(activities(events)).toHaveLength(before)
  })

  it('reads activity from an idle snapshot too, for a turn that never streams', () => {
    const { events, start } = harness()
    const transport = start()

    transport.snapshot(frame(['● Bash(npm test) (ctrl+o to expand)', P1]))

    expect(activities(events).some((event) => event.command === 'npm test')).toBe(true)
  })

  it('starts each turn with a clean slate rather than replaying the last one', () => {
    const { session, events, start } = harness()
    const transport = start()
    transport.stream(frame(['● Bash(npm run build) (ctrl+o to expand)', P1]))
    transport.snapshot(frame([P1, P2], SETTLED_COMPOSE))
    transport.handlers!.onReadyForInput()
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)

    // The same live process takes the next turn — its screen still shows
    // the previous turn's work until agy redraws.
    const nextPrompt = 'And now the printing press.'
    session.send(input({ runId: 'run_2', prompt: nextPrompt }), (event) => events.push(event))
    const second = activities(events).filter((event) => event.runId === 'run_2')
    expect(second, 'nothing is reported for a turn before its own screen has been seen').toHaveLength(0)

    transport.stream([...BANNER, `> ${nextPrompt}`, '', '● Bash(npm test) (ctrl+o to expand)', P1, ...COMPOSE])
    const reported = activities(events).filter((event) => event.runId === 'run_2')
    expect(reported.some((event) => event.command === 'npm test')).toBe(true)
    expect(reported.some((event) => event.command === 'npm run build')).toBe(false)
  })
})

// The real capture: six screens sampled 200 ms apart from one live `agy
// 1.1.27` turn, byte-for-byte apart from the banner's account email and
// workspace path (see the fixture's own `source` field). Replaying them
// through the real session is the closest a unit test gets to the bug
// itself — before this change the same turn produced no `text.delta` at all
// and the whole essay landed in one lump at `run.completed`.
describe('AntigravityPtySession against captured real agy screens', () => {
  it('streams the real essay progressively and settles on the complete answer', () => {
    const capture = JSON.parse(readFileSync(new URL('./fixtures/agyPtyStreamFrames.json', import.meta.url), 'utf8')) as {
      prompt: string
      frames: Array<{ tMs: number; ready: boolean; lines: string[] }>
    }
    const { events, start } = harness()
    const transport = start({ prompt: capture.prompt })

    for (const captured of capture.frames) {
      if (captured.ready) {
        transport.snapshot(captured.lines)
        transport.handlers!.onReadyForInput()
      } else {
        transport.stream(captured.lines)
      }
    }

    const streamed = deltas(events)
    // Real streaming, not one lump: several deltas, the first well before
    // the turn ends, and the essay's opening line among them.
    expect(streamed.length).toBeGreaterThanOrEqual(4)
    expect(streamed[0]).toContain('Two Wheels to Freedom')
    expect(events.findIndex((event) => event.type === 'text.delta')).toBeLessThan(events.findIndex((event) => event.type === 'run.completed'))

    const completed = events.find((event) => event.type === 'run.completed') as { finalText: string }
    expect(completed.finalText).toContain('The bicycle stands as one of humanity')
    expect(completed.finalText.length).toBeGreaterThan(9_000)
    // Nothing was shown that the final answer then contradicts: everything
    // streamed is the beginning of the completed response, modulo the
    // re-wrapping a redraw introduces.
    expect(progressiveAppendIndex(streamed.join(''), completed.finalText)).toBeGreaterThan(0)
    // And no compose chrome, spinner frame or banner ever leaked into it.
    const joined = streamed.join('')
    expect(joined).not.toMatch(/[⠀-⣿]/)
    expect(joined).not.toContain('for shortcuts')
    expect(joined).not.toContain('esc to cancel')
    expect(joined).not.toContain('Antigravity CLI')
    expect(joined).not.toContain('@')
  })
})
