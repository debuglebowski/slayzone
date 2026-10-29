// `@slayzone/hub-auth/client-node` — the Node transport for the hub sign-in client
// (`@slayzone/hub-auth/client`): desktop main and the CLI. A separate entry so the
// client entry stays free of `node:*` (React Native, browsers).
//
// NOT Node's `fetch`. undici adds `Sec-Fetch-Mode: cors` to every request; better-auth
// reads Fetch Metadata as "a browser sent this" and then demands an `Origin` it trusts —
// so a sign-in over `fetch` is refused `403 MISSING_OR_NULL_ORIGIN` on every hub. A plain
// `http(s).request` carries neither Fetch Metadata nor a cookie: better-auth's
// non-browser path (the hub still refuses a cookie-carrying request without an Origin).
import http from 'node:http'
import https from 'node:https'
import { type HubTransport, HubTransportTimeoutError } from '../client'

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * Plain `http(s).request`. `timeoutMs` is the socket's idle timeout; redirects are not
 * followed; `content-length` is added for a body.
 */
export const nodeHubTransport: HubTransport = (request) =>
  new Promise((resolve, reject) => {
    const send = request.url.startsWith('https:') ? https.request : http.request
    const headers: Record<string, string | number> = { ...request.headers }
    if (request.body !== undefined) headers['content-length'] = Buffer.byteLength(request.body)
    const req = send(
      request.url,
      { method: request.method, timeout: request.timeoutMs, headers },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (text.length < request.maxResponseChars) text += chunk
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            header: (name) => firstValue(res.headers[name.toLowerCase()]),
            text
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new HubTransportTimeoutError(request.timeoutMs)))
    req.end(request.body)
  })
