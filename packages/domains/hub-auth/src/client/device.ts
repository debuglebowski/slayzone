/**
 * Device sign-in (RFC 8628, T-14) — how a client signs in to a hub with Entra sign-in
 * without ever handling a password: ask the hub for a device code, show the person the
 * hub's `/device` page and the code, and poll until they approved there (after signing in
 * through Entra with MFA). Works when the page is opened on another device.
 *
 * Hub side: `src/server/device.ts` (codes live 10 minutes, poll every 5s).
 */
import {
  AUTH_TIMEOUT_MS,
  DEVICE_CODE_GRANT_TYPE,
  HUB_AUTH_PATHS,
  jsonObject,
  postJson,
  stringOf
} from './protocol'
import {
  type HubHttpResponse,
  type HubTransport,
  isHubTransportTimeout,
  transportErrorText
} from './transport'

export interface HubDeviceCode {
  deviceCode: string
  /** As the person reads it, `ABCD-EFGH`. */
  userCode: string
  /** The page to open (with the code filled in when the hub offers that). */
  verificationUri: string
  expiresInSec: number
  /** Seconds between polls, at least 5. */
  intervalSec: number
}

export type HubDeviceCodeResult =
  | ({ ok: true } & HubDeviceCode)
  | {
      ok: false
      /** `unreachable` / `timeout`: no answer. `refused`: not a 200 with a usable code. */
      reason: 'unreachable' | 'timeout' | 'refused'
      /** `refused`: the HTTP status. */
      status?: number
      /** `refused`: the body's `error_description`, when it is a string (may be empty). */
      description?: string
      /** What to show. */
      error: string
    }

/** Ask a hub for a device code, as `clientId` (see `HUB_DEVICE_CLIENT_IDS`). */
export async function requestDeviceCode(
  transport: HubTransport,
  baseUrl: string,
  clientId: string,
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<HubDeviceCodeResult> {
  let res: HubHttpResponse
  try {
    res = await postJson(
      transport,
      `${baseUrl}${HUB_AUTH_PATHS.deviceCode}`,
      { client_id: clientId },
      timeoutMs
    )
  } catch (err) {
    return {
      ok: false,
      reason: isHubTransportTimeout(err) ? 'timeout' : 'unreachable',
      error: transportErrorText(err)
    }
  }
  const j = jsonObject(res.text)
  const deviceCode = stringOf(j.device_code) ?? ''
  const userCode = stringOf(j.user_code) ?? ''
  const page = stringOf(j.verification_uri_complete) || stringOf(j.verification_uri) || ''
  if (res.status !== 200 || !deviceCode || !userCode || !page) {
    const description = stringOf(j.error_description)
    return {
      ok: false,
      reason: 'refused',
      status: res.status,
      description,
      error: `The hub did not start a sign-in (HTTP ${res.status})${description ? `: ${description}` : ''}`
    }
  }
  return {
    ok: true,
    deviceCode,
    userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
    verificationUri: page,
    expiresInSec: typeof j.expires_in === 'number' ? j.expires_in : 600,
    intervalSec: typeof j.interval === 'number' ? Math.max(5, j.interval) : 5
  }
}

/**
 * True when the approval page is on the hub's own host — the only page a client should
 * open in the browser by itself. Anything else is shown for the person to judge.
 */
export function isHubOwnPage(baseUrl: string, page: string): boolean {
  try {
    const target = new URL(page)
    return (
      (target.protocol === 'https:' || target.protocol === 'http:') &&
      target.host === new URL(baseUrl).host
    )
  } catch {
    return false
  }
}

export type HubDeviceTokenResult =
  | { ok: true; token: string }
  | {
      ok: false
      /**
       * `cancelled`: `signal` stopped the wait. `denied`: refused in the browser.
       * `expired`: the code ran out (the hub said so, or its lifetime passed).
       * `disabled`: the account is disabled on the hub. `failed`: any other answer.
       */
      reason: 'cancelled' | 'denied' | 'expired' | 'disabled' | 'failed'
      /** The HTTP status of the poll that ended the wait, when one did. */
      status?: number
      /** `failed`: the body's `error_description`, when it is a string (may be empty). */
      description?: string
      /** What to show. */
      error: string
    }

export interface DeviceTokenWaitOptions {
  /** Stops the wait, checked after each pause (an `AbortController`'s `signal`). */
  signal?: { readonly aborted: boolean }
  /** Pauses between polls (tests pass a recorder). */
  sleep?: (ms: number) => Promise<void>
  /** Clock for the code's expiry (tests). */
  now?: () => number
}

/** Time allowed for one token poll. */
const POLL_TIMEOUT_MS = 10_000
/** RFC 8628 §3.5: each `slow_down` adds 5 seconds to the interval. */
const SLOW_DOWN_STEP_MS = 5000

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poll until the person approved (→ the bearer), denied, or the code expired. RFC 8628
 * §3.5: wait `interval` between polls, 5s more after each `slow_down`. A poll that cannot
 * reach the hub (restart, network blip) is retried until the code's own expiry.
 */
export async function waitForDeviceToken(
  transport: HubTransport,
  baseUrl: string,
  clientId: string,
  code: Pick<HubDeviceCode, 'deviceCode' | 'expiresInSec' | 'intervalSec'>,
  opts: DeviceTokenWaitOptions = {}
): Promise<HubDeviceTokenResult> {
  const tokenUrl = `${baseUrl}${HUB_AUTH_PATHS.deviceToken}`
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  let intervalMs = code.intervalSec * 1000
  const deadline = now() + code.expiresInSec * 1000
  while (now() < deadline + intervalMs) {
    await sleep(intervalMs)
    if (opts.signal?.aborted) return { ok: false, reason: 'cancelled', error: 'Sign-in cancelled' }
    let res: HubHttpResponse
    try {
      res = await postJson(
        transport,
        tokenUrl,
        { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: code.deviceCode, client_id: clientId },
        POLL_TIMEOUT_MS
      )
    } catch {
      continue
    }
    const { status } = res
    const body = jsonObject(res.text)
    const { error, access_token: token } = body
    if (status === 200 && typeof token === 'string' && token) return { ok: true, token }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_MS
      continue
    }
    if (error === 'access_denied') {
      return { ok: false, reason: 'denied', status, error: 'Sign-in was denied in the browser' }
    }
    if (error === 'expired_token') {
      return { ok: false, reason: 'expired', status, error: 'The sign-in code expired' }
    }
    if (body.code === 'ACCOUNT_DISABLED') {
      return {
        ok: false,
        reason: 'disabled',
        status,
        error: 'This account is disabled on the hub'
      }
    }
    const description = stringOf(body.error_description)
    return {
      ok: false,
      reason: 'failed',
      status,
      description,
      error: `Sign-in failed (HTTP ${status})${description === undefined ? '' : `: ${description}`}`
    }
  }
  return { ok: false, reason: 'expired', error: 'The sign-in code expired' }
}
