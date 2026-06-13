import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'

/**
 * Pre-boot server-mode config (slice 7).
 *
 * Deliberately a tiny JSON file (`<dataRoot>/boot-config.json`) and NOT a
 * settings-table row: in remote mode the settings DB lives on the remote
 * server, so reading the mode from the DB at boot would be circular. This file
 * is the only thing the main process consults before deciding whether to start
 * the local backend at all.
 *
 * Kept free of electron imports so it stays unit-testable under plain vitest.
 */

export type ServerMode = 'local' | 'remote'

export type BootConfig = {
  server_mode: ServerMode
  /** Canonical ws(s)://host[:port]/trpc URL — normalized on write. */
  remote_server_url?: string
}

export type BootSettingsPatch = {
  server_mode?: ServerMode
  remote_server_url?: string
}

export type HealthProbeResult = {
  ok: boolean
  /** Canonical ws(s) URL derived from the probed input — present when input parsed. */
  normalizedUrl?: string
  error?: string
}

const FILE_NAME = 'boot-config.json'

/**
 * Canonicalizes user input to `ws(s)://host[:port]/trpc`. Accepts http(s) and
 * ws(s) schemes (http→ws, https→wss), forces the path, strips query + hash.
 * Returns null when the input is not a usable URL.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const scheme =
    url.protocol === 'http:' || url.protocol === 'ws:'
      ? 'ws'
      : url.protocol === 'https:' || url.protocol === 'wss:'
        ? 'wss'
        : null
  if (!scheme || !url.hostname) return null
  return `${scheme}://${url.host}/trpc`
}

/** Maps the canonical ws URL to the server's GET /health endpoint. */
export function toHealthUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Reads the pre-boot config; any missing/corrupt/invalid state falls back to local. */
export function readBootConfig(dir: string): BootConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8'))
  } catch {
    return { server_mode: 'local' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { server_mode: 'local' }
  const obj = parsed as Record<string, unknown>
  if (obj.server_mode !== 'local' && obj.server_mode !== 'remote') {
    return { server_mode: 'local' }
  }
  const config: BootConfig = { server_mode: obj.server_mode }
  if (typeof obj.remote_server_url === 'string') {
    const normalized = normalizeRemoteUrl(obj.remote_server_url)
    if (normalized) config.remote_server_url = normalized
  }
  return config
}

/**
 * Merges a partial update into the existing config and writes it atomically
 * (tmp + rename — a crash mid-write must never leave a half-written file that
 * `readBootConfig` would then silently coerce to local). Throws on an
 * unnormalizable URL so callers surface the validation error instead of
 * persisting garbage.
 */
export function writeBootSettings(dir: string, patch: BootSettingsPatch): BootConfig {
  const next: BootConfig = { ...readBootConfig(dir) }
  if (patch.server_mode !== undefined) next.server_mode = patch.server_mode
  if (patch.remote_server_url !== undefined) {
    const normalized = normalizeRemoteUrl(patch.remote_server_url)
    if (!normalized) throw new Error(`Invalid remote server URL: ${patch.remote_server_url}`)
    next.remote_server_url = normalized
  }
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE_NAME)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, target)
  return next
}

/**
 * Probes a remote server's GET /health from the MAIN process. Runs here (not
 * a renderer fetch) because the renderer CSP floor only allows loopback WS
 * origins and /health sets no CORS headers — and because pre-TrpcProvider
 * surfaces (RemoteConfigScreen) need it before any client exists.
 */
export function probeRemoteHealth(rawUrl: string, timeoutMs = 5000): Promise<HealthProbeResult> {
  const normalizedUrl = normalizeRemoteUrl(rawUrl)
  if (!normalizedUrl) {
    return Promise.resolve({ ok: false, error: 'Invalid URL — use http(s):// or ws(s)://host[:port]' })
  }
  const healthUrl = toHealthUrl(normalizedUrl)
  const get = healthUrl.startsWith('https:') ? https.get : http.get
  return new Promise((resolve) => {
    const req = get(healthUrl, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        // /health bodies are tiny; cap defensively against a misconfigured URL
        // pointing at something that streams forever.
        if (body.length < 4096) body += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, normalizedUrl, error: `Server answered HTTP ${res.statusCode}` })
          return
        }
        try {
          const parsed = JSON.parse(body) as { ok?: boolean }
          if (parsed.ok === true) resolve({ ok: true, normalizedUrl })
          else resolve({ ok: false, normalizedUrl, error: 'Server is not ready' })
        } catch {
          resolve({ ok: false, normalizedUrl, error: 'Not a SlayZone server (bad /health body)' })
        }
      })
    })
    req.on('error', (err) => resolve({ ok: false, normalizedUrl, error: String(err.message ?? err) }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, normalizedUrl, error: `Health check timed out after ${timeoutMs}ms` })
    })
  })
}
