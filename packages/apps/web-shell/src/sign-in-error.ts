// Web shell — why the last sign-in did not complete, from the URL the browser came
// back to (T-13). Which codes, which messages, and why `error_description` is never
// shown: the shared hub sign-in client (`signInErrorFrom`, @slayzone/hub-auth/client).
// This file only owns the browser part: reading `window.location` and cleaning the URL.
import { SIGN_IN_ERROR_PARAMS, signInErrorFrom, type SignInError } from '@slayzone/hub-auth/client'

export type { SignInError }

/**
 * Read the sign-in error from this page's URL once, and drop its parameters from the
 * URL (other parameters are kept), so a reload does not repeat it.
 */
export function takeSignInError(): SignInError | null {
  const error = signInErrorFrom(window.location.search)
  const params = new URLSearchParams(window.location.search)
  if (!SIGN_IN_ERROR_PARAMS.some((p) => params.has(p))) return error
  for (const p of SIGN_IN_ERROR_PARAMS) params.delete(p)
  const query = params.toString()
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  )
  return error
}
