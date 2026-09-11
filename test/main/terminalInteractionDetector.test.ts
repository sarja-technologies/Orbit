import { describe, expect, it } from 'vitest'
import {
  detectGenericInteraction,
  extractResponseText,
  findPromptEcho,
  progressiveAppendIndex,
  isBusy,
  isReadyForInput,
  readMediaAttachedCount
} from '../../src/main/terminal/TerminalInteractionDetector'

// Real captured agy workspace-trust prompt (see this repo's
// docs/antigravity-transports.md for how this was captured live via
// node-pty + @xterm/headless against agy 1.1.27).
const WORKSPACE_TRUST_LINES = [
  'Accessing workspace:',
  '',
  '/tmp/agy-probe-fixed',
  '',
  'Do you trust the contents of this project?',
  '',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  '',
  '> Yes, I trust this folder',
  '  No, exit',
  '',
  '  ↑/↓ Navigate · enter Confirm',
  '                                                                                               Gemini 3.8 Flash · medium'
]

// Real captured command-permission prompt shape (numbered menu).
const COMMAND_PERMISSION_LINES = [
  'Requesting permission for:',
  '   echo hello-from-shell',
  '',
  'Do you want to proceed?',
  '> 1. Yes',
  '  2. No',
  '',
  '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
  'esc to cancel                                                                                  Gemini 3.8 Flash · medium'
]

describe('detectGenericInteraction', () => {
  it('detects a real captured arrow-menu workspace-trust prompt', () => {
    const result = detectGenericInteraction(WORKSPACE_TRUST_LINES)
    expect(result?.kind).toBe('permission')
    expect(result?.prompt).toBe('Do you trust the contents of this project?')
    expect(result?.options).toEqual([
      { id: 'arrow:0', label: 'Yes, I trust this folder' },
      { id: 'arrow:1', label: 'No, exit' }
    ])
  })

  it('detects a real captured numbered command-permission prompt', () => {
    const result = detectGenericInteraction(COMMAND_PERMISSION_LINES)
    expect(result?.kind).toBe('permission')
    expect(result?.options).toEqual([
      { id: '1', label: 'Yes' },
      { id: '2', label: 'No' }
    ])
    expect(result?.prompt).toContain('Do you want to proceed?')
  })

  it('detects a y/n confirmation', () => {
    const result = detectGenericInteraction(['Overwrite existing file? (y/n)', 'y. Yes', 'n. No'])
    expect(result?.kind).toBe('permission')
    expect(result?.options).toEqual([
      { id: 'y', label: 'Yes' },
      { id: 'n', label: 'No' }
    ])
  })

  it('returns null for ordinary prose with no menu', () => {
    const result = detectGenericInteraction(['Here is a normal assistant response.', 'Nothing to see here.'])
    expect(result).toBeNull()
  })

  it('does not treat a plain numbered list in prose as a menu at all (no cursor marker, no permission wording)', () => {
    // Real bug, confirmed live: a numbered list is an extremely common
    // shape for ordinary AI prose (steps, options, summaries). Without a
    // cursor marker or permission-shaped wording, it must never be treated
    // as an interaction — see the two regression tests below for the
    // exact real captured failure and its footer-based fix.
    const result = detectGenericInteraction(['Steps to reproduce:', '1. Open the app', '2. Click submit'])
    expect(result).toBeNull()
  })

  it('regression: the exact real captured false-positive (agy 1.1.27) — a numbered-list answer at the ready footer', () => {
    // Real captured screen from a live run: asked agy for a numbered list
    // of 3 items; it settled to the ready footer with a numbered-looking
    // answer on screen. This used to be misdetected as a live menu,
    // corrupting the conversation when something answered it.
    const lines = [
      '> Just reply with a numbered list of 3 made-up fruit names.',
      '',
      '1. <fruit>',
      '2. <fruit>',
      '3. <fruit>',
      '',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '? for shortcuts                                                                                Gemini 3.8 Flash · medium'
    ]
    expect(detectGenericInteraction(lines)).toBeNull()
    expect(isReadyForInput(lines)).toBe(true)
  })

  it('regression: a numbered-list answer mid-stream (busy footer, no cursor marker, no permission wording) is still not a menu', () => {
    // Closes the narrower gap the ready-footer check alone doesn't cover:
    // a slow/paused stream could settle an idle snapshot on a numbered
    // list before the turn is fully done, while the footer still reads
    // "esc to cancel" — the exact same footer text a real permission menu
    // also uses, so the ready-footer exclusion above can't help here.
    const lines = ['1. First made-up item', '2. Second made-up item', 'esc to cancel                    Gemini 3.8 Flash · medium']
    expect(detectGenericInteraction(lines)).toBeNull()
    expect(isBusy(lines)).toBe(true)
  })

  it('still detects a real permission menu even while the busy footer is technically also present', () => {
    // The busy/menu footer overlap (both read "esc to cancel") is exactly
    // why the cursor-marker/permission-wording gate exists instead of a
    // blanket busy-footer exclusion — a real menu must still be detected.
    expect(detectGenericInteraction(COMMAND_PERMISSION_LINES)?.kind).toBe('permission')
    expect(isBusy(COMMAND_PERMISSION_LINES)).toBe(true)
  })
})

describe('footer-based ready/busy detection', () => {
  it('recognizes the real captured busy footer', () => {
    expect(isBusy(['some output', 'esc to cancel'])).toBe(true)
    expect(isReadyForInput(['some output', 'esc to cancel'])).toBe(false)
  })

  it('recognizes the real captured ready footer', () => {
    expect(isReadyForInput(['some output', '? for shortcuts'])).toBe(true)
    expect(isBusy(['some output', '? for shortcuts'])).toBe(false)
  })

  it('is neither busy nor ready while a menu occupies the screen', () => {
    expect(isBusy(WORKSPACE_TRUST_LINES)).toBe(false)
    expect(isReadyForInput(WORKSPACE_TRUST_LINES)).toBe(false)
  })
})

describe('extractResponseText', () => {
  // Real captured screen (agy 1.1.27) where the sent prompt word-wraps
  // across two physical rows with no blank line between them, before the
  // real response and a trailing blank line + footer.
  it('skips a word-wrapped multi-row prompt echo and returns only the real response', () => {
    const lines = [
      '> Do not run any shell commands yet. First ask me one short clarifying question: what filename should you use for a',
      ' test file? Then stop and wait for my answer.',
      '',
      '  What filename should I use for the test file?',
      '',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '? for shortcuts                                                                                Gemini 3.8 Flash · medium'
    ]
    expect(extractResponseText(lines)).toBe('What filename should I use for the test file?')
  })

  it('strips tool-activity lines from a response that ran a command', () => {
    const lines = ['> Run touch test.txt', '', '● Bash(touch test.txt) (ctrl+o to expand)', '', '  Done, created test.txt.', '', '? for shortcuts']
    expect(extractResponseText(lines)).toBe('Done, created test.txt.')
  })

  it('returns nothing when there is no prompt echo to anchor against', () => {
    // Previously returned the whole screen. Changed deliberately: without an
    // echo the response boundary is unknown, and the fallback leaked agy's
    // startup banner into the transcript (see the regression below).
    expect(extractResponseText(['Just some text', '? for shortcuts'])).toBe('')
  })

  it('regression: never reports agy’s startup banner as an assistant response', () => {
    // Real captured first-paint screen of a freshly spawned session — it
    // contains the signed-in account's email and the workspace path, and
    // has no prompt echo because nothing has been sent yet.
    const banner = [
      '      ▄▀▀▄        Antigravity CLI 1.1.27',
      '     ▀▀▀▀▀▀       billymillena@gmail.com',
      '    ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (Medium)',
      '   ▄▀▀    ▀▀▄     /tmp/orbit-ui/projects/project_abc/workspace',
      '  ▄▀▀      ▀▀▄',
      '',
      '────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────',
      '? for shortcuts                     Gemini 3.8 Flash · medium'
    ]
    const result = extractResponseText(banner)
    expect(result).toBe('')
    expect(result).not.toContain('@')
    expect(result).not.toContain('Antigravity CLI')
  })

  it('preserves a fenced code block and its indentation', () => {
    const lines = [
      '> show me a hello world function',
      '',
      '  Here you go:',
      '',
      '  ```js',
      '  function hello() {',
      '    console.log("hi")',
      '  }',
      '  ```',
      '',
      '? for shortcuts'
    ]
    expect(extractResponseText(lines)).toBe('Here you go:\n\n```js\nfunction hello() {\n  console.log("hi")\n}\n```')
  })

  it('preserves unicode and emoji content', () => {
    const lines = ['> 你好', '', '  こんにちは 👋 — café résumé', '', '? for shortcuts']
    expect(extractResponseText(lines)).toBe('こんにちは 👋 — café résumé')
  })

  it('preserves multiple paragraph breaks', () => {
    const lines = ['> explain in two paragraphs', '', '  First paragraph.', '', '  Second paragraph.', '', '? for shortcuts']
    expect(extractResponseText(lines)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('does not leak permission-menu text into the final response even if menu lines were still present', () => {
    // Live-verified (real agy 1.1.27) that a resolved menu is actually
    // fully erased/redrawn away before the turn settles — a real snapshot
    // never contains both the menu and the final text together. This
    // fixture is deliberately the harder, hypothetical case (menu lines
    // still present alongside tool activity and the real final prose) as
    // a defense-in-depth check: extraction must stay safe even if that
    // assumption ever turns out to be wrong on a future agy version.
    const lines = [
      '> run the build and tell me if it passed',
      '',
      'Requesting permission for:',
      '   npm run build',
      '',
      'Do you want to proceed?',
      '> 1. Yes',
      '  2. No',
      '',
      '● Bash(npm run build) (ctrl+o to expand)',
      '',
      '  Build succeeded with no errors.',
      '',
      '? for shortcuts'
    ]
    const result = extractResponseText(lines)
    expect(result).toBe('Build succeeded with no errors.')
    expect(result).not.toContain('Requesting permission')
    expect(result).not.toContain('1. Yes')
  })
})

describe('extractResponseText prompt anchoring (progressive reading)', () => {
  const WIDE = '─'.repeat(120)
  const PROMPT = 'Write a short essay about the history of the bicycle.'
  const ANSWER = '  The bicycle stands as one of the most efficient machines ever built.'

  it('anchors on the known prompt instead of the blank line beneath it', () => {
    // Real captured regression: once the terminal scrolls, agy's blank
    // separator under the echo is gone, and the blank-line heuristic then
    // skips real response lines looking for one. With the prompt to match
    // against, the answer starts exactly where it should.
    const scrolled = [`> ${PROMPT}`, '▸ Thought for 11s', '  Verifying Requirements Thoroughly', ANSWER, WIDE, '>', WIDE, '? for shortcuts   Gemini 3.6 Flash · medium']
    // Legacy shape: agy 1.1.x drew a settled `▸ Thought for` block. agy
    // 1.2.0 does not (checked across 698 captured frames of a thinking,
    // tool-using, high-effort run), so this stays as a record of the older
    // screen. The content indent agy adds is removed either way.
    expect(extractResponseText(scrolled, { prompt: PROMPT })).toBe(`Verifying Requirements Thoroughly\n${ANSWER.trim()}`)
  })

  it('consumes a prompt that word-wrapped across several rows', () => {
    const long = 'Do not run any shell commands yet. First ask me one short clarifying question: what filename should you use for a test file?'
    const lines = [
      '> Do not run any shell commands yet. First ask me one short clarifying question: what filename should you use for a',
      ' test file?',
      '  What filename should I use?',
      WIDE,
      '>',
      WIDE,
      '? for shortcuts'
    ]
    expect(extractResponseText(lines, { prompt: long })).toBe('What filename should I use?')
  })

  it('returns nothing when the echo on screen belongs to a different turn', () => {
    const previousTurn = [`> An older question`, '', '  An older answer.', WIDE, '>', WIDE, '? for shortcuts']
    expect(extractResponseText(previousTurn, { prompt: PROMPT, requirePromptEcho: true })).toBe('')
    // Without requirePromptEcho the blank-line fallback still applies, so
    // the settle path keeps working exactly as before.
    expect(extractResponseText(previousTurn, { prompt: PROMPT })).toBe('An older answer.')
  })

  it('drops the compose box even when the footer is momentarily just the model name', () => {
    // Real captured shape while a prompt is being typed into the box: no
    // "? for shortcuts" and no "esc to cancel" to recognise it by.
    const typing = [`> ${PROMPT}`, WIDE, '                                        Gemini 3.6 Flash · medium']
    expect(extractResponseText(typing, { prompt: PROMPT })).toBe('')
  })

  it('drops the Braille spinner progress line agy redraws while working', () => {
    const lines = [`> ${PROMPT}`, '', ANSWER, '⣽  Working...', WIDE, '>', WIDE, 'esc to cancel']
    expect(extractResponseText(lines, { prompt: PROMPT })).toBe(ANSWER.trim())
  })

  it('drops the rotating tip line agy hangs off its working indicator', () => {
    // Real captured frame: the tip changes from turn to turn and even
    // mid-turn, so it is both chrome and a moving target.
    const working = [`> ${PROMPT}`, '⡿  Generating...', '└ Tip: Use /model to switch between available models.', WIDE, '>', WIDE, 'esc to cancel']
    expect(extractResponseText(working, { prompt: PROMPT })).toBe('')

    const answering = [`> ${PROMPT}`, ANSWER, '⡿  Generating...', '└ Tip: You can switch conversations with /resume.', WIDE, '>', WIDE, 'esc to cancel']
    expect(extractResponseText(answering, { prompt: PROMPT })).toBe(ANSWER.trim())
  })

  it('keeps a markdown horizontal rule inside a response', () => {
    // Only the terminal-width box rules are chrome; agy draws a markdown
    // rule short and indented.
    const lines = [`> ${PROMPT}`, '', '  Intro.', '  ──────', '  Conclusion.', WIDE, '>', WIDE, '? for shortcuts']
    expect(extractResponseText(lines, { prompt: PROMPT })).toContain('Conclusion.')
  })
})

describe('progressiveAppendIndex', () => {
  it('reports where a grown screen continues from what already streamed', () => {
    expect(progressiveAppendIndex('Hello', 'Hello world')).toBe(5)
    expect('Hello world'.slice(progressiveAppendIndex('Hello', 'Hello world'))).toBe(' world')
  })

  it('treats a re-wrap that changes only whitespace as no new text', () => {
    // Real captured churn: a blank line and a trailing space come and go
    // between frames as the terminal scrolls and re-wraps.
    expect(progressiveAppendIndex('Line one.\n\nLine two.', 'Line one.\nLine two.')).toBe('Line one.\nLine two.'.length)
    expect('Line one.\nLine two.'.slice(progressiveAppendIndex('Line one.\n\nLine two.', 'Line one.\nLine two.'))).toBe('')
    expect('Line one. \nLine two. extra'.slice(progressiveAppendIndex('Line one.\nLine two.', 'Line one. \nLine two. extra'))).toBe(' extra')
  })

  it('rejects a frame that is not a continuation at all', () => {
    expect(progressiveAppendIndex('The bicycle stands', 'A different answer entirely')).toBe(-1)
    expect(progressiveAppendIndex('Longer already streamed text', 'Shorter')).toBe(-1)
  })

  it('starts from the beginning when nothing has streamed yet', () => {
    expect(progressiveAppendIndex('', 'First words')).toBe(0)
  })
})

describe('readMediaAttachedCount', () => {
  it('parses the real captured clipboard-paste confirmation marker', () => {
    expect(readMediaAttachedCount(['▸ 📎 1 media attached (clipboard, 141 B, image/png)'])).toBe(1)
  })

  it('tracks the highest count seen across lines', () => {
    expect(readMediaAttachedCount(['📎 1 media attached', 'unrelated', '📎 2 media attached'])).toBe(2)
  })

  it('returns 0 when nothing matches', () => {
    expect(readMediaAttachedCount(['no attachments here'])).toBe(0)
  })
})

/** Screens copied verbatim from agy 1.2.0 on this machine (120 columns),
 *  captured while investigating the "Prioritizing Tool Usage" leak. Every
 *  content row agy paints inside the response region is indented by two
 *  columns; its own transient chrome is painted flush left. */
describe('extractResponseText against real captured agy 1.2.0 screens', () => {
  const WIDE = '─'.repeat(120)
  const NARROW = '─'.repeat(60)

  it('keeps the status slot out of the answer when agy paints it with its spinner', () => {
    const screen = ['> hi', '', '  Hello! How can I help you today?', '⣾  Generating...', WIDE, '>', WIDE, 'esc to cancel                    Gemini 3.8 Flash · low']
    expect(extractResponseText(screen, { prompt: 'hi' })).toBe('Hello! How can I help you today?')
  })

  it('keeps it out when agy paints that same slot without its spinner', () => {
    // Captured live: between redraws agy paints the status row bare. The
    // spinner-only filter missed exactly this frame, which is how the work
    // title reached the transcript.
    const screen = ['> hi', '', '  Hello! How can I help you today?', 'Generating...', WIDE, '>', WIDE, 'esc to cancel']
    expect(extractResponseText(screen, { prompt: 'hi' })).toBe('Hello! How can I help you today?')
  })

  it('keeps a model-authored work title out, exactly as it does "Generating..."', () => {
    // "Prioritizing Tool Usage" is the model's own thought-summary heading,
    // which agy substitutes into the status slot. It is not in the agy
    // binary at all, so only its position identifies it.
    const withGlyph = ['> hi', '', '  Hello! How can I help you today?', '⣷  Prioritizing Tool Usage', WIDE, '>', WIDE, 'esc to cancel']
    const bare = ['> hi', '', '  Hello! How can I help you today?', 'Prioritizing Tool Specificity', WIDE, '>', WIDE, 'esc to cancel']

    expect(extractResponseText(withGlyph, { prompt: 'hi' })).toBe('Hello! How can I help you today?')
    expect(extractResponseText(bare, { prompt: 'hi' })).toBe('Hello! How can I help you today?')
  })

  it('keeps a tool row and its own detail out, but not the prose after it', () => {
    // Verbatim from a live run in this repo.
    const screen = [
      NARROW,
      '> hi',
      '',
      '● ListDir(~/Documents/Orbit-AGDC/Orbit) (ctrl+o to expand)',
      '',
      '  Hello! How can I help you with the Orbit project today?',
      '⣻  Generating...',
      '└ Tip: In /diff, press c to add inline comments and send them as feedback.',
      WIDE,
      '>',
      WIDE,
      'esc to cancel                                    Gemini 3.6 Flash · high'
    ]
    expect(extractResponseText(screen, { prompt: 'hi' })).toBe('Hello! How can I help you with the Orbit project today?')
  })

  it('keeps a long wrapped answer whole, with its markdown and code intact', () => {
    // Verbatim shape from a live long-answer run: wrapped rows, a heading,
    // bullets and a fenced block all carry agy's two-column content indent,
    // and the code's own deeper indentation survives relative to it.
    const screen = [
      '> Write one long paragraph about bicycles.',
      '',
      '  Bicycles stand as one of humanity’s most elegant machines,',
      '  combining human biomechanics with mechanical ingenuity.',
      '',
      '  ### Key Benefits of Cycling',
      '',
      '  • Environmental Sustainability: Produces zero emissions.',
      '  • Physical Health: Low-impact cardiovascular exercise.',
      '',
      '    def calculate_speed(distance_km: float, time_hours: float) -> float:',
      '        return distance_km / time_hours',
      '⢿  Generating...',
      WIDE,
      '>',
      WIDE,
      'esc to cancel'
    ]
    const result = extractResponseText(screen, { prompt: 'Write one long paragraph about bicycles.' })

    expect(result).toContain('Bicycles stand as one of humanity’s most elegant machines,')
    expect(result).toContain('combining human biomechanics with mechanical ingenuity.')
    expect(result).toContain('### Key Benefits of Cycling')
    expect(result).toContain('• Environmental Sustainability: Produces zero emissions.')
    // Dedented by the two columns agy adds, so the code keeps its own shape.
    expect(result).toContain('  def calculate_speed(distance_km: float, time_hours: float) -> float:')
    expect(result).toContain('      return distance_km / time_hours')
    expect(result).not.toMatch(/Generating/)
  })

  it('never returns the status slot alone, before any answer has been painted', () => {
    // The frame between sending and the first token: nothing to stream yet.
    const generating = ['> hi', '', '⣷  Generating...', WIDE, '>', WIDE, 'esc to cancel']
    const titled = ['> hi', '', 'Prioritizing Tool Usage', WIDE, '>', WIDE, 'esc to cancel']

    expect(extractResponseText(generating, { prompt: 'hi' })).toBe('')
    expect(extractResponseText(titled, { prompt: 'hi' })).toBe('')
  })

  it('preserves a legitimate first line that merely looks like a heading', () => {
    // Title Case is not evidence of anything: this is the answer, indented
    // by agy exactly as prose is, with no marker above it.
    const screen = ['> name three habits', '', '  Prioritizing Deep Work Matters', '', '  Here are three habits that help.', WIDE, '>', WIDE, '? for shortcuts']
    expect(extractResponseText(screen, { prompt: 'name three habits' })).toBe('Prioritizing Deep Work Matters\n\nHere are three habits that help.')
  })
})

/** The user's own prompt, echoed by agy, must never be read back as the
 *  answer. Screens copied from agy 1.2.x on this machine. */
describe('a multiline prompt echo is consumed whole', () => {
  const WIDE = '─'.repeat(120)
  const NARROW = '─'.repeat(60)
  const PROMPT = 'Create a file called hello.txt containing exactly:\n\nHello from Orbit.\n\nThen verify the file exists and read its contents back to me.'

  /** Verbatim shape of how agy echoes that prompt: the first row carries
   *  the `>` marker, the rest is indented two columns exactly like assistant
   *  prose, and the prompt's own blank lines appear as blank rows inside
   *  the echo block. */
  const screen = [
    NARROW,
    '> Create a file called hello.txt containing exactly:',
    '  ',
    '  Hello from Orbit.',
    '  ',
    '  Then verify the file exists and read its contents back to me.',
    '',
    '● Edit(/tmp/ws/hello.txt)',
    '● Read(/tmp/ws/hello.txt) (ctrl+o to expand)',
    '',
    '  The file hello.txt has been created and verified.',
    '⣯  Generating...',
    WIDE,
    '>',
    WIDE,
    'esc to cancel'
  ]

  it('returns only the answer, never any part of the prompt', () => {
    const result = extractResponseText(screen, { prompt: PROMPT })

    expect(result).toBe('The file hello.txt has been created and verified.')
    // The exact regression: these are the user's own words.
    expect(result).not.toContain('Hello from Orbit.')
    expect(result).not.toContain('Then verify the file exists')
    expect(result).not.toContain('Create a file called hello.txt')
  })

  it('is not fooled by the blank lines inside the prompt', () => {
    // Stopping at the first blank row was the bug: everything after it was
    // handed to the extractor as if agy had said it.
    const echo = findPromptEcho(screen, PROMPT)
    expect(echo).not.toBeNull()
    expect(screen[echo!.bodyStart - 1]).toBe('  Then verify the file exists and read its contents back to me.')
  })

  it('consumes a prompt that both wraps and contains blank lines', () => {
    const long =
      'Refactor the payment service so retries are idempotent and the webhook worker stops double charging customers.\n\nThen add a regression test for it.'
    const wrapped = [
      '> Refactor the payment service so retries are idempotent and the webhook worker stops double charging',
      '  customers.',
      '  ',
      '  Then add a regression test for it.',
      '',
      '  Done — retries are keyed on the event id now.',
      WIDE,
      '>',
      WIDE,
      '? for shortcuts'
    ]

    expect(extractResponseText(wrapped, { prompt: long })).toBe('Done — retries are keyed on the event id now.')
  })

  it('keeps a prompt that contains a fenced code block out of the answer', () => {
    const withCode = 'Explain this:\n\n```js\nconst x = 1\n```\n\nWhat does it do?'
    const lines = [
      '> Explain this:',
      '  ',
      '  ```js',
      '  const x = 1',
      '  ```',
      '  ',
      '  What does it do?',
      '',
      '  It declares a constant.',
      WIDE,
      '>',
      WIDE,
      '? for shortcuts'
    ]

    expect(extractResponseText(lines, { prompt: withCode })).toBe('It declares a constant.')
  })

  it('still keeps a legitimate first line of the answer', () => {
    const lines = [
      '> hi',
      '',
      '  Hello from Orbit is a phrase I can explain.',
      WIDE,
      '>',
      WIDE,
      '? for shortcuts'
    ]
    // Same words as the prompt above, but this time agy really said them.
    expect(extractResponseText(lines, { prompt: 'hi' })).toBe('Hello from Orbit is a phrase I can explain.')
  })
})
