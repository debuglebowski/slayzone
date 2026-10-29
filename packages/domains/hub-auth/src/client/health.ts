/**
 * A hub's `GET /health`: is it up, must a client sign in, and how. Deliberately
 * unauthenticated and public on the hub (apps/hub `health.ts`) — a client has to learn
 * it needs a token before it has one.
 *
 * One read ({@link fetchHubHealth}), three readings of it, because three clients ask
 * different questions:
 *   - {@link healthProbeOf} — "can I add this hub?" (desktop's Settings probe): strict,
 *     a non-200 or a body that is not a SlayZone `/health` is an error.
 *   - {@link signInMethodsOf} — "how do I sign in?" (CLI `slay hub login`): any body.
 *   - {@link hubBrowserSignInOf} — the web shell's pre-boot question, FAILS CLOSED.
 */
import { HEALTH_MAX_CHARS, HUB_AUTH_PATHS, parseJson } from './protocol'
import { type HubTransport, isHubTransportTimeout, transportErrorText } from './transport'

/** How a hub lets a native client (desktop, CLI, mobile) sign in, from its `/health` switches. */
export interface HubSignInMethods {
  /** Entra sign-in on: the client uses device sign-in (browser + MFA). */
  sso: boolean
  /** Email + password sign-in on. */
  password: boolean
}

export type HubHealthRead =
  | {
      reachable: false
      reason: 'unreachable' | 'timeout'
      /** What to show: the transport's error, or `Health check timed out after <ms>ms`. */
      error: string
    }
  | {
      reachable: true
      status: number
      /** The body as JSON; undefined when it is not JSON. */
      json: unknown
    }

/** GET `/health`. Any HTTP answer is `reachable` — the readings below judge it. */
export async function fetchHubHealth(
  transport: HubTransport,
  baseUrl: string,
  timeoutMs: number
): Promise<HubHealthRead> {
  try {
    const res = await transport({
      method: 'GET',
      url: `${baseUrl}${HUB_AUTH_PATHS.health}`,
      headers: {},
      timeoutMs,
      maxResponseChars: HEALTH_MAX_CHARS
    })
    return { reachable: true, status: res.status, json: parseJson(res.text) }
  } catch (err) {
    return isHubTransportTimeout(err)
      ? {
          reachable: false,
          reason: 'timeout',
          error: `Health check timed out after ${timeoutMs}ms`
        }
      : { reachable: false, reason: 'unreachable', error: transportErrorText(err) }
  }
}

/**
 * The sign-in methods `/health`'s switches report, or undefined when the body has no
 * switches (a hub too old to report them — treat it as password-only).
 */
export function signInMethodsOf(health: unknown): HubSignInMethods | undefined {
  if (health === null || health === undefined) return undefined
  const switches = (health as { switches?: unknown }).switches
  if (!switches) return undefined
  const sw = switches as { enableSso?: unknown; enablePassword?: unknown }
  return { sso: sw.enableSso === true, password: sw.enablePassword !== false }
}

export type HubHealthProbe =
  | {
      ok: true
      /** Whether the hub gates its client API on a bearer. UNDEFINED when the hub is too
       *  old to report it — "unknown", not "no auth needed". */
      authRequired?: boolean
      /** Undefined when the hub is too old to report its switches (treat as password-only). */
      signIn?: HubSignInMethods
    }
  | { ok: false; error: string; authRequired?: boolean }

/** The strict reading of one `/health` answer. Pure. */
export function healthProbeOf(status: number, json: unknown): HubHealthProbe {
  if (status !== 200) return { ok: false, error: `Server answered HTTP ${status}` }
  if (json === null || json === undefined) {
    return { ok: false, error: 'Not a SlayZone server (bad /health body)' }
  }
  const body = json as { ok?: unknown; authRequired?: unknown }
  // `authRequired` is served to every caller, so it survives an off-box probe — the case
  // that matters, since an off-box hub is the one that gates. Absent on older hubs → left
  // undefined rather than coerced to false.
  const authRequired = typeof body.authRequired === 'boolean' ? body.authRequired : undefined
  if (body.ok === true) return { ok: true, authRequired, signIn: signInMethodsOf(json) }
  return { ok: false, error: 'Server is not ready', authRequired }
}

/** Probe a hub before adding it: {@link fetchHubHealth} + {@link healthProbeOf}. */
export async function probeHubHealth(
  transport: HubTransport,
  baseUrl: string,
  timeoutMs = 5000
): Promise<HubHealthProbe> {
  const read = await fetchHubHealth(transport, baseUrl, timeoutMs)
  if (!read.reachable) return { ok: false, error: read.error }
  return healthProbeOf(read.status, read.json)
}

/** What a hub offers a BROWSER (the web shell, before it has any credential). */
export interface HubBrowserSignIn {
  /** Must this browser sign in before it connects? */
  authRequired: boolean
  /** Sign-in methods the hub offers a browser. */
  methods: { password: boolean; sso: boolean }
}

/** The fail-closed answer: sign-in required, no method offered (the screen says to reload). */
export const HUB_BROWSER_SIGN_IN_UNKNOWN: HubBrowserSignIn = {
  authRequired: true,
  methods: { password: false, sso: false }
}

/**
 * The browser reading of a 200 `/health` body. FAILS CLOSED: only an explicit
 * `authRequired: false` skips sign-in. Password sign-in when `enablePassword` is on;
 * "Sign in with Microsoft" only where the hub serves it to browsers (`enableSso` with
 * `requireLogin`, the hub's `ssoActive`). Pure.
 */
export function hubBrowserSignInOf(health: unknown): HubBrowserSignIn {
  if (health === null || health === undefined) return HUB_BROWSER_SIGN_IN_UNKNOWN
  const body = health as {
    authRequired?: unknown
    switches?: { requireLogin?: unknown; enablePassword?: unknown; enableSso?: unknown }
  }
  const sw = body.switches ?? {}
  return {
    authRequired: body.authRequired !== false,
    methods: {
      password: sw.enablePassword !== false,
      sso: sw.enableSso === true && sw.requireLogin === true
    }
  }
}
