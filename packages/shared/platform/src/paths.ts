import { mkdirSync } from 'node:fs'
import { getSlayzoneHomeDir } from './dirs'
import { LOOPBACK_HOSTS, parseHubAddress } from './hub-addr'

let warnedHost: string | null = null

/**
 * The single storage dir for all SlayZone state (DB, artifacts, backups, logs,
 * diagnostics) — `<ROOT>` itself, flat, no `storage/` subfolder. `SLAYZONE_ROOT`
 * is the ONLY env var in this chain; there is deliberately no dir- or
 * file-pointing override to thread across processes — each process derives the
 * same path from ROOT.
 *
 * Flat by design: a root belongs to exactly one role (hub or runner, standalone
 * or channel-scoped), so a `storage/` layer separating "this role's data" from
 * "everything else in the root" has nothing left to separate from — everything
 * under `<ROOT>` already is this role's own storage. Kept the function name
 * (documents intent at call sites) even though it's no longer a distinct
 * subdirectory. NOTE: this flattening is NOT migrated for existing standalone
 * installs — see `channel-storage-migration.ts` for the supervised-only
 * migration and the plan's explicit breaking-change note for standalone.
 *
 * getSlayzoneHomeDir resolves ROOT (`SLAYZONE_ROOT` > platform home); the
 * standalone entrypoints seed `SLAYZONE_ROOT=cwd`, the desktop app seeds it to
 * a channel-scoped root via `getSupervisedRoot`.
 */
export function getStorageDir(): string {
  return getSlayzoneHomeDir()
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
 * The port range every SlayZone hub binds within
 * (plans/hub-lifecycle-and-discovery.md, Phase 3).
 *
 * Multi-hub discovery (`slay hub ls`) works by probing loopback ports for a
 * `/health` answer — no pidfile, no registry, nothing that can go stale. That
 * only works if a hub is FINDABLE, so hubs draw from this known block instead of
 * letting the OS assign an arbitrary ephemeral port. Still inside IANA's
 * dynamic/private range (49152–65535).
 */
export const HUB_PORT_BLOCK = { start: 51100, end: 51199 } as const

/**
 * The sub-range a hub picks from when no port was configured.
 *
 * Starts ABOVE {@link SIDECAR_FIXED_PORT} so a standalone hub can never squat
 * the port a supervised sidecar expects to bind — the supervised ports are fixed
 * precisely so a bind failure is loud and unambiguous, which a squatter would
 * turn back into a mystery. 51103–51109 stay spare for future fixed roles.
 */
export const HUB_DYNAMIC_PORT_RANGE = { start: 51110, end: 51199 } as const

/**
 * Bind `server` to the first free port in the hub block, returning that port.
 *
 * Walks the range sequentially, treating `EADDRINUSE` as "taken, try the next"
 * and anything else as a real failure to propagate (a bad bind host would
 * otherwise burn ~90 pointless retries). Exhausting the range throws, naming the
 * range — with no free port there is no correct fallback: an OS-assigned port
 * would boot a hub that discovery can never find.
 *
 * Sequential rather than parallel-probe-then-bind on purpose: probing and binding
 * as one step leaves no window for another process to take the port in between.
 *
 * @param server any `net`/`http`/`https` server (only listen/close/error used).
 * @param host   the bind host, as resolved by {@link getServerHost}.
 * @param range  defaults to {@link HUB_DYNAMIC_PORT_RANGE}.
 */
export async function bindInHubPortBlock(
  server: {
    listen: (port: number, host: string, cb: () => void) => unknown
    once: (event: string, cb: (err: Error) => void) => unknown
    off: (event: string, cb: (err: Error) => void) => unknown
  },
  host: string,
  range: { start: number; end: number } = HUB_DYNAMIC_PORT_RANGE
): Promise<number> {
  for (let port = range.start; port <= range.end; port++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('error', onError)
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve(false)
        else reject(err)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve(true)
      })
    })
    if (bound) return port
  }
  throw new Error(
    `[slayzone] no free port in the hub block ${range.start}-${range.end} on ${host} — ` +
      `every port is taken. Stop an unused hub (\`slay hub ls\`) or set ` +
      `SLAYZONE_HUB_ADDRESS to a specific port.`
  )
}

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
