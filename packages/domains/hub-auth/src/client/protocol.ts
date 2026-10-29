/**
 * The hub's sign-in routes as a client sees them: paths, client ids, response caps, and
 * the JSON helpers every exchange shares.
 *
 * `baseUrl` everywhere in this client is the hub's http(s) origin, optionally with a path
 * prefix, never a trailing slash (`https://hub.example.com`, `http://127.0.0.1:4400`).
 * Routes are appended by string (`${baseUrl}${path}`) so a prefix survives.
 */
import type { HubHttpResponse, HubTransport } from './transport'

/** Routes the sign-in client calls (better-auth's under `/api/auth`, plus the hub's `/health`). */
export const HUB_AUTH_PATHS = {
  health: '/health',
  signInEmail: '/api/auth/sign-in/email',
  deviceCode: '/api/auth/device/code',
  deviceToken: '/api/auth/device/token',
  session: '/api/auth/get-session'
} as const

/**
 * The device-sign-in client ids (RFC 8628 `client_id`) the hub accepts; its approval page
 * names the client. Must match the hub's `DEVICE_CLIENTS` allowlist
 * (`src/server/device.ts`) — a test pins that.
 */
export const HUB_DEVICE_CLIENT_IDS = {
  cli: 'slayzone-cli',
  desktop: 'slayzone-desktop'
} as const

export type HubDeviceClientId = (typeof HUB_DEVICE_CLIENT_IDS)[keyof typeof HUB_DEVICE_CLIENT_IDS]

/** RFC 8628 §3.4 `grant_type` of a device token poll. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** `/health` bodies are tiny (< 1 KiB). */
export const HEALTH_MAX_CHARS = 4096
/** Sign-in answers (tokens, errors, session). */
export const AUTH_MAX_CHARS = 65536

/** Default timeout of one sign-in exchange. */
export const AUTH_TIMEOUT_MS = 10_000

/** The body as JSON, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The body as a JSON object; anything else (not JSON, null, a scalar) reads as `{}`. */
export function jsonObject(text: string): Record<string, unknown> {
  const parsed = parseJson(text)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** `value` when it is a string, else undefined. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** POST a JSON body to `url`. */
export function postJson(
  transport: HubTransport,
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<HubHttpResponse> {
  return transport({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
    maxResponseChars: AUTH_MAX_CHARS
  })
}
