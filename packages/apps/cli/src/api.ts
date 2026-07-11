import { getMcpPort } from './db'
import { resolveHubTarget } from './hub-config'

interface ApiTarget {
  baseUrl: string
  token: string | null
  hub: boolean
}

/** Hub when configured (env or hub.json), otherwise the legacy local app. */
function resolveTarget(): ApiTarget {
  const hub = resolveHubTarget()
  if (hub) return { baseUrl: hub.baseUrl, token: hub.token, hub: true }
  const port = getMcpPort()
  if (!port) {
    console.error('SlayZone MCP port not found. Is the app running?')
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
  const target = resolveTarget()
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}${path}`, withAuth(init, target.token))
  } catch {
    connectError(target)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let msg = `HTTP ${res.status}`
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? msg
    } catch {
      if (body) msg = body
    }
    console.error(msg)
    process.exit(1)
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
  const target = resolveTarget()
  try {
    return await fetch(`${target.baseUrl}${path}`, withAuth(init, target.token))
  } catch {
    connectError(target)
  }
}
