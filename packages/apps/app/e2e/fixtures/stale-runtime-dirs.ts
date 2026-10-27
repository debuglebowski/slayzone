/**
 * Which `.e2e-runtime/` dirs the e2e global setup may delete.
 *
 * `fixtures/electron.ts` gives every worker and every isolated launch its own
 * `.e2e-runtime/<prefix>-<pid>-<ms>` (userdata, test project, artifacts) and
 * never removes it. Nothing else did either: 649 dirs / 231 GB piled up in six
 * days, filled the disk, and a full-suite run then failed ~56 unrelated specs.
 *
 * The discriminator is whether the pid in the dir name is still ALIVE.
 * `e2e-parallel.sh` runs six Playwright processes concurrently and each runs the
 * global setup, so a dir owned by another group's live worker must survive. The
 * previous run's artifacts are deleted when the next run starts — they stay
 * inspectable until then.
 *
 * Selection fails CLOSED — a name that does not parse is never deleted. A pid
 * reused by an unrelated process merely keeps a stale dir one run longer.
 */
import fs from 'node:fs'
import path from 'node:path'

/** `<prefix>-<pid>-<epoch ms>`; the prefix may itself contain dashes. */
const RUNTIME_DIR_NAME = /^.+-(\d+)-\d{10,}$/

/** The pid that created a runtime dir, or null when the name is not ours. */
export function parseRuntimeDirOwner(name: string): number | null {
  const match = RUNTIME_DIR_NAME.exec(name)
  if (!match) return null
  const pid = Number.parseInt(match[1], 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Names of runtime dirs whose owning process is no longer running. */
export function selectStaleRuntimeDirs(
  names: readonly string[],
  isAlive: (pid: number) => boolean
): string[] {
  return names.filter((name) => {
    const pid = parseRuntimeDirOwner(name)
    return pid !== null && !isAlive(pid)
  })
}

/** `kill -0`: ESRCH means gone; EPERM means alive but not ours. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Delete stale runtime dirs under `root`. Returns the names removed. */
export function pruneStaleRuntimeDirs(root: string): string[] {
  let names: string[]
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return [] // no runtime root yet
  }
  const removed: string[] = []
  for (const name of selectStaleRuntimeDirs(names, isProcessAlive)) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Busy or permission-denied — retried next run, not fatal.
    }
  }
  return removed
}
