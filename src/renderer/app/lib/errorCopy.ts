// Maps runtime error codes onto product language. Every mapping answers
// three questions in order: what happened, is the conversation safe, what
// can the user do. The original technical message is never discarded — it
// is always carried through as `details` for a disclosure.
import type { RuntimeErrorInfo } from '@shared/domain'

export type ErrorCategory = 'retryable' | 'user-action' | 'unrecoverable' | 'diagnostic'

export interface ErrorView {
  title: string
  body: string | null
  category: ErrorCategory
  /** The untouched provider/runtime message, shown behind "Show details". */
  details: string | null
}

export function describeRuntimeError(error: RuntimeErrorInfo): ErrorView {
  const details = error.message?.trim() || null

  switch (error.code) {
    case 'provider.exited':
      return {
        title: 'Antigravity’s session ended unexpectedly',
        body: 'Your conversation is safe. Send another message to continue.',
        category: 'retryable',
        details
      }
    case 'provider.not_installed':
      return {
        title: 'Antigravity isn’t installed',
        body: 'Orbit runs your own signed-in Antigravity CLI. Install it, then restart Orbit.',
        category: 'user-action',
        details
      }
    case 'provider.auth_required':
      return {
        title: 'You’re signed out of Antigravity',
        body: 'Sign in with the Antigravity CLI, then send your message again.',
        category: 'user-action',
        details
      }
    case 'provider.start_failed':
      return {
        title: 'Antigravity couldn’t start',
        body: 'Your conversation is safe. Check that the Antigravity CLI runs on its own, then try again.',
        category: 'user-action',
        details
      }
    case 'provider.interaction_denied':
      return {
        title: 'Antigravity needed permission it could not ask for',
        body: 'It skipped an action that required approval. Send another message — this conversation can now ask you directly.',
        category: 'retryable',
        details
      }
    // Distinct from the above on purpose. This session bypasses permissions,
    // so agy was never going to ask and nothing was withheld for want of a
    // prompt: it declined the action on its own terms. Telling the user to
    // grant permission would send them looking for a setting that would not
    // have changed the outcome.
    case 'provider.action_restricted':
      return {
        title: 'Antigravity would not do that',
        body: 'This session already bypasses permissions, so this was not a permission Orbit could ask you for — Antigravity declined the action itself.',
        category: 'user-action',
        details
      }
    case 'provider.session_busy':
      return {
        title: 'This conversation is already working',
        body: 'Wait for the current turn to finish, or stop it first.',
        category: 'user-action',
        details
      }
    case 'interaction.not_pending':
    case 'interaction.wrong_run':
      return {
        title: 'That request is no longer active',
        body: 'It was already answered or the turn moved on. Send another message to continue.',
        category: 'diagnostic',
        details
      }
    case 'interaction.invalid_option':
      return {
        title: 'That choice couldn’t be sent',
        body: 'Antigravity is no longer offering that option. Send another message to continue.',
        category: 'diagnostic',
        details
      }
    case 'provider.failed':
      return {
        title: 'Antigravity’s response couldn’t be read',
        body: 'Your conversation is safe. Send another message to try again.',
        category: 'retryable',
        details
      }
    default:
      return {
        title: 'Something went wrong',
        body: 'Your conversation is safe. Send another message to try again.',
        category: 'retryable',
        details
      }
  }
}

export interface ProviderProblem {
  title: string
  action: string | null
}

/** Global, actionable provider problems worth a calm banner. A healthy or
 *  merely-starting provider returns null — no permanent success chrome. */
export function describeProviderProblem(state: string, message: string | null): ProviderProblem | null {
  if (state === 'ready' || state === 'idle' || state === 'starting') return null
  const text = message ?? ''
  if (/not installed|could not find|no such file/i.test(text)) {
    return { title: 'Antigravity isn’t installed.', action: 'Setup instructions' }
  }
  if (/sign|auth|logged out|login/i.test(text)) {
    return { title: 'You’re signed out of Antigravity.', action: 'Sign in' }
  }
  if (state === 'unavailable') {
    return { title: 'Antigravity isn’t available.', action: null }
  }
  return { title: 'Antigravity isn’t responding.', action: null }
}
