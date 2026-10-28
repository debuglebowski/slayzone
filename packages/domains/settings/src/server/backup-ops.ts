import type { BackupInfo, BackupSettings } from '../shared'

/**
 * Backup ops — injected by the composition root rather than built in the router.
 *
 * Unlike leaderboard/feedback/export-import, backup needs things only the host
 * process knows: whether this hub is supervised (restore is refused otherwise),
 * the live DB file path, and how to close its own connection before that file is
 * overwritten. So it stays a registry, but the IMPLEMENTATION now lives with the
 * database instead of on the far side of a capability bridge.
 *
 * The registry lives with the `app.backup` router that reads it; `@slayzone/api`
 * re-exports the setter for the composition roots.
 */
export type BackupOps = {
  list: () => Promise<BackupInfo[]>
  create: (name?: string) => Promise<BackupInfo>
  rename: (filename: string, name: string) => Promise<void>
  delete: (filename: string) => Promise<void>
  restore: (filename: string) => Promise<void>
  getSettings: () => Promise<BackupSettings>
  setSettings: (partial: Partial<BackupSettings>) => Promise<BackupSettings>
  revealInFinder: () => void
}

let backupOps: BackupOps | null = null

export function setBackupOps(ops: BackupOps): void {
  backupOps = ops
}

export function getBackupOps(): BackupOps {
  if (!backupOps) throw new Error('backupOps not initialized — call setBackupOps() at boot')
  return backupOps
}
