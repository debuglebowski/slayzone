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
// The per-hub switches that replaced SLAYZONE_MODE. Also the lean
// `@slayzone/platform/hub-switches` subpath.
export {
  HUB_SWITCH_ENV,
  HUB_SWITCH_DEFAULTS,
  HUB_SSO_ENV,
  HUB_ADDRESS_ENV,
  LEGACY_HUB_LISTEN_ENV,
  HUB_ALLOWED_WEB_ORIGINS_ENV,
  HUB_PROCESS_ENV,
  HubSwitchValueError,
  parseSwitchValue,
  resolveHubSwitches,
  resolveHubSso,
  isHubLoginRequired,
  type HubSwitchKey,
  type HubSwitches,
  type HubSsoSettings
} from './hub-switches'
// Refusals for work a switch turned off. Also the lean
// `@slayzone/platform/hub-switch-refusal` subpath — prefer that from a domain package.
export {
  HubSwitchedOffError,
  isHubSwitchedOffError,
  hubProcessesEnabled,
  hubIntegrationsEnabled,
  assertHubProcessesEnabled,
  assertHubIntegrationsEnabled,
  assertHubLocalExecEnabled,
  type HubSwitchedOffCode,
  type HubRefusal
} from './hub-switch-refusal'
// Multi-hub discovery. Also available as the lean `@slayzone/platform/hub-discovery`
// subpath — prefer that from a bundle that must not pull this barrel.
export { discoverHubs, findHub, type DiscoveredHub, type DiscoverOptions } from './hub-discovery'
// Client-side hub registry + local computer status contracts. Also the lean
// `@slayzone/platform/hub-registry` and `/local-computer-status` subpaths —
// prefer those from renderer bundles.
export type { HubKind, HubEntry } from './hub-registry'
export type { LocalComputerStatus } from './local-computer-status'
// Process manager, app updater and WebContentsView event contracts. Also the lean
// `/process-info`, `/app-update-status` and `/browser-view-events` subpaths.
export type { ProcessStatus, ProcessStats, ProcessInfo, ProcessEventMap } from './process-info'
export type { UpdateStatus } from './app-update-status'
export type {
  BrowserCreateTaskFromLinkSource,
  BrowserCreateTaskFromLinkIntent,
  BrowserShortcutPayload
} from './browser-view-events'
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
  assertLoopbackBind,
  hubUrlFromAddr,
  isBareAuthority,
  isLoopbackAuthority,
  isLoopbackPeer,
  parseHubAddress,
  LOOPBACK_HOSTS,
  type HubBindAddress
} from './hub-addr'
export { writeFileIfChanged, updateFileAtomically } from './fs-utils'
// Security audit events on stdout. Also the lean `@slayzone/platform/security-log`
// subpath — prefer that from a domain package.
export {
  SECURITY_EVENTS,
  securityEvent,
  runWithSecurityContext,
  runAsSecurityActor,
  currentSecurityContext,
  setSecurityLogSink,
  peerAddress,
  routeOf,
  type SecurityEventName,
  type SecurityEventInput,
  type SecurityOutcome,
  type SecurityLevel,
  type SecurityTargetKind,
  type SecurityContext,
  type SecurityLogSink
} from './security-log'
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
export { refreshInstalledCliSync, type CliRefreshResult } from './cli-refresh'
export { adoptRenamedDatabase, type AdoptRenamedDbResult } from './adopt-renamed-db'
export {
  DB_PRAGMAS,
  getDbName,
  getLegacyDbName,
  getDiagnosticsDbName,
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
export { killPidTree, PROCESS_TREE_DETACHED } from './process-tree'
export {
  LOGIN_SHELL_PATH_MARKER,
  LOGIN_SHELL_PATH_PROBE_TIMEOUT_MS,
  loginShellPathProbes,
  parseLoginShellPathOutput,
  mergePathLists,
  probeLoginShellPath,
  type LoginShellPathProbe
} from './login-shell-path'
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
  buildEmulatedMediaParams,
  buildForcedHtmlThemeCss,
  buildForcedHtmlThemeScript,
  FORCED_HTML_THEME_ATTR,
  FORCED_HTML_THEME_STYLE_ID,
  HTML_THEME_CYCLE,
  injectForcedHtmlTheme,
  nextHtmlTheme,
  type ForcedHtmlTheme,
  type HtmlThemeMode
} from './forced-html-theme'
export {
  withResultDedup,
  isIpcUnchangedSentinel,
  IPC_UNCHANGED_SENTINEL,
  type IpcUnchangedSentinel,
  type SenderLifecycle
} from './ipc-dedup'
