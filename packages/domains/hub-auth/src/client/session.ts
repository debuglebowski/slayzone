/** Who a bearer belongs to: better-auth's `GET /api/auth/get-session`. */
import { AUTH_MAX_CHARS, AUTH_TIMEOUT_MS, HUB_AUTH_PATHS, parseJson } from './protocol'
import type { HubTransport } from './transport'

/** The email of the account `token` belongs to, or null (unknown, unreachable, not signed in). */
export async function fetchSessionEmail(
  transport: HubTransport,
  baseUrl: string,
  token: string,
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<string | null> {
  try {
    const res = await transport({
      method: 'GET',
      url: `${baseUrl}${HUB_AUTH_PATHS.session}`,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs,
      maxResponseChars: AUTH_MAX_CHARS
    })
    const body = parseJson(res.text) as { user?: { email?: unknown } } | null | undefined
    return typeof body?.user?.email === 'string' ? body.user.email : null
  } catch {
    return null
  }
}

/** Whether a stored bearer still signs in to the hub — see {@link checkHubSession}. */
export type HubSessionCheck =
  | { state: 'valid'; email: string | null }
  | { state: 'expired' }
  | { state: 'unreachable' }

/**
 * Ask the hub whether `token` is still a live session. Unlike
 * {@link fetchSessionEmail}, keeps "the hub says no" (`expired`: sign in again) apart
 * from "no answer" (`unreachable`: nothing the user can fix by signing in).
 *
 * better-auth answers `get-session` with JSON `null` (200) for a token it does not
 * know; a 401/403 says the same. Anything that is not JSON, or a 5xx, is not an
 * answer about the session — a proxy's error page, a hub mid-restart.
 */
export async function checkHubSession(
  transport: HubTransport,
  baseUrl: string,
  token: string,
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<HubSessionCheck> {
  let res: Awaited<ReturnType<HubTransport>>
  try {
    res = await transport({
      method: 'GET',
      url: `${baseUrl}${HUB_AUTH_PATHS.session}`,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs,
      maxResponseChars: AUTH_MAX_CHARS
    })
  } catch {
    return { state: 'unreachable' }
  }
  if (res.status === 401 || res.status === 403) return { state: 'expired' }
  if (res.status !== 200) return { state: 'unreachable' }
  const body = parseJson(res.text)
  if (body === undefined) return { state: 'unreachable' }
  const user = (body as { user?: { email?: unknown } } | null)?.user
  if (!user) return { state: 'expired' }
  return { state: 'valid', email: typeof user.email === 'string' ? user.email : null }
}
