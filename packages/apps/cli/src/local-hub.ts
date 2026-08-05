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
 * Probe this channel's fixed port, returning it when a hub actually answers there.
 *
 * `findHub` with an all-digits argument probes that port DIRECTLY (no sweep) and
 * validates the `/health` body is hub-shaped, so an unrelated service that happens
 * to hold the port is rejected rather than dialled. Null for every other outcome —
 * the caller falls back.
 */
export async function probeFixedPort(): Promise<number | null> {
  const port = fixedPortForChannel()
  const hub = await findHub(String(port))
  return hub ? hub.port : null
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
