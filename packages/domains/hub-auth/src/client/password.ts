/**
 * Email + password sign-in: POST `/api/auth/sign-in/email` (better-auth) for a bearer.
 * The bearer plugin returns the token in the `set-auth-token` response header; a `token`
 * field in the body is accepted too. The route is gate-exempt on the hub — it has to be
 * reachable without a credential.
 */
import {
  AUTH_TIMEOUT_MS,
  HUB_AUTH_PATHS,
  jsonObject,
  parseJson,
  postJson,
  stringOf
} from './protocol'
import {
  type HubHttpResponse,
  type HubTransport,
  isHubTransportTimeout,
  transportErrorText
} from './transport'

export type HubPasswordSignInResult =
  | { ok: true; token: string }
  | {
      ok: false
      /**
       * `unreachable` / `timeout`: no answer. `refused`: HTTP ≥ 400. `no-token`: accepted
       * but no token in the header or body. `bad-response`: no token header and a body
       * that is not JSON.
       */
      reason: 'unreachable' | 'timeout' | 'refused' | 'no-token' | 'bad-response'
      /** The HTTP status, when the hub answered. */
      status?: number
      /** `refused`: the body's `code` (`HUB_PASSWORD_DISABLED`, `ACCOUNT_DISABLED`, …). */
      code?: string
      /** `refused`: the body's `error` text, when it is a string. */
      hubError?: string
      /** What to show. */
      error: string
    }

export async function signInWithPassword(
  transport: HubTransport,
  baseUrl: string,
  credentials: { email: string; password: string },
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<HubPasswordSignInResult> {
  let res: HubHttpResponse
  try {
    res = await postJson(
      transport,
      `${baseUrl}${HUB_AUTH_PATHS.signInEmail}`,
      { email: credentials.email, password: credentials.password },
      timeoutMs
    )
  } catch (err) {
    return isHubTransportTimeout(err)
      ? { ok: false, reason: 'timeout', error: `Sign-in timed out after ${timeoutMs}ms` }
      : { ok: false, reason: 'unreachable', error: transportErrorText(err) }
  }
  const { status } = res
  if (status >= 400) {
    const body = jsonObject(res.text)
    return {
      ok: false,
      reason: 'refused',
      status,
      code: stringOf(body.code),
      hubError: stringOf(body.error),
      error: `Sign-in failed (HTTP ${status})`
    }
  }
  const headerToken = res.header('set-auth-token')
  if (headerToken) return { ok: true, token: headerToken }
  const body = parseJson(res.text)
  if (body === null || body === undefined) {
    return { ok: false, reason: 'bad-response', status, error: 'Bad sign-in response' }
  }
  const token = (body as { token?: unknown }).token
  if (typeof token === 'string' && token) return { ok: true, token }
  return { ok: false, reason: 'no-token', status, error: 'Hub returned no token' }
}
