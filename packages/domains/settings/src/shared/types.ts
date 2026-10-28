export type Theme = 'light' | 'dark'
export type ThemePreference = 'light' | 'dark' | 'system'

export interface BackupInfo {
  filename: string
  name: string
  timestamp: string
  type: 'auto' | 'manual' | 'migration'
  sizeBytes: number
}

export interface BackupSettings {
  autoEnabled: boolean
  intervalMinutes: number
  maxAutoBackups: number
  nextBackupNumber: number
}
