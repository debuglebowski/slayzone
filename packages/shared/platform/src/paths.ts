import { mkdirSync } from 'node:fs'
import { getSlayzoneHomeDir } from './dirs'
import { LOOPBACK_HOSTS, parseHubAddress } from './hub-addr'
import { HUB_ADDRESS_ENV } from './hub-switches'

let warnedHost: string | null = null

/**
 * The single storage dir for all SlayZone state (DB, artifacts, backups, logs,
 * diagnostics) — `<ROOT>` itself, flat, no `storage/` subfolder. `SLAYZONE_ROOT`
 * is the ONLY env var in this chain; there is deliberately no dir- or
 * file-pointing override to thread across processes — each process derives the
 * same path from ROOT.
 *
 * Flat by design: a root belongs to exactly one role (hub or computer, standalone
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
 * The hub port block a SHIPPED build uses: 100 loopback ports in IANA's
 * dynamic/private range (49152–65535 starts below it, so: no registered-service
 * collision either way). {@link HUB_PORT_BLOCK} is this block unless a test run moved
 * it (see {@link TEST_HUB_PORT_BLOCK_START_ENV}).
 */
export const DEFAULT_HUB_PORT_BLOCK = { start: 51100, end: 51199 } as const

/**
 * TEST-ONLY seam: the first port of the hub port block, for this process tree.
 *
 * Every port below derives from the block's start, so this one var moves all of
 * them together: the desktop sidecar's fixed ports, the range standalone hubs bind
 * in, and the range `slay` sweeps. A `slay` with no hub address falls back to
 * exactly those ports (local-hub.ts `probeFixedPort`, hub-request.ts discovery) —
 * which, unmoved, are where the developer's running app listens. The test runners
 * (`isolateFromCaller`, packages/shared/test-utils/caller-env.ts) set it to a
 * throwaway block before any suite loads, so no test can reach that app through a
 * fallback, and a fallback test asserts against a stand-in on the moved port.
 *
 * Unset (every real install): the shipped block, byte-identical behaviour. Not a
 * user knob: undocumented, `infra` in ENV_MANIFEST (stripped at every terminal/agent
 * spawn), and refused when it overlaps the shipped block, so it can only ever point
 * AWAY from where real hubs run. A malformed value throws at load rather than being
 * read as unset: a test that meant to move the block must not silently run on it.
 */
export const TEST_HUB_PORT_BLOCK_START_ENV = 'SLAYZONE_TEST_HUB_PORT_BLOCK_START'

/** Ports in the block. The layout inside it (head, dynamic range) is fixed. */
const HUB_PORT_BLOCK_SIZE = DEFAULT_HUB_PORT_BLOCK.end - DEFAULT_HUB_PORT_BLOCK.start + 1

/**
 * The block start {@link TEST_HUB_PORT_BLOCK_START_ENV} names, or the shipped one when
 * it is unset. Exported for its own test; everything else reads the constants below.
 */
export function resolveHubPortBlockStart(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_HUB_PORT_BLOCK.start
  const start = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  const end = start + HUB_PORT_BLOCK_SIZE - 1
  if (!Number.isInteger(start) || start < 1024 || end > 65535) {
    throw new Error(
      `[slayzone] ${TEST_HUB_PORT_BLOCK_START_ENV}=${raw}: expected a port 1024-${65536 - HUB_PORT_BLOCK_SIZE}`
    )
  }
  if (end >= DEFAULT_HUB_PORT_BLOCK.start && start <= DEFAULT_HUB_PORT_BLOCK.end) {
    throw new Error(
      `[slayzone] ${TEST_HUB_PORT_BLOCK_START_ENV}=${raw} overlaps the shipped hub port block ` +
        `${DEFAULT_HUB_PORT_BLOCK.start}-${DEFAULT_HUB_PORT_BLOCK.end}`
    )
  }
  return start
}

const HUB_PORT_BLOCK_START = resolveHubPortBlockStart(process.env[TEST_HUB_PORT_BLOCK_START_ENV])

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
 * The head of the hub block: 51100 / 51101 / 51102 shipped.
 *
 * "One per environment" holds per OS USER: the single-instance lock is per user,
 * while loopback is shared by every user on the machine. When another user's app
 * already holds the port, the supervisor binds a fallback in
 * {@link HUB_DYNAMIC_PORT_RANGE} and `slay` finds it there by this user's hub root.
 */
export const SIDECAR_FIXED_PORT = {
  prod: HUB_PORT_BLOCK_START,
  dev: HUB_PORT_BLOCK_START + 1,
  test: HUB_PORT_BLOCK_START + 2
} as const

/**
 * The port range every SlayZone hub binds within
 * (plans/hub-lifecycle-and-discovery.md, Phase 3). {@link DEFAULT_HUB_PORT_BLOCK}
 * (51100–51199) in a shipped build.
 *
 * Multi-hub discovery (`slay hub ls`) works by probing loopback ports for a
 * `/health` answer — no pidfile, no registry, nothing that can go stale. That
 * only works if a hub is FINDABLE, so hubs draw from this known block instead of
 * letting the OS assign an arbitrary ephemeral port.
 */
export const HUB_PORT_BLOCK = {
  start: HUB_PORT_BLOCK_START,
  end: HUB_PORT_BLOCK_START + HUB_PORT_BLOCK_SIZE - 1
} as const

/**
 * The sub-range a hub picks from when no port was configured (51110–51199 shipped).
 *
 * Starts ABOVE {@link SIDECAR_FIXED_PORT} so a standalone hub can never squat
 * the port a supervised sidecar expects to bind — the supervised ports are fixed
 * precisely so a bind failure is loud and unambiguous, which a squatter would
 * turn back into a mystery. Head ports 3–9 stay spare for future fixed roles.
 */
export const HUB_DYNAMIC_PORT_RANGE = {
  start: HUB_PORT_BLOCK_START + 10,
  end: HUB_PORT_BLOCK.end
} as const

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
      `SLAYZONE_HUB_LISTEN_ADDRESS to a specific port.`
  )
}

/**
 * The port the hub should BIND, from `SLAYZONE_HUB_LISTEN_ADDRESS` (`host[:port]`), or
 * undefined when the var is unset/malformed or names no port. Callers fall back
 * to a stored or OS-assigned port when undefined.
 *
 * PORT GRAMMAR: a bare host (`127.0.0.1`) names no port → undefined → the caller
 * lets the OS assign one. An explicit `:0` says the same outright and returns 0.
 */
export function getTrpcPort(): number | undefined {
  return parseHubAddress(process.env[HUB_ADDRESS_ENV.listen])?.port
}

/**
 * The host the hub should BIND, from `SLAYZONE_HUB_LISTEN_ADDRESS`. Defaults to
 * 127.0.0.1 (also when the var is unset or malformed — a bad address must not
 * silently widen the bind). Warns once on stderr when bound to a non-loopback
 * address.
 */
export function getServerHost(): string {
  const host = parseHubAddress(process.env[HUB_ADDRESS_ENV.listen])?.host || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host) && warnedHost !== host) {
    warnedHost = host
    console.warn(
      `[slayzone] SLAYZONE_HUB_LISTEN_ADDRESS binds the local server to ${host}, a non-loopback address. ` +
        `Anyone on the network can reach it. Use 127.0.0.1 unless you have a reason.`
    )
  }
  return host
}
