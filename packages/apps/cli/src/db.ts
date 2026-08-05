/**
 * Telling the app that something changed, and finding it in order to do so.
 *
 * WHAT THIS MODULE IS NOT, ANYMORE: it used to open the SlayZone SQLite database.
 * That is gone — the CLI reads and writes every piece of domain state over the
 * hub's REST surface, so it no longer derives a storage directory, no longer needs
 * `SLAYZONE_ROOT` to be correct, and behaves the same in a laptop shell, an agent
 * terminal, and on a hub-only box with no app installed. `openDb`/`getDbPath`/
 * `getArtifactsDir` and the `node:sqlite` import are deleted rather than deprecated;
 * the last consumer (`slay tasks artifacts path`) now reads `filePath` off
 * `GET /api/artifacts/:id`.
 *
 * Nothing here resolves `SLAYZONE_ROOT` either: the two genuinely MACHINE-local
 * files that remain (the hub pointer, the `<kind>-runtime` npm prefix) moved to the
 * CLI's own state dir — see cli-state.ts.
 *
 * The filename is now a misnomer and kept only to avoid churning every import in
 * one go; what survives is app NOTIFICATION.
 *
 * @module cli/db
 */
import http from 'node:http'
import { SIDECAR_FIXED_PORT } from '@slayzone/platform/paths'
import { findHub } from '@slayzone/platform/hub-discovery'
import { resolveHubTarget, type HubTarget } from './hub-config'
import { probeFixedPort } from './local-hub'
export { resolveProjectArg } from './db-helpers.mjs'

export function postJson(port: number, path: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      res.resume()
      res.on('end', () => {
        const code = res.statusCode ?? 0
        resolve(code >= 200 && code < 300)
      })
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/**
 * The OTHER channel's fixed port, when a hub answers there.
 *
 * Powers the "you are pointed at the wrong install" hint below. Previously this
 * opened the other channel's SQLite file to read its `settings.server_port`; asking
 * the port directly is both DB-free and strictly more accurate — a stored port can
 * name a process that died, while a `/health` answer proves something is alive.
 */
async function probeAlternateChannel(): Promise<number | null> {
  const dev = process.env.SLAYZONE_DEV === '1'
  const altPort = dev ? SIDECAR_FIXED_PORT.prod : SIDECAR_FIXED_PORT.dev
  const hub = await findHub(String(altPort))
  return hub ? hub.port : null
}

async function postHubNotify(hub: HubTarget, timeoutMs = 3000): Promise<boolean> {
  try {
    const headers: Record<string, string> = hub.token
      ? { Authorization: `Bearer ${hub.token}` }
      : {}
    const res = await fetch(`${hub.baseUrl}/api/notify`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch {
    return false
  }
}

export async function notifyApp(): Promise<void> {
  const hub = resolveHubTarget()
  if (hub) {
    const ok = await postHubNotify(hub)
    if (!ok) {
      console.error(
        'Warning: hub notify failed (POST /api/notify) — hub may be stale or unreachable'
      )
    }
    return
  }

  // Same channel as api.ts's resolveTarget: this channel's fixed port.
  const port = await probeFixedPort()
  if (port) {
    const ok = await postJson(port, '/api/notify')
    if (!ok) {
      console.error(
        'Warning: app notify failed (POST /api/notify) — app may be stale or unreachable'
      )
    }
    return
  }

  // Nothing on this channel's port — is the app running on the OTHER channel?
  const altPort = await probeAlternateChannel()
  if (altPort) {
    const dev = process.env.SLAYZONE_DEV === '1'
    const hint = dev ? 'without --dev' : 'with --dev'
    console.error(
      `Warning: SlayZone app is running ${hint}. Changes were saved but the app was not notified.`
    )
    console.error(`  Re-run ${dev ? 'without --dev' : 'with --dev'} to target the same database.`)
  }
}

