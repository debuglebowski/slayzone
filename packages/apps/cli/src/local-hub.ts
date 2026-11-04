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
import { HUB_DYNAMIC_PORT_RANGE, SIDECAR_FIXED_PORT } from '@slayzone/platform/paths'
import { LOOPBACK_HOSTS } from '@slayzone/platform/hub-addr'
import {
  currentOsUser,
  findFirstHub,
  findHub,
  type DiscoveredHub
} from '@slayzone/platform/hub-discovery'
import { resolveTaskCommandTarget } from './hub-config'

/**
 * The fixed port THIS invocation's channel expects the sidecar on.
 *
 * Keyed on `SLAYZONE_DEV`, the same bit that used to pick the database FILENAME
 * (`slayzone.dev.sqlite` vs `slayzone.sqlite`, now `slayzone.dev.data.sqlite` vs
 * `slayzone.data.sqlite`) — so `slay` and `slay --dev` keep
 * targeting the same two installs they always did, just addressed by port instead
 * of by file. The app sets it from `app.isPackaged` when it spawns the sidecar, and
 * it is `global`-scoped in the env manifest, so a task terminal inherits it.
 */
export function fixedPortForChannel(dev: boolean = isDevChannel()): number {
  return dev ? SIDECAR_FIXED_PORT.dev : SIDECAR_FIXED_PORT.prod
}

/** `slay --dev`, or a terminal the dev app spawned — see {@link fixedPortForChannel}. */
function isDevChannel(): boolean {
  return process.env.SLAYZONE_DEV === '1'
}

/**
 * What makes a local hub OURS on a channel — or null when nothing can tell, in which
 * case whatever answers the fixed port is accepted, as it always was.
 *
 *   - `root`: `SLAYZONE_ROOT` is set and names the app this invocation belongs to.
 *     It is `global`-scoped in the env manifest, so — unlike `SLAYZONE_HUB_ADDRESS`,
 *     which is `infra` and therefore stripped by `sanitizeSpawnEnv` at every pty
 *     boundary — it survives into a task terminal. It belongs to the CURRENT channel
 *     only, so for the other channel (the "is the app running with/without --dev?"
 *     hint) it says nothing.
 *   - `user`: a plain user shell (no `SLAYZONE_ROOT`) — this OS user's app on the
 *     channel. Every user on the machine shares one loopback, so whoever started first
 *     holds the channel's fixed port; `/health` reports the OS user a hub runs as and
 *     whether it is the dev build, which tells this user's app from theirs without
 *     the CLI deriving the app's on-disk layout.
 */
type HubIdentity = { kind: 'root'; root: string } | { kind: 'user'; user: string; dev: boolean }

function identityFor(dev: boolean): HubIdentity | null {
  const own = process.env.SLAYZONE_ROOT?.trim()
  if (own) return dev === isDevChannel() ? { kind: 'root', root: path.resolve(own) } : null
  const user = currentOsUser()
  return user ? { kind: 'user', user, dev } : null
}

/** Human-readable "what we were looking for", for the refusal message. */
function describeIdentity(id: HubIdentity): string {
  return id.kind === 'root'
    ? id.root
    : `the SlayZone ${id.dev ? 'dev ' : ''}app of OS user "${id.user}"`
}

/**
 * Is the hub on the channel's FIXED port ours? A hub too old to report its user is
 * given the benefit of the doubt — the pre-existing behaviour — since nothing in its
 * answer can tell.
 */
function ownsFixedPort(hub: DiscoveredHub, id: HubIdentity): boolean {
  if (id.kind === 'root') return path.resolve(hub.root) === id.root
  return hub.user === null || hub.user === id.user
}

/** Is a hub found ELSEWHERE in the block ours? Strict: every bit must match, since a
 *  sweep sees every hub on the machine (standalone ones, the other channel's app). */
function isOursElsewhere(hub: DiscoveredHub, id: HubIdentity): boolean {
  if (id.kind === 'root') return path.resolve(hub.root) === id.root
  return hub.supervised && hub.dev === id.dev && hub.user === id.user
}

/** Outcome of looking for this invocation's local app hub. */
export type LocalHubProbe =
  /** A hub answered and it is ours (or we had no expectation to check). `root` +
   *  `authRequired` let a caller decide whether to fall back to the on-box owner
   *  credential (`hub.owner.json`) — only meaningful for a hub that requires login. */
  | { kind: 'found'; port: number; root: string; authRequired: boolean }
  /** Nothing hub-shaped answered. */
  | { kind: 'absent' }
  /** A hub answered on the fixed port, but it is not ours, and ours is nowhere in the
   *  fallback range — refuse, never downgrade. `expected` describes what ours is. */
  | { kind: 'foreign'; port: number; root: string; expected: string }

export interface LocalHubProbeOptions {
  /** Channel to look for. Default: this invocation's (`SLAYZONE_DEV`). */
  dev?: boolean
  /** The channel's fixed port. Tests pass a port they own. */
  port?: number
  /** Where a displaced app hub may be. Default {@link HUB_DYNAMIC_PORT_RANGE}, the
   *  range the app's supervisor falls back to. Tests pass a range they own. */
  range?: { start: number; end: number }
}

/**
 * Find this invocation's local app hub, returning it only when it is OURS.
 *
 * First the channel's fixed port. `findHub` with an all-digits argument probes that
 * port DIRECTLY (no sweep) and validates the `/health` body is hub-shaped — but
 * hub-shaped only proves it is *a* hub, not *the* hub. A fixed port is a well-known
 * address, so anything on this machine that binds it answers: an e2e worker's `slay`
 * (whose own address was stripped at the spawn boundary) reaching the developer's
 * live app, or — on a Mac several people use — another user's app. So the identity
 * is verified against what `/health` reports over loopback (see {@link identityFor}).
 *
 * Not ours there (or nothing there) ⇒ sweep the supervisor's fallback range for our
 * hub: when another user's app already held the fixed port, this user's app serves
 * on the first free port of that range (sidecar-server-supervisor.ts). The sweep
 * settles on the first match; closed ports refuse at once, so it costs milliseconds.
 *
 * Still nothing ⇒ a mismatch on the fixed port is reported rather than silently
 * dialled, for the same reason `resolveTarget` refuses to downgrade a
 * configured-but-unreachable hub to the local app: quietly acting on a different
 * target applies the command to the wrong data.
 */
export async function probeLocalHub(opts: LocalHubProbeOptions = {}): Promise<LocalHubProbe> {
  const dev = opts.dev ?? isDevChannel()
  const port = opts.port ?? fixedPortForChannel(dev)
  const id = identityFor(dev)

  const atFixed = await findHub(String(port))
  if (atFixed && (id === null || ownsFixedPort(atFixed, id))) return found(atFixed)
  if (id === null) return { kind: 'absent' }

  const elsewhere = await findFirstHub((h) => isOursElsewhere(h, id), {
    range: opts.range ?? HUB_DYNAMIC_PORT_RANGE
  })
  if (elsewhere) return found(elsewhere)

  if (atFixed) {
    return {
      kind: 'foreign',
      port: atFixed.port,
      root: atFixed.root,
      expected: describeIdentity(id)
    }
  }
  return { kind: 'absent' }
}

function found(hub: DiscoveredHub): LocalHubProbe {
  return { kind: 'found', port: hub.port, root: hub.root, authRequired: hub.authRequired }
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
  const configured = resolveTaskCommandTarget()
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
