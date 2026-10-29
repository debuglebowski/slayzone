/**
 * @vitest-environment jsdom
 *
 * The sign-in error the shell shows (T-13), read once from the page URL and cleaned out
 * of it. Codes and messages (`signInErrorFrom`) are tested with the shared client:
 * packages/domains/hub-auth/src/client/sign-in-error.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { takeSignInError } from './sign-in-error'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('takeSignInError', () => {
  it('reads the error once and drops only its parameters from the URL', () => {
    window.history.replaceState(null, '', '/?error=state_mismatch&error_description=x&keep=1#h')
    expect(takeSignInError()?.code).toBe('state_mismatch')
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/?keep=1#h'
    )
    expect(takeSignInError()).toBeNull()
  })

  it('cleans the hub sign-in failure too', () => {
    window.history.replaceState(null, '', '/?signin=failed&reason=no_session')
    expect(takeSignInError()?.code).toBe('no_session')
    expect(window.location.search).toBe('')
  })
})
