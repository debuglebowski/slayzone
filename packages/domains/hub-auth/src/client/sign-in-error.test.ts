/**
 * The browser sign-in error (T-13): from the hub's `?signin=failed&reason=` and from
 * better-auth's `?error=` — its error page redirects to `/?error=<code>` under
 * NODE_ENV=production (the hosted hub, O-25). Fixed messages per code; never the
 * `error_description` a link may carry. (Moved from apps/web-shell, which keeps the
 * URL-cleaning `takeSignInError`.)
 */
import { describe, expect, it } from 'vitest'
import { SIGN_IN_ERROR_PARAMS, signInErrorFrom, signInErrorMessage } from './sign-in-error'

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

  it('names every parameter it reads (a client drops them once read)', () => {
    expect(SIGN_IN_ERROR_PARAMS).toEqual(['signin', 'reason', 'error', 'error_description'])
  })
})
