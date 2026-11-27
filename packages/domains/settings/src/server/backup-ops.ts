import type { BackupInfo, BackupSettings, RestoreResult, RestoreStatus } from '../shared'

/**
 * Backup ops — injected by the composition root rather than built in the router.
 *
 * Unlike leaderboard/feedback/export-import, backup needs things only the host
 * process knows: the live DB file path, and how this hub restarts itself to swap a
 * restored backup in. So it stays a registry, but the IMPLEMENTATION now lives with the
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
  /** Stage a restore; the hub restarts itself to apply it (apps/hub restore-swap.ts). */
  restore: (filename: string) => Promise<RestoreResult>
  /** Whether the hub restarted since a restore, and what the restart did with it. */
  restoreStatus: () => Promise<RestoreStatus>
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
