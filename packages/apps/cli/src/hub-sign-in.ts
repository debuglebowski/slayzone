/**
 * How `slay hub login` talks to a hub's sign-in routes (better-auth, `/api/auth/*`).
 *
 * NOT `fetch` FOR THE POSTS. Node's fetch (undici) adds `Sec-Fetch-Mode: cors` to every
 * request. better-auth reads Fetch Metadata as "a browser sent this" and then demands an
 * `Origin` it trusts — so the CLI's password sign-in was refused `403
 * MISSING_OR_NULL_ORIGIN` on every hub, main included. The CLI is not a browser and has
 * no cookie: a plain `http(s).request` carries neither, which is better-auth's non-browser
 * path (the desktop app's `hubLogin` has always signed in this way). The hub still
 * refuses a cookie-carrying request without an Origin.
 *
 * DEVICE SIGN-IN (T-14). On a hub with Entra sign-in (`/health` → `switches.enableSso`)
 * the CLI never handles a password: it asks the hub for a device code (RFC 8628),
 * prints the hub's page and the code, opens a browser when this machine has one, and
 * polls until the person approved on that page after signing in through Entra (with
 * MFA). Works over SSH on a Cloud Device: the page opens on any other device.
 *
 * @module cli/hub-sign-in
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { fail } from './service'

/** The client id this CLI identifies as (the hub's approval page names it). */
export const CLI_DEVICE_CLIENT_ID = 'slayzone-cli'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * POST JSON to a hub with a plain HTTP client (no Fetch Metadata, no cookie) and answer
 * a standard `Response`. Rejects only when the hub cannot be reached.
 */
export function postAuthJson(url: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
  const payload = JSON.stringify(body)
  const request = url.startsWith('https:') ? https.request : http.request
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
              headers.append(name, v)
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }))
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    req.end(payload)
  })
}

/** How a hub lets people sign in, from its `/health` switches. */
export interface HubSignInMethods {
  /** Entra sign-in on: the CLI uses device sign-in. */
  sso: boolean
  /** Email + password sign-in on. A hub too old to say is treated as password-only. */
  password: boolean
}

export async function readSignInMethods(baseUrl: string): Promise<HubSignInMethods> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) })
  } catch {
    fail(`Could not reach the hub at ${baseUrl}.`)
  }
  const health = (await res.json().catch(() => ({}))) as {
    switches?: { enableSso?: unknown; enablePassword?: unknown }
  }
  return {
    sso: health.switches?.enableSso === true,
    password: health.switches?.enablePassword !== false
  }
}

/**
 * Open `url` in this machine's browser, when it has one. Best effort and silent: the
 * URL is printed either way. Not over SSH (the browser would open on the far machine's
 * desktop, if anywhere) and not on a Linux box without a display.
 */
function tryOpenBrowser(url: string): void {
  if (!/^https?:\/\//.test(url)) return
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return
  let command: string
  let args: string[]
  if (process.platform === 'darwin') [command, args] = ['open', [url]]
  else if (process.platform === 'win32') {
    ;[command, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]]
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    ;[command, args] = ['xdg-open', [url]]
  } else return
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      // No opener installed: the printed URL is the way.
    })
    child.unref()
  } catch {
    // No opener: the printed URL is the way.
  }
}

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Device sign-in: returns the hub bearer once the person approved in a browser, or
 * exits with what went wrong (denied, expired, disabled account).
 */
export async function deviceSignIn(
  baseUrl: string,
  opts: { openBrowser: boolean; clientId?: string }
): Promise<string> {
  const clientId = opts.clientId ?? CLI_DEVICE_CLIENT_ID
  let res: Response
  try {
    res = await postAuthJson(`${baseUrl}/api/auth/device/code`, { client_id: clientId })
  } catch {
    fail(`Could not reach the hub at ${baseUrl}.`)
  }
  const code = (await res.json().catch(() => ({}))) as Partial<DeviceCode> & {
    error_description?: unknown
  }
  if (!res.ok || !code.device_code || !code.user_code || !code.verification_uri) {
    fail(
      `The hub did not start a sign-in (HTTP ${res.status})` +
        (typeof code.error_description === 'string' ? `: ${code.error_description}` : '.')
    )
  }
  const page = code.verification_uri_complete ?? code.verification_uri
  const userCode = `${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`
  const minutes = Math.round((code.expires_in ?? 600) / 60)
  console.log('To sign in, open this page in a browser (on any device) and approve:')
  console.log(`  ${page}`)
  console.log(`Check that the page shows this code: ${userCode}  (valid ${minutes} min)`)
  if (opts.openBrowser) tryOpenBrowser(page)
  console.log('Waiting for approval…')

  // RFC 8628 §3.5: wait `interval` between polls, 5s more after each `slow_down`.
  let intervalMs = Math.max(5, code.interval ?? 5) * 1000
  const deadline = Date.now() + (code.expires_in ?? 600) * 1000
  while (Date.now() < deadline + intervalMs) {
    await sleep(intervalMs)
    let poll: Response
    try {
      poll = await postAuthJson(`${baseUrl}/api/auth/device/token`, {
        grant_type: DEVICE_GRANT,
        device_code: code.device_code,
        client_id: clientId
      })
    } catch {
      // A blip (hub restart, network) is not the end of a 10-minute window.
      continue
    }
    const body = (await poll.json().catch(() => ({}))) as {
      access_token?: unknown
      error?: unknown
      error_description?: unknown
      code?: unknown
    }
    if (poll.ok && typeof body.access_token === 'string' && body.access_token) {
      return body.access_token
    }
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (body.error === 'access_denied') fail('Sign-in was denied in the browser.')
    if (body.error === 'expired_token') {
      fail('The code expired before it was approved. Run `slay hub login` again.')
    }
    if (body.code === 'ACCOUNT_DISABLED') {
      fail('Sign-in refused: this account is disabled on the hub. Ask a hub admin to enable it.')
    }
    fail(
      `Sign-in failed (HTTP ${poll.status})` +
        (typeof body.error_description === 'string' ? `: ${body.error_description}` : '.')
    )
  }
  fail('The code expired before it was approved. Run `slay hub login` again.')
}

/** The email of the account a bearer belongs to, or null. */
export async function signedInEmail(baseUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
    const body = (await res.json().catch(() => null)) as { user?: { email?: unknown } } | null
    return typeof body?.user?.email === 'string' ? body.user.email : null
  } catch {
    return null
  }
}
