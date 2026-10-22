// Web shell — why the last sign-in did not complete, from the URL the browser came
// back to (T-13). Two shapes reach the shell:
//
//   - `/?signin=failed&reason=<code>` — the hub's own web sign-in (hub-auth
//     `web-sign-in.ts`): Entra or better-auth's callback refused, or no usable session.
//   - `/?error=<code>[&error_description=…]` — better-auth's error page, which under
//     NODE_ENV=production (the hosted hub, O-25) redirects to `/` instead of rendering:
//     a callback it could not use at all (state expired, started in another tab).
//
// Only the CODE is used, and only to pick one of the fixed messages below:
// `error_description` is never shown — anyone can put text in a link to the hub, and
// the sign-in screen must not repeat it.

export interface SignInError {
  /** The code as received, when it is a plain code; else `unknown`. */
  code: string
  /** What to tell the person. */
  message: string
}

/** better-auth's own charset for a code (its error page's `safeCode`). */
const CODE = /^[A-Za-z0-9_'-]{1,64}$/

const ASK_ADMIN = 'If it keeps failing, ask your administrator.'

const MESSAGES: Readonly<Record<string, string>> = {
  // T-09 refuses every ID token that fails its checks with this generic code: another
  // tenant, no MFA, no SlayZone app role, no email (the audit line names which).
  unable_to_get_user_info:
    'Microsoft refused this account for this hub: it may belong to another organisation, ' +
    'have signed in without multi-factor authentication, or not be assigned to SlayZone. ' +
    'Ask your administrator.',
  ACCOUNT_DISABLED: 'This account is disabled on this hub. Ask your administrator.',
  account_not_linked:
    'The email of this Microsoft account already belongs to another account on this hub, ' +
    'so it cannot sign in. Ask your administrator.',
  unable_to_link_account:
    'This Microsoft account could not be connected to an account on this hub. Ask your administrator.',
  access_denied: 'Sign-in was cancelled at Microsoft. Try again.',
  state_mismatch: 'The sign-in took too long or was started in another tab. Try again.',
  please_restart_the_process: 'The sign-in took too long or was started in another tab. Try again.',
  invalid_callback_request: 'The sign-in took too long or was started in another tab. Try again.',
  no_session: `Microsoft sign-in did not complete. Try again. ${ASK_ADMIN}`
}

/** The message for a code; anything unknown gets the general one. */
export function signInErrorMessage(code: string): string {
  return MESSAGES[code] ?? `Microsoft sign-in did not complete. Try again. ${ASK_ADMIN}`
}

/** The sign-in error a URL's query carries, or null. Pure. */
export function signInErrorFrom(search: string): SignInError | null {
  const params = new URLSearchParams(search)
  const raw = params.get('signin') === 'failed' ? (params.get('reason') ?? '') : params.get('error')
  if (raw === null) return null
  const code = CODE.test(raw) ? raw : 'unknown'
  return { code, message: signInErrorMessage(code) }
}

const ERROR_PARAMS = ['signin', 'reason', 'error', 'error_description']

/**
 * Read the sign-in error from this page's URL once, and drop its parameters from the
 * URL (other parameters are kept), so a reload does not repeat it.
 */
export function takeSignInError(): SignInError | null {
  const error = signInErrorFrom(window.location.search)
  const params = new URLSearchParams(window.location.search)
  if (!ERROR_PARAMS.some((p) => params.has(p))) return error
  for (const p of ERROR_PARAMS) params.delete(p)
  const query = params.toString()
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  )
  return error
}
