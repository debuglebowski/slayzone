export type { Theme, ThemePreference } from '@slayzone/ui/theme-types'

export interface BackupInfo {
  filename: string
  name: string
  timestamp: string
  /** `restore` = the copy of the data taken just before a restore replaced it. */
  type: 'auto' | 'manual' | 'migration' | 'restore'
  sizeBytes: number
}

/** Who starts a hub again after it exits to finish a restore; null = nobody. */
export type HubRespawner = 'desktop' | 'launchd' | 'systemd' | null

/** A staged restore: the hub swaps the backup in at its next start. */
export interface RestoreResult {
  /** The hub is about to exit to apply it (false: it waits for the next start). */
  restarting: boolean
  /** Who starts it again; null = an operator must (the UI warns). */
  respawner: HubRespawner
  /** The copy of the current data taken first (`type: 'restore'`). */
  preRestoreBackup: string
}

export interface BackupSettings {
  autoEnabled: boolean
  intervalMinutes: number
  maxAutoBackups: number
  nextBackupNumber: number
}

/**
 * What a client checks after a restore made the hub restart: `bootId` changes with
 * every hub process, so a client that saw the old one knows the hub restarted; a
 * `lastRestore` of this boot says whether the backup was swapped in or refused.
 */
export interface RestoreStatus {
  bootId: string
  /** Who starts the hub again after it exits to apply a restore; null = an operator
   *  must (Settings warns before restoring). */
  respawner: HubRespawner
  /** A restore staged and not yet applied (the hub has not restarted yet). */
  pending: { backup: string } | null
  /** What this boot did with a staged restore; null when there was none. */
  lastRestore:
    | { status: 'applied'; backup: string }
    | { status: 'refused'; backup: string; error: string }
    | null
}
