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
