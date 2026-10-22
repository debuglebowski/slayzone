/**
 * @vitest-environment jsdom
 *
 * The sign-in error the shell shows (T-13): from the hub's `?signin=failed&reason=` and
 * from better-auth's `?error=` — its error page redirects to `/?error=<code>` under
 * NODE_ENV=production (the hosted hub, O-25). Fixed messages per code; never the
 * `error_description` a link may carry.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { signInErrorFrom, signInErrorMessage, takeSignInError } from './sign-in-error'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('signInErrorFrom', () => {
  it("better-auth's production redirect (?error=): Entra refusals explain tenant, MFA, assignment", () => {
    const error = signInErrorFrom('?error=unable_to_get_user_info')
    expect(error?.code).toBe('unable_to_get_user_info')
    expect(error?.message).toMatch(/another organisation/)
    expect(error?.message).toMatch(/multi-factor/)
    expect(error?.message).toMatch(/not be assigned/)
  })

  it('an expired or cross-tab sign-in says to try again', () => {
    for (const code of [
      'state_mismatch',
      'please_restart_the_process',
      'invalid_callback_request'
    ]) {
      expect(signInErrorFrom(`?error=${code}`)?.message).toMatch(/took too long|another tab/)
    }
  })

  it("the hub's own ?signin=failed&reason=", () => {
    expect(signInErrorFrom('?signin=failed&reason=ACCOUNT_DISABLED')).toEqual({
      code: 'ACCOUNT_DISABLED',
      message: signInErrorMessage('ACCOUNT_DISABLED')
    })
    expect(signInErrorFrom('?signin=failed&reason=access_denied')?.message).toMatch(/cancelled/)
    expect(signInErrorFrom('?signin=failed')?.code).toBe('unknown')
  })

  it('an unknown code gets the general message; a code that is not plain is not echoed', () => {
    expect(signInErrorFrom('?error=something_new')?.message).toMatch(/did not complete/)
    const junk = signInErrorFrom(`?error=${encodeURIComponent('<b>call +1 555</b>')}`)
    expect(junk?.code).toBe('unknown')
    expect(junk?.message).not.toContain('555')
  })

  it('error_description is never shown', () => {
    const error = signInErrorFrom(
      `?error=unable_to_get_user_info&error_description=${encodeURIComponent('Call +1 555 now')}`
    )
    expect(JSON.stringify(error)).not.toContain('555')
  })

  it('no error parameters: null', () => {
    expect(signInErrorFrom('')).toBeNull()
    expect(signInErrorFrom('?windowId=3')).toBeNull()
  })
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
