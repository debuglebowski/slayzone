/**
 * A signed-in hub's REST API (`/api/*`), for what its tRPC socket can't carry: file bytes
 * both ways and the artifact content search. Same bearer the socket uses (a full session
 * from sign-in), sent as `Authorization: Bearer`; the hub's REST gate accepts exactly
 * that (`hub/src/rest-auth.ts`). The URL derives from the hub's sign-in address the way
 * the socket's does (`hubUrlFromAddr`: loopback → http, anything else → https).
 *
 * Answers are the API's envelope, `{ ok: true, data }` or `{ ok: false, error, code? }`;
 * a failure becomes a `HubRestError` whose message the app can show as it is.
 */
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import type { HubSession } from '../hub-session'

/** One hub, as the REST calls need it. */
export interface HubTarget {
  /** The federation's id of the hub (`hubEntryOf`). */
  hubId: string
  /** What the app calls it: its address. */
  label: string
  /** `host[:port]`, as signed in to. */
  address: string
  token: string
}

export function hubTarget(session: HubSession): HubTarget {
  return {
    hubId: session.entry.id,
    label: session.entry.label,
    address: session.entry.label,
    token: session.token
  }
}

export type QueryValue = string | number | boolean | null | undefined

/** `https://<hub>/<path>?<query>`; `true` is sent as `1`, `false`/null/undefined not at all. */
export function hubApiUrl(
  target: HubTarget,
  path: string,
  query: Record<string, QueryValue> = {}
): string {
  // Encoded by hand: React Native's URLSearchParams is a partial polyfill.
  const search = Object.entries(query)
    .flatMap(([key, value]) =>
      value === undefined || value === null || value === false
        ? []
        : [`${encodeURIComponent(key)}=${encodeURIComponent(value === true ? '1' : String(value))}`]
    )
    .join('&')
  return hubUrlFromAddr(target.address, 'http', search ? `${path}?${search}` : path)
}

export function authHeaders(target: HubTarget): Record<string, string> {
  return { authorization: `Bearer ${target.token}` }
}

/** A failed REST call: `status` null = no answer at all. */
export class HubRestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null = null
  ) {
    super(message)
    this.name = 'HubRestError'
  }
}

export const signInExpired = (target: HubTarget): HubRestError =>
  new HubRestError(`Your sign-in to ${target.label} has expired. Sign in again.`, 401)

export const unreachable = (target: HubTarget, cause: unknown): HubRestError =>
  new HubRestError(
    `Can't reach ${target.label} (${cause instanceof Error ? cause.message : String(cause)})`,
    null
  )

/** The subset of `fetch` the calls use (React Native's global, or a test's fake). */
export type HubFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    credentials: 'omit'
    signal?: AbortSignal
  }
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

/**
 * The envelope of a hub answer: its `data`, or a `HubRestError` (401 = sign in again; the
 * hub's own `error`/`code`; else the status).
 */
export function readEnvelope<T>(target: HubTarget, status: number, text: string): T {
  if (status === 401) throw signInExpired(target)
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON (a proxy's error page): reported by status below.
  }
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  if (status >= 200 && status < 300 && envelope?.ok === true) return envelope.data as T
  if (envelope && typeof envelope.error === 'string') {
    throw new HubRestError(
      envelope.error,
      status,
      typeof envelope.code === 'string' ? envelope.code : null
    )
  }
  throw new HubRestError(`${target.label} answered HTTP ${status}`, status)
}

/** GET a JSON route of the hub and return its envelope's `data`. */
export async function hubJson<T>(
  target: HubTarget,
  path: string,
  options: { query?: Record<string, QueryValue>; fetch?: HubFetch; signal?: AbortSignal } = {}
): Promise<T> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as HubFetch)
  const url = hubApiUrl(target, path, options.query)
  let res: Awaited<ReturnType<HubFetch>>
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: authHeaders(target),
      credentials: 'omit',
      signal: options.signal
    })
  } catch (err) {
    if (options.signal?.aborted) throw err
    throw unreachable(target, err)
  }
  return readEnvelope<T>(target, res.status, await res.text())
}
