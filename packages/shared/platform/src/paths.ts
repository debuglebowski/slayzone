import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSlayzoneHomeDir } from './dirs'
import { LOOPBACK_HOSTS, parseHubAddress } from './hub-addr'

let warnedHost: string | null = null

/**
 * The single storage dir for all SlayZone state (DB, artifacts, backups, logs,
 * diagnostics). DERIVED from `SLAYZONE_ROOT` as `<ROOT>/storage` — one anchor,
 * one on-disk shape on every machine. `SLAYZONE_ROOT` is the ONLY env var in
 * this chain; there is no separate `SLAYZONE_STORE_DIR`/`SLAYZONE_DB_PATH` to
 * thread across processes — each process derives the same path from ROOT.
 *
 * getSlayzoneHomeDir resolves ROOT (`SLAYZONE_ROOT` > platform home); the
 * standalone entrypoints seed `SLAYZONE_ROOT=cwd`, the desktop app seeds it to
 * the migrated location.
 */
export function getStorageDir(): string {
  return join(getSlayzoneHomeDir(), 'storage')
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
 * The port the hub should BIND, from `SLAYZONE_HUB_ADDRESS` (`host[:port]`), or
 * undefined when the var is unset/malformed or names no port. Callers fall back
 * to a stored or OS-assigned port when undefined.
 *
 * PORT GRAMMAR: a bare host (`127.0.0.1`) names no port → undefined → the caller
 * lets the OS assign one. An explicit `:0` says the same outright and returns 0.
 */
export function getTrpcPort(): number | undefined {
  return parseHubAddress(process.env.SLAYZONE_HUB_ADDRESS)?.port
}

/**
 * The host the hub should BIND, from `SLAYZONE_HUB_ADDRESS`. Defaults to
 * 127.0.0.1 (also when the var is unset or malformed — a bad address must not
 * silently widen the bind). Warns once on stderr when bound to a non-loopback
 * address.
 */
export function getServerHost(): string {
  const host = parseHubAddress(process.env.SLAYZONE_HUB_ADDRESS)?.host || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host) && warnedHost !== host) {
    warnedHost = host
    console.warn(
      `[slayzone] SLAYZONE_HUB_ADDRESS binds the local server to ${host}, a non-loopback address. ` +
        `Anyone on the network can reach it. Use 127.0.0.1 unless you have a reason.`
    )
  }
  return host
}
