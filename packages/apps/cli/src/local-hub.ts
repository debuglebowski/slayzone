/**
 * Find the LOCAL supervised hub (the desktop app's sidecar) without touching a
 * database.
 *
 * WHY THIS EXISTS. Every `slay` command needs one thing before it can do anything:
 * the port the hub listens on. Historically the only answer for the desktop app's
 * sidecar was `settings.server_port` in the SQLite file — the sidecar took an
 * OS-assigned ephemeral port, so the loopback block sweep (`discoverHubs`, which
 * covers HUB_PORT_BLOCK) could not see it. That single lookup is the entire reason
 * the CLI opened a database at all, and it made `slay` depend on deriving the app's
 * on-disk layout — a rule that has to stay in lockstep with the app's own
 * supervised-root derivation forever, and which broke outright the moment
 * supervised state moved to `~/.slayzone/<channel>/<role>`.
 *
 * The sidecar now binds a FIXED port per channel (`SIDECAR_FIXED_PORT`, in the
 * reserved head of the hub block), so the answer is a compile-time constant. One
 * loopback `/health` probe replaces the file read: no DB, no layout rule, and
 * nothing that can go stale — a dead hub's port simply stops answering, whereas a
 * stale `settings.server_port` row happily names a port nobody is on.
 *
 * Deliberately DB-free and dependency-light: it imports only the lean
 * `hub-discovery` leaf (no better-sqlite3 graph), so it stays importable on a
 * hub-only box that has no SlayZone database — the case `openDb()`'s uncatchable
 * `process.exit(1)` makes impossible to handle.
 *
 * @module cli/local-hub
 */
import path from 'node:path'
import { SIDECAR_FIXED_PORT } from '@slayzone/platform/paths'
import { LOOPBACK_HOSTS } from '@slayzone/platform/hub-addr'
import { findHub } from '@slayzone/platform/hub-discovery'
import { resolveHubTarget } from './hub-config'

/**
 * The fixed port THIS invocation's channel expects the sidecar on.
 *
 * Keyed on `SLAYZONE_DEV`, the same bit that used to pick the database FILENAME
 * (`slayzone.dev.sqlite` vs `slayzone.sqlite`) — so `slay` and `slay --dev` keep
 * targeting the same two installs they always did, just addressed by port instead
 * of by file. The app sets it from `app.isPackaged` when it spawns the sidecar, and
 * it is `global`-scoped in the env manifest, so a task terminal inherits it.
 */
export function fixedPortForChannel(): number {
  return process.env.SLAYZONE_DEV === '1' ? SIDECAR_FIXED_PORT.dev : SIDECAR_FIXED_PORT.prod
}

/**
 * The root THIS invocation belongs to, when it can be known.
 *
 * `SLAYZONE_ROOT` is `global`-scoped in the env manifest, so — unlike
 * `SLAYZONE_HUB_ADDRESS`, which is `infra` and therefore stripped by
 * `sanitizeSpawnEnv` at every pty boundary — it survives into a task terminal.
 * That makes it the one identity signal a `slay` running inside an app-spawned
 * terminal still holds, and the only thing that can tell the app it belongs to
 * apart from a DIFFERENT app answering the same fixed port.
 *
 * Null for a plain user shell that was never spawned by an app. There is no
 * expectation to violate there, so the probe is accepted: the failure this
 * guards is a shell that belongs to app A silently acting on app B.
 */
function expectedRoot(): string | null {
  const root = process.env.SLAYZONE_ROOT?.trim()
  return root ? path.resolve(root) : null
}

/** Outcome of probing this channel's fixed port. */
export type FixedPortProbe =
  /** A hub answered and it is ours (or we had no expectation to check). `root` +
   *  `supervised` let a caller decide whether to fall back to the on-box owner
   *  credential (`hub.owner.json`) — only meaningful for a standalone hub. */
  | { kind: 'found'; port: number; root: string; supervised: boolean }
  /** Nothing hub-shaped answered. */
  | { kind: 'absent' }
  /** A hub answered, but it serves a different root — refuse, never downgrade. */
  | { kind: 'foreign'; port: number; root: string; expected: string }

/**
 * Probe this channel's fixed port, returning it when OUR hub answers there.
 *
 * `findHub` with an all-digits argument probes that port DIRECTLY (no sweep) and
 * validates the `/health` body is hub-shaped — but hub-shaped only proves it is
 * *a* hub, not *the* hub. A fixed port is a well-known address, so anything on
 * this machine that binds it answers: most sharply, an e2e worker's `slay` (whose
 * own address was stripped at the spawn boundary) probes this port and reaches the
 * developer's live app, then mutates its real data.
 *
 * So the identity is verified too. `/health` already reports `root` over loopback;
 * a mismatch is reported rather than silently dialled, for the same reason
 * `resolveTarget` refuses to downgrade a configured-but-unreachable hub to the
 * local app: quietly acting on a different target applies the command to the
 * wrong data.
 */
export async function probeFixedPort(): Promise<FixedPortProbe> {
  const port = fixedPortForChannel()
  const hub = await findHub(String(port))
  if (!hub) return { kind: 'absent' }
  const expected = expectedRoot()
  if (expected && path.resolve(hub.root) !== expected) {
    return { kind: 'foreign', port: hub.port, root: hub.root, expected }
  }
  return { kind: 'found', port: hub.port, root: hub.root, supervised: hub.supervised }
}

/**
 * Whether the hub this invocation talks to runs on THIS machine.
 *
 * The one question a filesystem path depends on. Only `slay tasks artifacts path`
 * asks it: every other command deals in data the hub owns, which is
 * location-independent, while a path is meaningless off the box that holds it.
 *
 * No configured hub means we resolved the local app by probing loopback, so it is
 * co-located by construction. A configured hub counts when its host is loopback.
 *
 * Known limit: a loopback address forwarded to another host (`ssh -L`) reads as
 * co-located. Distinguishing that would require proving a remote root exists here,
 * which no answer from the hub can establish — and a forwarded hub is a deliberate
 * act, unlike the accidental "printed my own path for someone else's artifact" this
 * prevents.
 */
export async function isCoLocatedHub(): Promise<boolean> {
  const configured = resolveHubTarget()
  if (!configured) return true
  try {
    // `URL.hostname` KEEPS the brackets on an IPv6 literal (`[::1]`), while
    // LOOPBACK_HOSTS stores the bare form (`::1`) — comparing them directly reads
    // an IPv6 loopback hub as off-box and refuses a path that is in fact local.
    const host = new URL(configured.baseUrl).hostname.replace(/^\[|\]$/g, '')
    return LOOPBACK_HOSTS.has(host)
  } catch {
    return false
  }
}
