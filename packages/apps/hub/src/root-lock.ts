import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One hub per root, for the hub's whole life (review-2 L7). Two hubs on one root would
 * write the same database; with a restore staged, the second would swap the file in
 * under the first one's open connection, and the first one's writes would land in the
 * replaced file.
 *
 * The lock is SQLite's exclusive lock on `<root>/hub.lock`, i.e. the OS's file lock:
 * it goes away with the process however the process ends (SIGKILL, crash), so there
 * is never a stale lock to clean up and no pid to trust.
 */
export class HubRootLockedError extends Error {
  constructor(readonly root: string) {
    super(
      `[slayzone-hub] another hub is already running on ${root}. Stop it first — two hubs must never share one root.`
    )
    this.name = 'HubRootLockedError'
  }
}

export function acquireHubRootLock(root: string): { release: () => void } {
  mkdirSync(root, { recursive: true })
  const db = new Database(join(root, 'hub.lock'), { timeout: 0 })
  try {
    db.pragma('locking_mode = EXCLUSIVE')
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    if ((err as { code?: string }).code?.startsWith('SQLITE_BUSY'))
      throw new HubRootLockedError(root)
    throw err
  }
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    }
  }
}
