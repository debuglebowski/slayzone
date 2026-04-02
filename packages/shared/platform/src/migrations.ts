import fs from 'fs'
import path from 'path'
import os from 'os'
import { getStateDir } from './dirs'
import { installCliSync } from './cli-install'

export interface MigrationResult {
  migrated: boolean
  failed: boolean
  newDir?: string
}

export interface CliMigrationResult {
  status: 'noop' | 'migrated' | 'migrated-old-kept' | 'failed'
  oldPath?: string
  newPath?: string
}

/**
 * Migrates app state from XDG_CONFIG_HOME to XDG_STATE_HOME on Linux.
 *
 * Electron stores userData in $XDG_CONFIG_HOME/slayzone (~/.config/slayzone) on Linux,
 * but per XDG spec, state data (DB, backups) belongs in $XDG_STATE_HOME/slayzone.
 *
 * On non-Linux platforms, this is a no-op.
 */
export function migrateXdgIfNeeded(): MigrationResult {
  if (process.platform !== 'linux') return { migrated: false, failed: false }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const oldDir = path.join(configHome, 'slayzone')
  const newDir = getStateDir()

  return migrateStateDir(oldDir, newDir)
}

/**
 * Core migration logic: move state from oldDir to newDir.
 * Exported separately for testability (migrateXdgIfNeeded adds the platform guard + dir computation).
 */
export function migrateStateDir(oldDir: string, newDir: string): MigrationResult {
  // Same dir (unusual XDG config), nothing to do
  if (oldDir === newDir) return { migrated: false, failed: false }

  // New dir already exists — already migrated or fresh install to new location
  if (fs.existsSync(newDir)) return { migrated: false, failed: false }

  // No old dir — fresh install, nothing to migrate
  if (!fs.existsSync(oldDir)) return { migrated: false, failed: false }

  // Snapshot which critical files exist in old dir for post-copy verification
  const dbFiles = ['slayzone.sqlite', 'slayzone.dev.sqlite']
  const expectedFiles = dbFiles.filter(f => fs.existsSync(path.join(oldDir, f)))

  try {
    // Ensure parent dir exists (e.g. ~/.local/state/)
    fs.mkdirSync(path.dirname(newDir), { recursive: true })

    try {
      // Atomic on same filesystem
      fs.renameSync(oldDir, newDir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      copyVerifyDelete(oldDir, newDir, expectedFiles)
    }

    console.error(`[slayzone] Migrated state from ${oldDir} to ${newDir}`)
    return { migrated: true, failed: false, newDir }
  } catch (err) {
    console.error(`[slayzone] XDG migration failed, keeping old dir: ${err}`)

    // Rollback: remove incomplete new dir if it was created by cpSync
    try {
      if (fs.existsSync(newDir) && fs.existsSync(oldDir)) {
        fs.rmSync(newDir, { recursive: true })
      }
    } catch {
      // Best effort cleanup
    }

    return { migrated: false, failed: true }
  }
}

/**
 * Cross-device migration: copy oldDir to newDir, verify critical files, then delete oldDir.
 * Exported for testability — rename (EXDEV) can't be simulated on same-filesystem tmp dirs.
 */
export function copyVerifyDelete(oldDir: string, newDir: string, expectedFiles: string[]): void {
  fs.cpSync(oldDir, newDir, { recursive: true })

  for (const f of expectedFiles) {
    if (!fs.existsSync(path.join(newDir, f))) {
      throw new Error(`Verification failed: ${f} missing at ${newDir}`)
    }
  }

  fs.rmSync(oldDir, { recursive: true })
}

/**
 * Migrates CLI symlink from /usr/local/bin/slay to ~/.local/bin/slay on Linux.
 * On non-Linux platforms, this is a no-op.
 */
export function migrateCliBinIfNeeded(cliSrcPath: string): CliMigrationResult {
  if (process.platform !== 'linux') return { status: 'noop' }

  const oldTarget = '/usr/local/bin/slay'
  try {
    const stat = fs.lstatSync(oldTarget)
    if (!stat.isSymbolicLink()) return { status: 'noop' }
  } catch {
    return { status: 'noop' } // Doesn't exist or can't stat
  }

  // Install at new location first
  const result = installCliSync(cliSrcPath)
  if (!result.ok) {
    console.error(`[slayzone] CLI bin migration: failed to install at new location: ${result.error}`)
    return { status: 'failed' }
  }

  // Try to remove old symlink (may need sudo)
  try {
    fs.unlinkSync(oldTarget)
    console.error(`[slayzone] Migrated CLI from ${oldTarget} to ${result.path}`)
    return { status: 'migrated', newPath: result.path }
  } catch {
    console.error(`[slayzone] CLI installed at ${result.path} (old symlink at ${oldTarget} kept — remove manually with: sudo rm ${oldTarget})`)
    return { status: 'migrated-old-kept', oldPath: oldTarget, newPath: result.path }
  }
}
