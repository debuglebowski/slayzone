/**
 * Which physical box is this computer on?
 *
 * A "computer" is one OS user's environment — its `$HOME`, checkouts, credentials
 * and ptys. Several of them can share one machine, one per OS account, and the hub
 * wants to show them grouped. That grouping needs an id every account on the box
 * agrees on, discovered WITHOUT root and WITHOUT per-OS identity APIs.
 *
 * The scheme is two files:
 *
 *   - DURABLE, in this computer's own `<ROOT>/computer.host-id.json` (0600). This
 *     is the value of record. Once written it survives reboots, `/tmp` sweeps and
 *     everything else.
 *   - SHARED, at a world-writable path in `/tmp`. Its ONLY job is to let a
 *     newly-enrolling OS user on the same box copy the id instead of inventing a
 *     second one. Nothing depends on it surviving.
 *
 * Because durability lives in `$HOME`, `/tmp` being wiped is harmless: the hourly
 * tick rewrites the shared file from the durable one, so a user who first starts
 * after a reboot still finds it.
 *
 * **Why not an OS identity API.** `/etc/machine-id`, `IOPlatformUUID` and
 * `MachineGuid` are three different code paths with three different failure modes,
 * they are absent or shared in containers, and `/etc/machine-id` is baked into VM
 * images so cloned VPSs report the same one. A file we write ourselves has one code
 * path and is created later in the machine's life than any of them.
 *
 * **Two traps this file exists to avoid.**
 *
 *  1. NOT `os.tmpdir()`. On macOS it honours `$TMPDIR`, which is PER-USER
 *     (`/var/folders/…`), so the shared file would never be shared — the mechanism
 *     would silently no-op on the primary dev platform with every test still green.
 *     The literal `/tmp` is the point.
 *  2. `/tmp` is sticky, so `rename()` over another user's file fails EPERM. The
 *     atomic tmp+rename idiom used everywhere else in this repo (see
 *     `credential-store.ts`) does NOT work here. Create with `wx`, `fchmod` to
 *     0666 (a `writeFile` mode is masked by umask 022 → 0644 → nobody else can
 *     write), and update in place afterwards.
 *
 * The shared file is world-writable, so any local user can change the grouping.
 * That is accepted: grouping is cosmetic, and NOTHING may key off the host id —
 * see `machines.ts`, where it is a mutable attribute and never a reference.
 *
 * @module computer/host-id
 */

import { randomUUID } from 'node:crypto'
import { constants, open, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** Mirrors the credential store's precedence: `SLAYZONE_ROOT` > `$HOME/.slayzone`. */
function slayzoneRootDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
  return join(home, '.slayzone')
}

export function hostIdFilePath(baseDir?: string): string {
  return join(baseDir ?? slayzoneRootDir(), 'computer.host-id.json')
}

/**
 * The one blessed shared path. Literal `/tmp`, never `os.tmpdir()` — see the
 * module note. Windows has no world-writable temp (`%LOCALAPPDATA%\Temp` is
 * per-user), so there is no shared channel there and grouping degrades to one
 * machine per OS user.
 */
export function sharedHostIdPath(): string | null {
  return process.platform === 'win32' ? null : '/tmp/slayzone-host-id'
}

const hostIdFileSchema = z.object({ hostId: z.string().min(1), updatedAt: z.number() })

async function readDurable(filePath: string): Promise<string | null> {
  try {
    const parsed = hostIdFileSchema.safeParse(JSON.parse(await readFile(filePath, 'utf-8')))
    return parsed.success ? parsed.data.hostId : null
  } catch {
    return null
  }
}

/** Atomic, 0600, same idiom as the credential store — this file is ours alone. */
async function writeDurable(filePath: string, hostId: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp-${process.pid}`
  await writeFile(tmpPath, `${JSON.stringify({ hostId, updatedAt: Date.now() }, null, 2)}\n`, {
    mode: 0o600
  })
  try {
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

/** A single trimmed line, or null when absent/unreadable/corrupt. */
async function readShared(sharedPath: string): Promise<string | null> {
  try {
    const raw = (await readFile(sharedPath, 'utf-8')).trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/**
 * Write the shared file, tolerating every way a world-writable path in a sticky
 * directory can refuse us. A failure here costs grouping, never correctness, so it
 * is logged once by the caller and otherwise ignored.
 */
async function writeShared(sharedPath: string, hostId: string): Promise<void> {
  // Create-exclusive first so two simultaneous first-starts cannot both believe
  // they authored it; whoever loses re-reads and adopts on the next tick.
  try {
    const fh = await open(sharedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try {
      // Explicit fchmod, NOT the `mode` option: umask 022 would turn 0666 into
      // 0644 and lock every other OS user out of a file that exists to be shared.
      await fh.chmod(0o666)
      await fh.writeFile(`${hostId}\n`)
    } finally {
      await fh.close()
    }
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  // Already there: truncate in place. Not atomic — but the payload is one short
  // line, and a torn read is indistinguishable from an absent file to `readShared`,
  // which is exactly how it is treated.
  const fh = await open(sharedPath, constants.O_WRONLY | constants.O_TRUNC)
  try {
    await fh.writeFile(`${hostId}\n`)
  } finally {
    await fh.close()
  }
}

export interface ReconcileHostIdOptions {
  /** Override the durable file's directory (tests). */
  baseDir?: string
  /** Override the shared path (tests). `null` disables the shared channel. */
  sharedPath?: string | null
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Read, reconcile, write — in that order, and skip the write when nothing changed.
 *
 * On a mismatch the SHARED value wins. That is what converges two OS users who
 * first started at the same moment and each generated their own: whoever wrote the
 * shared file last is adopted by everyone else on their next tick. Any tie-break
 * would do; deferring to the shared file needs no coordination and no clock.
 *
 * Returns the id this computer should report.
 */
export async function reconcileHostId(options: ReconcileHostIdOptions = {}): Promise<string> {
  const filePath = hostIdFilePath(options.baseDir)
  const sharedPath = options.sharedPath === undefined ? sharedHostIdPath() : options.sharedPath
  const log = options.log ?? ((): void => undefined)

  let durable = await readDurable(filePath)
  const shared = sharedPath ? await readShared(sharedPath) : null

  if (shared && durable && shared !== durable) {
    // Adopt. Another OS user on this box got here first; two ids for one machine
    // would show as two machines.
    log('host id adopted from the shared file', { from: durable, to: shared })
    durable = shared
    await writeDurable(filePath, durable)
  } else if (!durable) {
    durable = shared ?? randomUUID()
    await writeDurable(filePath, durable)
  }

  if (sharedPath && shared !== durable) {
    // Restores the shared file after a reboot cleared /tmp, so a user who first
    // starts later still finds it instead of inventing a second machine.
    try {
      await writeShared(sharedPath, durable)
    } catch (err) {
      log('host id shared file not writable — grouping may split', {
        path: sharedPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return durable
}

/** How often the shared file is refreshed. Well inside any tmp-cleaner window. */
export const HOST_ID_REFRESH_MS = 3_600_000

/**
 * Resolve once, then keep the shared file alive on a timer.
 *
 * The timer is what covers a box with long uptime whose tmp cleaner runs while no
 * computer ever restarts — without it a user enrolling later finds nothing and
 * splits off. `unref` so it never holds the process open.
 */
export async function startHostIdReconciler(
  options: ReconcileHostIdOptions = {}
): Promise<{ hostId: string; stop: () => void }> {
  const hostId = await reconcileHostId(options)
  const timer = setInterval(() => {
    void reconcileHostId(options)
  }, HOST_ID_REFRESH_MS)
  timer.unref()
  return { hostId, stop: () => clearInterval(timer) }
}
