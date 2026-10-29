/**
 * How `slay hub login` signs in to a hub: the shared hub sign-in client
 * (`@slayzone/hub-auth/client`, the same protocol code the desktop app runs) over
 * `nodeHubTransport`, plus what only a terminal does — the messages it exits with and
 * opening a browser.
 *
 * NOT `fetch`. Node's fetch (undici) adds `Sec-Fetch-Mode: cors` to every request.
 * better-auth reads Fetch Metadata as "a browser sent this" and then demands an `Origin`
 * it trusts — so the CLI's password sign-in was refused `403 MISSING_OR_NULL_ORIGIN` on
 * every hub, main included. The CLI is not a browser and has no cookie: a plain
 * `http(s).request` (`nodeHubTransport`) carries neither, which is better-auth's
 * non-browser path. The hub still refuses a cookie-carrying request without an Origin.
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
import {
  fetchHubHealth,
  fetchSessionEmail,
  HUB_DEVICE_CLIENT_IDS,
  requestDeviceCode,
  signInMethodsOf,
  signInWithPassword,
  waitForDeviceToken,
  type HubSignInMethods
} from '@slayzone/hub-auth/client'
import { nodeHubTransport } from '@slayzone/hub-auth/client-node'
import { fail } from './service'

export type { HubSignInMethods }

/** The client id this CLI identifies as (the hub's approval page names it). */
export const CLI_DEVICE_CLIENT_ID = HUB_DEVICE_CLIENT_IDS.cli

/**
 * How the hub lets people sign in, from its `/health` switches. Any answer counts: a hub
 * too old to report switches (or a `/health` that is not JSON) is treated as
 * password-only, and the sign-in itself then says what is wrong.
 */
export async function readSignInMethods(baseUrl: string): Promise<HubSignInMethods> {
  const health = await fetchHubHealth(nodeHubTransport, baseUrl, 10_000)
  if (!health.reachable) fail(`Could not reach the hub at ${baseUrl}.`)
  return signInMethodsOf(health.json) ?? { sso: false, password: true }
}

/**
 * Exchange an email + password for a hub bearer token via better-auth.
 *
 * Same exchange as the desktop app's `hubLogin` (both run `signInWithPassword`): POST
 * `/api/auth/sign-in/email`, the token from the `set-auth-token` response header the
 * bearer plugin sets, falling back to a `token` field in the body. That route is
 * deliberately gate-exempt (`AUTH_BOOTSTRAP_PREFIX`) — it has to be reachable without a
 * credential, or a hub could never be authenticated at all.
 */
export async function hubSignIn(baseUrl: string, email: string, password: string): Promise<string> {
  const result = await signInWithPassword(nodeHubTransport, baseUrl, { email, password })
  if (result.ok) return result.token
  if (result.reason === 'unreachable' || result.reason === 'timeout') {
    fail(`Could not reach the hub at ${baseUrl}.`)
  }
  if (result.reason === 'refused') {
    // The hub has no password sign-in at all (T-10) — say so, not "check the password".
    if (result.code === 'HUB_PASSWORD_DISABLED') {
      fail(`Sign-in refused: ${result.hubError ?? 'password sign-in is off on this hub'}`)
    }
    // Only reachable with the right password (better-auth checks it first).
    if (result.code === 'ACCOUNT_DISABLED') {
      fail(
        'Sign-in refused: this account is disabled on the hub. An operator can enable it ' +
          'with `slay hub users enable <email>`.'
      )
    }
    // better-auth answers 401 for both a wrong password and an unknown email, and
    // deliberately does not distinguish them. Name the likely fixes instead of
    // guessing which one it was.
    fail(
      `Sign-in failed (HTTP ${result.status}).\n` +
        `Check the email and password. List the accounts on the hub box with ` +
        `\`slay hub users ls\`, or create one with \`slay hub users add <email>\`.`
    )
  }
  fail('The hub accepted the sign-in but returned no token.')
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

/**
 * Device sign-in: returns the hub bearer once the person approved in a browser, or
 * exits with what went wrong (denied, expired, disabled account).
 */
export async function deviceSignIn(
  baseUrl: string,
  opts: { openBrowser: boolean; clientId?: string }
): Promise<string> {
  const clientId = opts.clientId ?? CLI_DEVICE_CLIENT_ID
  const code = await requestDeviceCode(nodeHubTransport, baseUrl, clientId)
  if (!code.ok) {
    if (code.reason !== 'refused') fail(`Could not reach the hub at ${baseUrl}.`)
    fail(
      `The hub did not start a sign-in (HTTP ${code.status})` +
        (code.description !== undefined ? `: ${code.description}` : '.')
    )
  }
  const page = code.verificationUri
  const minutes = Math.round(code.expiresInSec / 60)
  console.log('To sign in, open this page in a browser (on any device) and approve:')
  console.log(`  ${page}`)
  console.log(`Check that the page shows this code: ${code.userCode}  (valid ${minutes} min)`)
  if (opts.openBrowser) tryOpenBrowser(page)
  console.log('Waiting for approval…')

  // RFC 8628 §3.5 polling — interval, `slow_down`, retries over a network blip (a hub
  // restart is not the end of a 10-minute window) — is the shared client's.
  const result = await waitForDeviceToken(nodeHubTransport, baseUrl, clientId, code)
  if (result.ok) return result.token
  if (result.reason === 'denied') fail('Sign-in was denied in the browser.')
  if (result.reason === 'expired') {
    fail('The code expired before it was approved. Run `slay hub login` again.')
  }
  if (result.reason === 'disabled') {
    fail('Sign-in refused: this account is disabled on the hub. Ask a hub admin to enable it.')
  }
  fail(
    `Sign-in failed (HTTP ${result.status})` +
      (result.description !== undefined ? `: ${result.description}` : '.')
  )
}

/** The email of the account a bearer belongs to, or null. */
export function signedInEmail(baseUrl: string, token: string): Promise<string | null> {
  return fetchSessionEmail(nodeHubTransport, baseUrl, token)
}
