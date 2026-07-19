import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSlayzoneHomeDir } from './dirs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
let warnedHost: string | null = null

/**
 * The single storage dir for all SlayZone state (DB, artifacts, backups, logs,
 * diagnostics). DERIVED from `SLAYZONE_ROOT` as `<ROOT>/storage` — one anchor,
 * one on-disk shape on every machine. `SLAYZONE_ROOT` is the ONLY env var in
 * this chain; there is no separate `SLAYZONE_STORE_DIR`/`SLAYZONE_DB_PATH` to
 * thread across processes — each process derives the same path from ROOT.
 *
 * `SLAYZONE_STORE_DIR` is honored ONLY as an explicit operator/e2e override
 * (unset in normal use). getSlayzoneHomeDir resolves ROOT (`SLAYZONE_ROOT` >
 * `SLAYZONE_HOME_DIR` > platform home); the standalone entrypoints seed
 * `SLAYZONE_ROOT=cwd`, the desktop app seeds it to the migrated location.
 */
export function getStorageDir(): string {
  return process.env.SLAYZONE_STORE_DIR?.trim() || join(getSlayzoneHomeDir(), 'storage')
}

/**
 * Root for all SlayZone state — `getStorageDir()` with a mkdir side-effect so
 * better-sqlite3 finds the dir. The `ensure` prefix flags the side-effect.
 */
export function ensureDataRoot(): string {
  const dir = getStorageDir()
  mkdirSync(dir, { recursive: true })
  return dir
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
