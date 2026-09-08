import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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
  sendPrompt(prompt: string): void {
    this.sentPrompts.push(prompt)
  }
  respond(_pending: PtyInteraction, _optionId: string): boolean {
    return true
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {
    this.cancelCalls++
  }
  kill(): void {
    this.isRunning = false
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
  const start = (overrides: Partial<ProviderSendInput> = {}): FakeTransport => {
    session.send(input(overrides), (event) => events.push(event))
    const transport = transports.at(-1)!
    transport.handlers!.onReadyForInput() // bootstrap complete -> the prompt is written
    return transport
  }
  return { session, transports, events, start }
}

const deltas = (events: RuntimeEvent[]): string[] =>
  events.filter((event): event is Extract<RuntimeEvent, { type: 'text.delta' }> => event.type === 'text.delta').map((event) => event.delta)

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
