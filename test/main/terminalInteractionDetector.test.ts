import { describe, expect, it } from 'vitest'
import {
  detectGenericInteraction,
  extractResponseText,
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
    const lines = ['> Run touch test.txt', '', '● Bash(touch test.txt) (ctrl+o to expand)', '', 'Done, created test.txt.', '', '? for shortcuts']
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
      'Here you go:',
      '',
      '```js',
      'function hello() {',
      '  console.log("hi")',
      '}',
      '```',
      '',
      '? for shortcuts'
    ]
    expect(extractResponseText(lines)).toBe('Here you go:\n\n```js\nfunction hello() {\n  console.log("hi")\n}\n```')
  })

  it('preserves unicode and emoji content', () => {
    const lines = ['> 你好', '', 'こんにちは 👋 — café résumé', '', '? for shortcuts']
    expect(extractResponseText(lines)).toBe('こんにちは 👋 — café résumé')
  })

  it('preserves multiple paragraph breaks', () => {
    const lines = ['> explain in two paragraphs', '', 'First paragraph.', '', 'Second paragraph.', '', '? for shortcuts']
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
      'Build succeeded with no errors.',
      '',
      '? for shortcuts'
    ]
    const result = extractResponseText(lines)
    expect(result).toBe('Build succeeded with no errors.')
    expect(result).not.toContain('Requesting permission')
    expect(result).not.toContain('1. Yes')
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
