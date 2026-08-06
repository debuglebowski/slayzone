import { app } from 'electron'
import path from 'path'
import { getDbName } from '@slayzone/platform'
import { getStorageDir } from '../data-paths'
import { createDiagBridge, type DiagBridge } from './diag-bridge'

export const getDatabasePath = (): string => {
  const userDataPath = getStorageDir()
  return path.join(userDataPath, getDbName(app.isPackaged))
}

const getDiagnosticsDatabasePath = (): string => {
  const userDataPath = getStorageDir()
  const dbName = app.isPackaged ? 'slayzone.diagnostics.sqlite' : 'slayzone.dev.diagnostics.sqlite'
  return path.join(userDataPath, dbName)
}

let diagDb: DiagBridge | null = null

/**
 * Spawn the DIAGNOSTICS worker. That is the only database this process opens.
 *
 * The shared `slayzone.sqlite` is the HUB's — it migrates it in every mode and
 * serves every consumer that used to reach it from here. What is left is the
 * machine-local diagnostics events file, which stays because main must record
 * boot, crash-detection and single-instance-lock events when NO hub exists:
 * in remote mode, or precisely when the side-car failed to start.
 *
 * The legacy `omgslayzone` file copy still has to happen before the side-car
 * opens anything, but it is pure fs and now runs in `initStorageDir`.
 */
export async function initDatabases(): Promise<{ diagDb: DiagBridge }> {
  diagDb = await createDiagBridge({ dbPath: getDiagnosticsDatabasePath() })
  return { diagDb }
}

/** Synchronous accessor for the already-initialized diagnostics DB bridge. */
export function getDiagnosticsDatabase(): DiagBridge {
  if (!diagDb) throw new Error('getDiagnosticsDatabase() called before initDatabases()')
  return diagDb
}

export async function closeDiagnosticsDatabase(): Promise<void> {
  if (diagDb) {
    await diagDb.close()
    diagDb = null
  }
}
