export {
  getStateDir,
  getSlayzoneHomeDir,
  getClaudeSettingsPath,
  getGeminiSettingsPath,
  getCodexHooksPath,
  getAntigravityHooksPath,
  getOpencodePluginPath
} from './dirs'
export {
  ensureDataRoot,
  getStorageDir,
  getTrpcPort,
  getServerHost,
  SIDECAR_FIXED_PORT
} from './paths'
export {
  getSlayzoneMode,
  isRemoteMode,
  isLoopbackHost,
  assertModeHostConsistency,
  type SlayzoneMode
} from './slayzone-mode'
export { writeFileIfChanged } from './fs-utils'
export {
  migrateXdgIfNeeded,
  migrateCliBinIfNeeded,
  type MigrationResult,
  type CliMigrationResult
} from './migrations'
export {
  installCli,
  installCliSync,
  checkCliInstalled,
  getCliBinTarget,
  getManualInstallHint,
  type CliInstallResult
} from './cli-install'
export {
  DB_PRAGMAS,
  getDbName,
  type SlayzoneDb,
  type PreparedBridge,
  type BatchOp,
  type RunResult
} from './db'
export {
  type TxnRegistry,
  type TxnSigOf,
  type TxnName,
  type TxnParams,
  type TxnResult
} from './txn-registry-map'
export {
  setShellOverride,
  getShellOverride,
  shellExists,
  defaultShellForPlatform,
  resolveUserShell,
  getDefaultShell,
  getShellStartupArgs,
  quoteForShell,
  buildExecCommand,
  buildShellInvocation
} from './shell'
// Re-export so main-process code can pull URL helpers from the main barrel.
// Renderer code MUST import from '@slayzone/platform/slz-file-url' to avoid
// pulling node:fs into the browser bundle.
export {
  SLZ_FILE_HOST,
  SLZ_FILE_PREFIX,
  toSlzFileUrl,
  fileUrlToSlzFileUrl,
  slzFileUrlToFileUrl
} from './slz-file-url'
export {
  withResultDedup,
  isIpcUnchangedSentinel,
  IPC_UNCHANGED_SENTINEL,
  type IpcUnchangedSentinel,
  type SenderLifecycle
} from './ipc-dedup'
