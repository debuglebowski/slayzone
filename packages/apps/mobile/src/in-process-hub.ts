/**
 * A hub served inside the app instead of over the network: the demo hub
 * (`demo/demo-hub.ts`) is one. It sits behind the SAME client paths a real hub does,
 * so every screen runs unchanged against it:
 *
 * - tRPC: `link`, a terminating link (`inProcessLink`) that `HubConnections` hands
 *   the federation for this hub (`FederationProvider`'s `inProcessLinks`): no socket,
 *   always connected.
 * - REST (`/api/*`, the account's `get-session`): `http`, answering the requests a
 *   hub's HTTP server would. The app's REST calls (`artifacts/hub-rest.ts`, file
 *   downloads, uploads, `hubs/use-hub-account.ts`) send to it instead of `fetch` /
 *   the OS downloader when their hub has one.
 *
 * A session to such a hub is never kept in the keychain (`HubSession.inProcess`).
 */
import type { HubTransport } from '@slayzone/hub-auth/client'
import type { RuntimeLink } from '@slayzone/transport/client'

export interface InProcessHttpRequest {
  method: 'GET' | 'POST'
  /** The full URL the request would go to (`hubApiUrl`): the hub reads its path + query. */
  url: string
  headers: Record<string, string>
  /** A POST's raw body (an upload's bytes, a JSON text). */
  body?: Uint8Array | string
}

export interface InProcessHttpResponse {
  status: number
  /** Text (JSON envelopes) or bytes (file content). */
  body: string | Uint8Array
}

/** The hub's HTTP API, in process. */
export type InProcessHttp = (request: InProcessHttpRequest) => Promise<InProcessHttpResponse>

export interface InProcessHub {
  link: RuntimeLink
  http: InProcessHttp
}

/** A response body as text (bytes decoded as UTF-8). */
export function bodyText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body)
}

/** A response body as bytes (text encoded as UTF-8). */
export function bodyBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body
}

/** The `fetch` subset the REST calls use (`hub-rest.ts`'s `HubFetch`), over `http`. */
export function fetchOver(http: InProcessHttp) {
  return async (
    url: string,
    init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
  ): Promise<{ status: number; ok: boolean; text(): Promise<string> }> => {
    if (init.signal?.aborted) throw new Error('Aborted')
    const res = await http({
      method: init.method === 'POST' ? 'POST' : 'GET',
      url,
      headers: init.headers
    })
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      text: async () => bodyText(res.body)
    }
  }
}

/** hub-auth's transport (`fetchSessionEmail`, …) over `http`. */
export function hubTransportOver(http: InProcessHttp): HubTransport {
  return async (request) => {
    const res = await http({
      method: request.method === 'POST' ? 'POST' : 'GET',
      url: request.url,
      headers: { ...request.headers },
      body: request.body
    })
    return {
      status: res.status,
      header: () => null,
      text: bodyText(res.body).slice(0, request.maxResponseChars)
    }
  }
}
