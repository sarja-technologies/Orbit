import { describe, expect, it } from 'vitest'
import { promptKeystrokes } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'

/** `\r` is the submit key for agy's interactive TUI. A `\r` inside the
 *  prompt body is therefore a second Enter: it ends the turn early and
 *  sends the remainder of the user's text as a separate one. */
describe('the keystrokes that carry a prompt into an interactive session', () => {
  it('leaves an ordinary single-line prompt exactly as written', () => {
    expect(promptKeystrokes('Run the tests')).toBe('Run the tests')
  })

  it('keeps a multi-line prompt as one turn', () => {
    expect(promptKeystrokes('First line\nSecond line')).toBe('First line\nSecond line')
  })

  it('never lets a CRLF prompt submit itself halfway through', () => {
    // A prompt round-tripped through a file, a Windows clipboard, or an
    // external tool arrives CRLF. Written raw, the first \r submitted
    // "First line" and the rest opened a second, unrelated turn.
    expect(promptKeystrokes('First line\r\nSecond line')).toBe('First line\nSecond line')
    expect(promptKeystrokes('First line\r\nSecond line')).not.toContain('\r')
  })

  it('translates a lone carriage return too', () => {
    expect(promptKeystrokes('First\rSecond')).toBe('First\nSecond')
  })

  it('drops a trailing newline rather than submitting one keystroke early', () => {
    // The caller appends the single \r that submits. A trailing newline
    // here would submit first and leave that \r to open an empty turn.
    expect(promptKeystrokes('Run the tests\n')).toBe('Run the tests')
    expect(promptKeystrokes('Run the tests\r\n\r\n')).toBe('Run the tests')
  })

  it('keeps blank lines inside the prompt, which agy echoes as its own', () => {
    expect(promptKeystrokes('Create a file containing:\n\nHello from Orbit.')).toBe(
      'Create a file containing:\n\nHello from Orbit.'
    )
  })

  it('leaves an empty prompt empty', () => {
    expect(promptKeystrokes('')).toBe('')
  })
})
