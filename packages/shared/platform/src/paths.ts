import { mkdirSync } from 'node:fs'
import { getStateDir } from './dirs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
let warnedHost: string | null = null

/**
 * Root for all SlayZone state (DB, artifacts, project-icons, backups,
 * Electron internal data). Honors SLAYZONE_STORE_DIR override; otherwise
 * falls back to the platform default from getStateDir().
 *
 * mkdir's the dir before returning so better-sqlite3 + Electron both find it.
 * The `ensure` prefix flags this side-effect — pure read is `getStateDir()`.
 */
export function ensureDataRoot(): string {
  const dir = process.env.SLAYZONE_STORE_DIR || getStateDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Returns the local server port from SLAYZONE_SERVER_PORT, or undefined if
 * unset/invalid. The local server hosts MCP, REST API, and (slice 2+) tRPC
 * on a single port. Callers should fall back to a stored or auto-assigned
 * port when undefined.
 */
export function getServerPort(): number | undefined {
  const raw = process.env.SLAYZONE_SERVER_PORT
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * Fixed per-environment sidecar ports (plans/sidecar-staleness.md, Phase 4).
 *
 * One supervised sidecar per environment ever runs at a time (packaged app:
 * Electron single-instance-lock; dev: one interactive `pnpm dev`; e2e: single
 * Playwright worker, `fullyParallel: false` — see playwright.config.ts). A
 * fixed port per environment turns "which sidecar is the CLI even talking to"
 * from a DB-write race into a known constant, and turns a stray second
 * instance into a loud `EADDRINUSE` at bind time instead of silent ambiguity
 * (unlike a lock FILE, a bound TCP port can't go stale — a dead process can't
 * hold it, so bind failure always means something else is genuinely alive).
 * IANA dynamic/private range (49152–65535) — no registered-service collision.
 */
export const SIDECAR_FIXED_PORT = {
  prod: 51100,
  dev: 51101,
  test: 51102
} as const

/**
 * Returns the tRPC server port from SLAYZONE_PORT, or undefined if unset/invalid.
 * Callers should fall back to a stored or auto-assigned port when undefined.
 */
export function getTrpcPort(): number | undefined {
  const raw = process.env.SLAYZONE_PORT
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * Returns the host the local server should bind to. Defaults to 127.0.0.1.
 * Warns once on stderr when bound to a non-loopback address.
 */
export function getServerHost(): string {
  const host = process.env.SLAYZONE_HOST || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host) && warnedHost !== host) {
    warnedHost = host
    console.warn(
      `[slayzone] SLAYZONE_HOST=${host} binds the local server to a non-loopback address. ` +
        `Anyone on the network can reach it. Use 127.0.0.1 unless you have a reason.`
    )
  }
  return host
}
