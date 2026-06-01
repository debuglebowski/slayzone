import fs from 'node:fs'
import path from 'node:path'
import type { LegacyMigrationPaths } from './worker-protocol'

const LEGACY_DB_NAMES = ['omgslayzone.sqlite', 'omgslayzone.dev.sqlite'] as const
const DB_SUFFIXES = ['', '-wal', '-shm'] as const

/**
 * Copy the pre-rename `omgslayzone` databases into the current `slayzone`
 * location on first run after the rename. Pure (fs + path only) so it can run
 * inside the DB worker; the old/new userData dirs are resolved on the main
 * thread (`app.getPath`) and passed via `workerData`. No-op when `paths` is null
 * (no legacy dir found) or the destination already exists.
 */
export function migrateLegacyDatabaseIfNeeded(paths: LegacyMigrationPaths | null): void {
  if (!paths) return
  const { oldUserData, newUserData } = paths
  if (!fs.existsSync(oldUserData)) return

  const migrations = [
    { oldBase: LEGACY_DB_NAMES[0], newBase: 'slayzone.sqlite' },
    { oldBase: LEGACY_DB_NAMES[1], newBase: 'slayzone.dev.sqlite' }
  ]

  let backupDir: string | null = null

  for (const { oldBase, newBase } of migrations) {
    const oldBasePath = path.join(oldUserData, oldBase)
    const newBasePath = path.join(newUserData, newBase)

    if (!fs.existsSync(oldBasePath) || fs.existsSync(newBasePath)) continue

    fs.mkdirSync(newUserData, { recursive: true })

    if (!backupDir) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupDir = path.join(oldUserData, `backup-${timestamp}`)
      fs.mkdirSync(backupDir, { recursive: true })
    }

    for (const suffix of DB_SUFFIXES) {
      const oldPath = `${oldBasePath}${suffix}`
      if (!fs.existsSync(oldPath)) continue

      const backupPath = path.join(backupDir, `${oldBase}${suffix}`)
      fs.copyFileSync(oldPath, backupPath)

      const newPath = path.join(newUserData, `${newBase}${suffix}`)
      fs.copyFileSync(oldPath, newPath)
    }
  }
}
