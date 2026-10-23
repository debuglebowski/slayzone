// The web shell's session, as the hub reports it (T-13). The session itself is an
// HttpOnly cookie the shell cannot read, so it asks the hub
// (`web-session-routes.ts`). Both calls are POSTs: a browser always sends `Origin` on
// one, and the hub answers cookie requests only from its own page.

const STATUS_PATH = '/api/auth/web-session'
const LOGOUT_PATH = '/api/auth/web-logout'

/**
 * Does this browser hold a live web session? Any failure answers false — the sign-in
 * screen, never the app on a session the hub would not honour.
 */
export async function fetchSignedIn(): Promise<boolean> {
  try {
    const res = await fetch(STATUS_PATH, { method: 'POST', credentials: 'same-origin' })
    if (!res.ok) return false
    const body = (await res.json()) as { signedIn?: unknown }
    return body.signedIn === true
  } catch {
    return false
  }
}

/** Sign out: the hub revokes the session and clears the cookie. True when it did. */
export async function signOut(): Promise<boolean> {
  try {
    const res = await fetch(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' })
    return res.ok
  } catch {
    return false
  }
}
