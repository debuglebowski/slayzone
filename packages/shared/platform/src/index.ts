export { getStateDir } from './dirs'
export { migrateXdgIfNeeded, migrateStateDir, copyVerifyDelete, migrateCliBinIfNeeded, type MigrationResult } from './migrations'
export { installCli, checkCliInstalled, getCliBinTarget, getManualInstallHint, type CliInstallResult } from './cli-install'
