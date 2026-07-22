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
import net from 'node:net'
import { resolveRunnerPort } from './runner-listener.js'

type MinimalDb = {
  get: (sql: string) => Promise<{ value?: string } | undefined>
  prepare: (sql: string) => { run: (...params: unknown[]) => Promise<unknown> }
}

function isPortAlive(host: string, port: number, timeoutMs = 300): Promise<boolean> {
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

/**
 * TCP-level liveness — the runner listener is a raw TLS/wss upgrade server with no
 * HTTP `/health` route (that lives on the shared http server), so its non-clobber
 * guard probes "is anything listening on this port?" via a plain TCP connect
 * rather than `/health` (mcp's guard). A successful connect ⇒ a live listener
 * owns the port; a refused/timed-out connect ⇒ safe to (re)claim.
 */
function isTcpPortAlive(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs })
    const done = (alive: boolean): void => {
      socket.destroy()
      resolve(alive)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
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

/**
 * Resolve the port the `/runners` TLS listener should REQUEST to bind, so it stays
 * STABLE across reboots (Wave3.5-D5). This is the root fix for the orphaned-
 * local-runner bug: the runner keys its credential file by hub host+PORT
 * (`hubHostFromUrl` → `host_port`), so a fresh OS-assigned port every boot minted
 * a new credential filename → the runner couldn't `hello` with prior creds →
 * re-enrolled as a NEW row. Pinning the port keeps the `wss://host:<port>/runners`
 * URL — and thus the credential key — identical run-to-run, so the runner
 * reconnects into its existing row.
 *
 * Precedence:
 *   1. explicit `SLAYZONE_HUB_RUNNER_TRANSPORT_PORT` env  — operator override, always wins
 *   2. persisted `settings.runner_transport_port` — the previously-claimed stable port
 *   3. `0` — no stored port yet ⇒ bind OS-assigned, then `claimRunnerServerPort`
 *      persists whatever the OS handed us so the NEXT boot reuses it
 *
 * Returns 0 (OS-assigned) whenever neither source yields a valid port, matching
 * `resolveRunnerPort`'s own fallback. Never throws — a read failure degrades to 0.
 */
export async function resolveDesiredRunnerPort(
  db: MinimalDb,
  runnerPortEnv: string | undefined
): Promise<number> {
  // Operator override wins outright (mirrors the env-first precedence server.ts
  // already applied to SLAYZONE_HUB_RUNNER_TRANSPORT_PORT). A malformed override falls to 0 via
  // resolveRunnerPort rather than silently reusing a stored value.
  if (runnerPortEnv !== undefined && runnerPortEnv !== '') return resolveRunnerPort(runnerPortEnv)
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'runner_transport_port'")
    const stored = row?.value ? Number(row.value) : null
    if (stored !== null && Number.isInteger(stored) && stored >= 1 && stored <= 65535) {
      return stored
    }
  } catch {
    /* fall through to OS-assigned */
  }
  return 0
}

/**
 * Persist the runner listener's actually-bound port to `settings.runner_transport_port`
 * so the next boot reuses it (via `resolveDesiredRunnerPort`) — the persistence
 * half of the claim-once-and-persist pattern. Mirrors `claimServerPort`'s
 * non-clobber guard: before overwriting a DIFFERENT stored port, probe whether it
 * is still live (a TCP listener answering) and, if so, refuse + log loudly rather
 * than silently repointing enrolling runners at a port some other hub owns.
 *
 * A same-value write is a harmless no-op REPLACE (the common reuse path — we
 * bound the port we asked for). Never throws — a write failure just means the
 * next boot claims fresh again (degrades to today's behavior, not a crash).
 *
 * `force` bypasses the non-clobber guard. It is set ONLY when the caller has
 * ALREADY tried and FAILED to bind the stored port and fell back to a fresh
 * OS-assigned one. In that case the stored port is stale/foreign (something else
 * holds it — which is exactly WHY the pinned bind failed), so the stored value
 * MUST be replaced with the port we actually bound. Without `force` the guard
 * would see the conflicting process's still-live listener and refuse — churning
 * the runner URL (and thus the runner credential key) on EVERY boot, i.e. the
 * re-enroll bug this whole change exists to kill. The distinction the guard
 * draws: "don't clobber a port we're happily using" (default) vs "we couldn't
 * bind the stored port, we're deliberately re-claiming a new one" (`force`).
 */
export async function claimRunnerServerPort(
  db: MinimalDb,
  host: string,
  actualPort: number,
  log: (line: string) => void,
  opts: { force?: boolean } = {}
): Promise<void> {
  try {
    if (!opts.force) {
      const row = await db.get("SELECT value FROM settings WHERE key = 'runner_transport_port'")
      const existingPort = row?.value ? Number(row.value) : null
      if (existingPort && existingPort !== actualPort && (await isTcpPortAlive(host, existingPort))) {
        log(
          `[runner_transport_port] refusing to overwrite ${existingPort} with ${actualPort} — ` +
            `the stored port still has a live listener (another hub already owns it)`
        )
        return
      }
    }
    await db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('runner_transport_port', ?)")
      .run(String(actualPort))
  } catch {
    /* non-fatal — the next boot falls back to an OS-assigned runner port */
  }
}
