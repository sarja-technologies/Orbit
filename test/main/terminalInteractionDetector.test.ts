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
  '  2. No'
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

  it('does not misread a plain numbered list in prose as a menu without permission wording', () => {
    // Two numbered lines alone are 'choice', not 'permission' — only real
    // question/trust/permission wording should ever classify as approval-shaped.
    const result = detectGenericInteraction(['Steps to reproduce:', '1. Open the app', '2. Click submit'])
    expect(result?.kind).toBe('choice')
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

  it('returns the whole screen when there is no recognizable prompt echo', () => {
    expect(extractResponseText(['Just some text', '? for shortcuts'])).toBe('Just some text')
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
