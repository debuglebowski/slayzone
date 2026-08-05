import { probeFixedPort } from './local-hub'
import { resolveHubTarget } from './hub-config'

interface ApiTarget {
  baseUrl: string
  token: string | null
  hub: boolean
}

/**
 * Hub when configured (env or cli-hub-target.json), otherwise the local app.
 *
 * Both channels are DB-free. An explicitly configured hub is read from env/file;
 * the local app is found by probing its fixed per-channel port — one loopback
 * `/health`, no storage path derived, nothing that can go stale. The CLI used to
 * read `settings.server_port` out of SQLite here, which is what forced it to know
 * the app's on-disk layout and made a plain shell break whenever that layout moved.
 *
 * A hub that is configured but unreachable is NOT silently downgraded to the local
 * app: the caller named a target, and quietly acting on a different one would apply
 * their command to the wrong data.
 */
async function resolveTarget(): Promise<ApiTarget> {
  const hub = resolveHubTarget()
  if (hub) return { baseUrl: hub.baseUrl, token: hub.token, hub: true }
  const port = await probeFixedPort()
  if (!port) {
    console.error('SlayZone server port not found. Is the app running?')
    process.exit(1)
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token: null, hub: false }
}

function withAuth(init: RequestInit | undefined, token: string | null): RequestInit | undefined {
  if (!token) return init
  const headers = new Headers(init?.headers)
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

function connectError(target: ApiTarget): never {
  if (target.hub) {
    console.error(`Could not connect to SlayZone hub at ${target.baseUrl}.`)
  } else {
    console.error('SlayZone is not running (could not connect to app).')
  }
  process.exit(1)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const target = await resolveTarget()
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}${path}`, withAuth(init, target.token))
  } catch {
    connectError(target)
  }
  if (!res.ok) {
    await failFromResponse(res)
  }
  return res.json() as Promise<T>
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function apiPatch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function apiDelete<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  if (body === undefined) return request<T>(path, { method: 'DELETE' })
  return request<T>(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** Raw fetch for SSE/streaming — returns the Response directly. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const target = await resolveTarget()
  try {
    return await fetch(`${target.baseUrl}${path}`, withAuth(init, target.token))
  } catch {
    connectError(target)
  }
}

/**
 * GET whose response BODY is raw bytes, not JSON — artifact content.
 *
 * Kept apart from {@link apiGet} because the two failure shapes differ: a
 * non-2xx here still carries a JSON `{ error }`, but a SUCCESS must not be
 * parsed or stringified at all. `read` writes these bytes straight to stdout and
 * `download` to a file, and an artifact can be a PNG or a PDF — routing them
 * through a JS string would utf-8-decode every invalid sequence into U+FFFD.
 * The returned stream is consumed by the caller (pipeline → stdout / file), so
 * nothing buffers the whole artifact in memory.
 */
export async function apiGetStream(
  path: string,
  /**
   * Machine-readable `code` values in the route's error payload that the caller
   * handles itself instead of exiting. Returns `{ code }` (no body) for those, so
   * a caller can fork on the CONDITION rather than on the human message text.
   */
  passThroughCodes: string[] = []
): Promise<{ body: ReadableStream<Uint8Array> | null; code?: string }> {
  const target = await resolveTarget()
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}${path}`, withAuth(undefined, target.token))
  } catch {
    connectError(target)
  }
  if (!res.ok) {
    if (passThroughCodes.length > 0) {
      const body = await res.text().catch(() => '')
      let code: string | undefined
      try {
        code = (JSON.parse(body) as { code?: string }).code
      } catch {
        /* not JSON — fall through to the normal failure path */
      }
      if (code && passThroughCodes.includes(code)) return { body: null, code }
      await failFromText(body, res.status)
    }
    await failFromResponse(res)
  }
  return { body: res.body }
}

/**
 * POST/PUT whose request BODY is raw bytes — artifact create / upload / write /
 * append. Parameters ride the query string precisely because the body is the
 * content (same binary-safety reason as {@link apiGetStream}, in the other
 * direction).
 *
 * `duplex: 'half'` is mandatory for a streaming request body in undici.
 */
async function requestStream<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: ReadableStream<Uint8Array>
): Promise<T> {
  const target = await resolveTarget()
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}${path}`, {
      ...withAuth(
        {
          method,
          headers: { 'Content-Type': 'application/octet-stream' },
          body
        },
        target.token
      ),
      // Not in the DOM RequestInit type; required by undici for a stream body.
      duplex: 'half'
    } as RequestInit)
  } catch {
    connectError(target)
  }
  if (!res.ok) {
    await failFromResponse(res)
  }
  return res.json() as Promise<T>
}

export function apiPostStream<T>(path: string, body: ReadableStream<Uint8Array>): Promise<T> {
  return requestStream<T>('POST', path, body)
}

/** PUT counterpart of {@link apiPostStream} — `artifacts write` replaces content. */
export function apiPutStream<T>(path: string, body: ReadableStream<Uint8Array>): Promise<T> {
  return requestStream<T>('PUT', path, body)
}

/** Print a failed response's `{ error }` (or body/status) and exit 1. */
async function failFromResponse(res: Response): Promise<never> {
  return failFromText(await res.text().catch(() => ''), res.status)
}

function failFromText(body: string, status: number): never {
  let msg = `HTTP ${status}`
  try {
    msg = (JSON.parse(body) as { error?: string }).error ?? msg
  } catch {
    if (body) msg = body
  }
  console.error(msg)
  process.exit(1)
}
