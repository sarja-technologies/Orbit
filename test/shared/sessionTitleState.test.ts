import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_TITLE,
  deriveTitleForPrompt,
  provisionalSessionTitle,
  shouldApplyAutoTitle
} from '../../src/shared/sessionTitle'

describe('the title a prompt earns', () => {
  it('names a session substantively from a prompt with a subject', () => {
    expect(deriveTitleForPrompt('fix the login form')).toEqual({ title: 'Fix the Login Form', kind: 'substantive' })
    expect(deriveTitleForPrompt('make the sidebar resizable')).toEqual({ title: 'Sidebar Resizable', kind: 'substantive' })
  })

  it('still names a session whose first prompt says nothing', () => {
    // The product rule that changed: a used session must not sit at
    // `New Session` forever just because the opener was "hi".
    expect(deriveTitleForPrompt('hi')).toEqual({ title: 'Hi', kind: 'provisional' })
    expect(deriveTitleForPrompt('hello')).toEqual({ title: 'Hello', kind: 'provisional' })
    expect(deriveTitleForPrompt('help me')).toEqual({ title: 'Help Me', kind: 'provisional' })
  })

  it('uses the user’s own words rather than inventing a summary of them', () => {
    // "hi" becomes "Hi", never "Greeting": a provisional title is still a
    // truthful one.
    expect(provisionalSessionTitle('okay')).toBe('Okay')
    expect(provisionalSessionTitle('thanks')).toBe('Thanks')
  })

  it('derives nothing at all from an empty prompt', () => {
    expect(deriveTitleForPrompt('')).toBeNull()
    expect(deriveTitleForPrompt('   \n  ')).toBeNull()
  })

  it('never derives the default title itself', () => {
    expect(provisionalSessionTitle(DEFAULT_SESSION_TITLE)).toBeNull()
  })
})

describe('when Orbit is allowed to rename a session', () => {
  const substantive = { title: 'Fix the Login Form', kind: 'substantive' as const }
  const provisional = { title: 'Hi', kind: 'provisional' as const }

  it('names a session that has never been named', () => {
    expect(shouldApplyAutoTitle('default', substantive)).toBe(true)
    expect(shouldApplyAutoTitle('default', provisional)).toBe(true)
  })

  it('upgrades a provisional title when a real subject finally arrives', () => {
    expect(shouldApplyAutoTitle('provisional', substantive)).toBe(true)
  })

  it('does not swap one provisional title for another', () => {
    // "hi" then "hello" is not new information about what the session is.
    expect(shouldApplyAutoTitle('provisional', provisional)).toBe(false)
  })

  it('stops renaming once a session has a real name', () => {
    expect(shouldApplyAutoTitle('substantive', substantive)).toBe(false)
    expect(shouldApplyAutoTitle('substantive', provisional)).toBe(false)
  })

  it('never touches a title the user typed', () => {
    expect(shouldApplyAutoTitle('manual', substantive)).toBe(false)
    expect(shouldApplyAutoTitle('manual', provisional)).toBe(false)
  })
})
