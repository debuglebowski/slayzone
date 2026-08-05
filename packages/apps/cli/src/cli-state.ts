/**
 * Where the CLI keeps its OWN files.
 *
 * THE BOUNDARY. The CLI may touch the local filesystem for things that describe
 * THIS MACHINE — which hub to talk to, which service bundles are installed here.
 * It may not touch the filesystem for DOMAIN state (tasks, projects, artifacts):
 * that lives on a hub and is reached over REST, which is what lets one `slay`
 * binary behave identically in a laptop shell, an agent terminal, and on a
 * hub-only box.
 *
 * WHY NOT THE HUB'S ROOT. These files used to live under `getDataDir()` — the
 * app's storage dir, derived from `SLAYZONE_ROOT`. That coupled the CLI to a layout
 * rule it does not own and cannot see change: when supervised state moved to
 * `~/.slayzone/<channel>/<role>`, a plain shell started resolving a directory one
 * level above the real one. It also made the SAME file resolve to two different
 * paths for one user — `~/.slayzone/cli-hub-target.json` from a shell (ROOT unset)
 * but `~/.slayzone/<channel>/hub/cli-hub-target.json` inside a task terminal (ROOT
 * set) — so `slay hub use` in one context was invisible in the other.
 *
 * A CLI-owned directory removes both problems: the path depends on nothing but
 * `$HOME`, and the only variable is the release channel, which the CLI already
 * knows from `SLAYZONE_DEV` and applies to a FILENAME rather than to a directory
 * tree it has to keep in sync with someone else's.
 *
 * @module cli/cli-state
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getStorageDir } from '@slayzone/platform'

/**
 * `~/.slayzone/cli` — the CLI's own state directory.
 *
 * Deliberately NOT channel- or role-scoped, unlike `getSupervisedRoot()`: nothing
 * in here belongs to a hub or a runner, so there is no role to scope by, and the
 * one thing that does vary per channel (which hub `hub use` targeted) is expressed
 * in the filename instead. Anchored on `$HOME` directly rather than on the
 * platform's root resolver, because that reads `SLAYZONE_ROOT` — the exact coupling
 * this module exists to remove. A hub or runner process that seeds `SLAYZONE_ROOT`
 * to its own working directory must not drag the invoking user's CLI config along
 * with it. (The one backward-looking exception is {@link legacyHubTargetPaths}.)
 */
export function getCliStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.slayzone', 'cli')
}

/**
 * The hub-target file for this channel.
 *
 * Channel lives in the FILENAME (`hub-target.json` vs `hub-target.dev.json`) so
 * `slay` and `slay --dev` can point at different hubs — the same split the two
 * database filenames used to provide — without a directory rule to keep in step
 * with anything.
 */
export function getHubTargetPath(): string {
  const name = process.env.SLAYZONE_DEV === '1' ? 'hub-target.dev.json' : 'hub-target.json'
  return path.join(getCliStateDir(), name)
}

/**
 * The npm prefix a `<kind>-runtime` bundle is installed into.
 *
 * Machine-level install cache, not per-hub: `slay hub start --root /a` and
 * `--root /b` share one copy, and the unit file bakes the absolute path, so it must
 * not move when the ambient root changes. Effectively where it already resolved for
 * a normal user (`getDataDir()` with `SLAYZONE_ROOT` unset was `~/.slayzone`), minus
 * the coupling.
 */
export function getServiceRuntimeDir(kind: string): string {
  return path.join(getCliStateDir(), `${kind}-runtime`)
}

/**
 * Legacy locations of the hub-target file, newest first.
 *
 * Read-only compatibility: an existing `slay hub use` / `hub login` must keep
 * working across the move rather than silently reverting to "no hub configured"
 * and sending commands to the local app. Both former spellings are checked because
 * the old path depended on whether `SLAYZONE_ROOT` happened to be set — the
 * inconsistency described in this module's header, which means a single user could
 * have written EITHER.
 *
 * Not migrated on read (no silent copy): the file can hold a bearer token, and
 * moving credentials as a side effect of an unrelated command is the kind of thing
 * that should be deliberate. `hub use` / `hub login` write the new path, so the
 * next explicit act of configuration completes the move.
 *
 * This is the ONE place the CLI still resolves `SLAYZONE_ROOT` (via
 * `getStorageDir`), and only to look BACKWARD: that is where the file used to
 * land. Nothing the CLI writes or reads on the current path depends on it, which
 * is why the boundary guard in `scripts/check-server-electron-free.sh` exempts
 * this module by name rather than the whole package.
 */
export function legacyHubTargetPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  const candidates = [
    path.join(getStorageDir(), 'cli-hub-target.json'),
    path.join(home, '.slayzone', 'cli-hub-target.json')
  ]
  return candidates.filter((p, i) => candidates.indexOf(p) === i && fs.existsSync(p))
}
