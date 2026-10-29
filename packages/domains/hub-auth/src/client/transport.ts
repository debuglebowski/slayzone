/**
 * How the sign-in client reaches a hub: an INJECTED transport, one function per HTTP
 * exchange. The client itself never names a platform HTTP API, so the same protocol code
 * runs in Node (desktop main, CLI), a browser and React Native.
 *
 * Which transport where:
 *   - Node (desktop main, CLI): `nodeHubTransport` from `@slayzone/hub-auth/client-node` —
 *     plain `http(s).request`. NOT Node's `fetch`: undici adds `Sec-Fetch-Mode: cors` to
 *     every request, better-auth reads Fetch Metadata as "a browser sent this" and then
 *     demands a trusted `Origin` → `403 MISSING_OR_NULL_ORIGIN` on every sign-in.
 *   - React Native / a browser page talking bearer-only: {@link createFetchHubTransport}
 *     over that platform's `fetch`, cookies never sent.
 */

/** One HTTP exchange with a hub, as the sign-in client needs it. */
export interface HubHttpRequest {
  method: 'GET' | 'POST'
  /** Absolute http(s) URL. */
  url: string
  /** Request headers, lower-case names. The transport adds what its platform needs to
   *  send `body` (the Node transport: `content-length`). */
  headers: Readonly<Record<string, string>>
  /** JSON text to send (POST). */
  body?: string
  /** Give up after this long without an answer: reject with {@link HubTransportTimeoutError}. */
  timeoutMs: number
  /** Keep about this many characters of the response body and drop the rest — a hub
   *  never sends more, and a mistyped URL may point at something that streams forever. */
  maxResponseChars: number
}

export interface HubHttpResponse {
  status: number
  /** First value of a response header (name case-insensitive), or null. */
  header: (name: string) => string | null
  /** The body as UTF-8 text, capped at `maxResponseChars`. */
  text: string
}

/**
 * Sends one request. Resolves with ANY HTTP answer (3xx/4xx/5xx included); rejects only
 * when the hub could not be reached — with a {@link HubTransportTimeoutError} on a timeout.
 */
export type HubTransport = (request: HubHttpRequest) => Promise<HubHttpResponse>

/** `code` of a {@link HubTransportTimeoutError}. */
export const HUB_TRANSPORT_TIMEOUT = 'HUB_TRANSPORT_TIMEOUT'

/** A transport's rejection when the hub did not answer within `timeoutMs`. */
export class HubTransportTimeoutError extends Error {
  readonly code = HUB_TRANSPORT_TIMEOUT
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`)
    this.name = 'HubTransportTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** True for a transport's timeout rejection (by `code`, so it holds across bundles). */
export function isHubTransportTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === HUB_TRANSPORT_TIMEOUT
  )
}

/** What a rejection says, for the person. */
export function transportErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The part of WHATWG `fetch` {@link createFetchHubTransport} uses (React Native's, a browser's). */
export type HubFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    credentials: 'omit'
    signal: AbortSignal
  }
) => Promise<{
  status: number
  headers: { get: (name: string) => string | null }
  text: () => Promise<string>
}>

/**
 * A transport over a platform `fetch` (React Native, a browser): no cookies
 * (`credentials: 'omit'` — a hub client signs in for a bearer), the whole exchange
 * bounded by `timeoutMs`. Not for Node: see this module's note.
 */
export function createFetchHubTransport(fetchImpl: HubFetch): HubTransport {
  return async (request) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, request.timeoutMs)
    try {
      const res = await fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        credentials: 'omit',
        signal: controller.signal
      })
      const text = await res.text()
      return {
        status: res.status,
        header: (name) => res.headers.get(name),
        text: text.slice(0, request.maxResponseChars)
      }
    } catch (err) {
      throw timedOut ? new HubTransportTimeoutError(request.timeoutMs) : err
    } finally {
      clearTimeout(timer)
    }
  }
}
