/**
 * Non-clobber guard for `settings.server_port` (plans/sidecar-staleness.md,
 * Phase 4).
 *
 * Every sidecar that boots used to overwrite this key unconditionally — so any
 * one-off process pointed at a live DB (a manual smoke test, a stray standalone
 * launch) silently redirected the CLI/agents away from the real, running
 * backend. Fixed per-environment ports (see @slayzone/platform's
 * SIDECAR_FIXED_PORT) remove the ambiguity for the normal supervised path, but
 * don't stop a rogue process from clobbering the key if it opens the same DB.
 * This guard closes that gap: before writing, check whether the CURRENTLY
 * stored port still answers /health — if something is genuinely alive there,
 * refuse the write and log loudly rather than silently redirecting discovery.
 */
import http from 'node:http'

type MinimalDb = {
  get: (sql: string) => Promise<{ value?: string } | undefined>
  prepare: (sql: string) => { run: (...params: unknown[]) => Promise<unknown> }
}

/** Socket-inactivity budget. A dead port refuses at once, so only a listener that
 *  accepted waits it out — and a live-but-busy sidecar (big txn, loaded box) can
 *  stall /health for hundreds of ms. The old 300ms read that as dead and clobbered
 *  the key, the exact redirect this guard exists to stop. Same rationale as
 *  hub-discovery's DEFAULT_TIMEOUT_MS. */
const LIVENESS_TIMEOUT_MS = 3_000

function isPortAlive(
  host: string,
  port: number,
  timeoutMs = LIVENESS_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

export async function claimServerPort(
  db: MinimalDb,
  host: string,
  actualPort: number,
  log: (line: string) => void
): Promise<void> {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'server_port'")
    const existingPort = row?.value ? Number(row.value) : null
    if (existingPort && existingPort !== actualPort && (await isPortAlive(host, existingPort))) {
      log(
        `[server_port] refusing to overwrite ${existingPort} with ${actualPort} — ` +
          `the stored port still answers /health (a live sidecar already owns it)`
      )
      return
    }
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('server_port', ?)")
      .run(String(actualPort))
  } catch {
    /* non-fatal — CLI falls back to its default port */
  }
}
