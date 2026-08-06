export {
  getStateDir,
  getSlayzoneHomeDir,
  getSlayzoneReleaseChannel,
  getSupervisedRoot,
  getClientRoot,
  type SlayzoneSupervisedRole,
  getMachineSlayzoneDir,
  getHooksDir,
  getSlayzoneBinDir,
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
  bindInHubPortBlock,
  HUB_PORT_BLOCK,
  HUB_DYNAMIC_PORT_RANGE,
  SIDECAR_FIXED_PORT
} from './paths'
export {
  getSlayzoneMode,
  isRemoteMode,
  isLoopbackHost,
  assertModeHostConsistency,
  type SlayzoneMode
} from './slayzone-mode'
// Multi-hub discovery. Also available as the lean `@slayzone/platform/hub-discovery`
// subpath — prefer that from a bundle that must not pull this barrel.
export { discoverHubs, findHub, type DiscoveredHub, type DiscoverOptions } from './hub-discovery'
export {
  ENV_MANIFEST,
  NON_PREFIXED_INFRA,
  sanitizeSpawnEnv,
  type EnvScope
} from './env-manifest'
export {
  createDeviceStatusQueryStripper,
  stripDeviceStatusQueries,
  stripDeviceStatusResponses,
  type DeviceStatusQueryStripper
} from './device-status-queries'
export {
  hubUrlFromAddr,
  isBareAuthority,
  parseHubAddress,
  LOOPBACK_HOSTS,
  type HubBindAddress
} from './hub-addr'
export { writeFileIfChanged, updateFileAtomically } from './fs-utils'
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
