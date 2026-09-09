import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_TITLE, deriveSessionTitle, hasDefaultSessionTitle } from '../../src/shared/sessionTitle'

describe('deriveSessionTitle', () => {
  it('names a session after what the prompt asks for, not the asking', () => {
    expect(deriveSessionTitle('build me a futuristic robotics landing page')).toBe('Futuristic Robotics Landing Page')
    expect(deriveSessionTitle('Can you write a migration script for the users table')).toBe('Migration Script for the Users Table')
    expect(deriveSessionTitle('please help me set up a CI pipeline')).toBe('CI Pipeline')
  })

  it('keeps a verb that says what kind of work this is', () => {
    // "Fix the Login Bug" reads better in a sidebar than "Login Bug" — only
    // generic construction verbs are dropped.
    expect(deriveSessionTitle('fix the login bug on mobile')).toBe('Fix the Login Bug on Mobile')
    expect(deriveSessionTitle('refactor the payment service')).toBe('Refactor the Payment Service')
  })

  it('does not leave a title dangling on a preposition when it has to cut', () => {
    // The cut lands after "for"; a title reading "…Checklist for" would look
    // truncated, so the dangling preposition goes with it.
    expect(deriveSessionTitle('review the deployment checklist for the release')).toBe('Review the Deployment Checklist')
    expect(deriveSessionTitle('explain what this constant is for')).toBe('Explain What This Constant Is')
  })

  it('stops at the end of the first sentence', () => {
    expect(deriveSessionTitle('Rewrite the onboarding email. It is far too long and formal.')).toBe('Rewrite the Onboarding Email')
    expect(deriveSessionTitle('why does the build fail on CI?')).toBe('Why Does the Build Fail')
  })

  it('leaves words that carry their own capitals alone', () => {
    expect(deriveSessionTitle('add TypeScript types to the API client')).toBe('TypeScript Types to the API Client')
    expect(deriveSessionTitle('iOS build is broken')).toBe('iOS Build Is Broken')
  })

  it('stays short enough to read in the sidebar', () => {
    const title = deriveSessionTitle(
      'implement a comprehensive end to end regression testing harness for the entire billing subsystem'
    )
    expect(title).not.toBeNull()
    expect(title!.length).toBeLessThanOrEqual(38)
    expect(title!.split(' ').length).toBeLessThanOrEqual(6)
  })

  it('names the session after the prose, not a pasted snippet', () => {
    const prompt = ['```ts', 'const x: number = 1', '```', 'explain what this constant is for'].join('\n')
    expect(deriveSessionTitle(prompt)).toBe('Explain What This Constant Is')
  })

  it('looks past markdown decoration', () => {
    expect(deriveSessionTitle('## Deployment checklist review')).toBe('Deployment Checklist Review')
    expect(deriveSessionTitle('> tighten the error copy')).toBe('Tighten the Error Copy')
  })

  it('declines a prompt with nothing to name, so the session keeps its default', () => {
    expect(deriveSessionTitle('hi')).toBeNull()
    expect(deriveSessionTitle('help me')).toBeNull()
    expect(deriveSessionTitle('please')).toBeNull()
    expect(deriveSessionTitle('')).toBeNull()
    expect(deriveSessionTitle('   \n\n  ')).toBeNull()
    expect(deriveSessionTitle('```\ncode only\n```')).toBeNull()
  })

  it('declines rather than renaming a session to the name it already has', () => {
    expect(deriveSessionTitle(DEFAULT_SESSION_TITLE)).toBeNull()
  })

  it('is a pure function of the prompt, so the same prompt always names alike', () => {
    const prompt = 'design a dark mode palette'
    expect(deriveSessionTitle(prompt)).toBe(deriveSessionTitle(prompt))
  })
})

describe('hasDefaultSessionTitle', () => {
  it('recognises only the name Orbit gives a session itself', () => {
    expect(hasDefaultSessionTitle('New Session')).toBe(true)
    expect(hasDefaultSessionTitle('  New Session  ')).toBe(true)
    expect(hasDefaultSessionTitle('new session')).toBe(false)
    expect(hasDefaultSessionTitle('New Session 2')).toBe(false)
    expect(hasDefaultSessionTitle('Robotics Landing Page')).toBe(false)
  })
})
