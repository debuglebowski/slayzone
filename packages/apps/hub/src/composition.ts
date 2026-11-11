import { createChatRelayWatch } from './chat-relay-watch'
import { createChatDirectWriteHandler } from './chat-direct-write'
import { CHAT_DIRECT_WRITE_EVENT_NAME } from '@slayzone/computer-transport/shared'
import {
  createDirectLinkIssuer,
  type DirectLinkIssuer,
  type DirectRevokeOutcome
} from './direct-link'

/**
 * A revocation a computer could not receive is already audited as a failure; say so
 * in the hub log too. Its grants are forgotten here, the computer is reset to what
 * the hub holds when it reconnects, and none outlives its 5-minute TTL.
 */
function reportDirectRevokeFailures(outcome: DirectRevokeOutcome | undefined): void {
  for (const f of outcome?.failed ?? []) {
    console.warn('[direct-link] revocation not delivered', f)
  }
}
import { createTaskWorktreeRouting } from './task-worktree-routing'
import { eraseTasksOnComputer, type ErasureReply } from './erasure-fanout'
import {
  CHAT_SETTINGS_KIND,
  createComputerDataHandoff,
  DECISIVE_HANDOFF_KINDS
} from './computer-data-handoff'
import { createTaskPathRequestGate } from './task-path-request-gate'
import {
  createComputerTaskPaths,
  readComputerTaskPath,
  recordHolder,
  readComputerTaskRoots,
  TASK_PATH_KIND,
  taskPathHandoffKind
} from './computer-task-paths'
import { type ComputerTaskDataRelay, createComputerTaskDataRelay } from './computer-task-data'
import { isComputerUnreachable } from '@slayzone/chat-runtime/hub'
import { createItemFaultService } from './item-faults'
import { createAsyncFaultLedger } from '@slayzone/platform/isolation'
import { acceptComputerGeneration } from '@slayzone/computers/server'
import { setChatSessionSource } from '@slayzone/terminal/hub'
import {
  setAgentPromptReader,
  agentPromptsEvents,
  wireTurnRecording
} from '@slayzone/agent-turns/server'
import { createLegacyChatDiagnostics, createDiagnosticTaskResolver } from './chat-diagnostics'
import { createComputerChatServices } from './computer-chat'
import { createComputerProbes } from './computer-probes'
import { createGitOpGate } from './git-op-gate'
import { EXEC_RUN_REPLY_GRACE_MS, execRunOnComputer } from './computer-exec-run'

// Explicit limits for computer requests that are not `exec.run` / git ops (those
// carry their own): never the gateway's 30 s default.
/** A usage collect parses every new log line on the computer (a first one: all of them). */
const USAGE_COLLECT_TIMEOUT_MS = 5 * 60_000
/** A test-file scan of a large checkout. */
const COMPUTER_SCAN_TIMEOUT_MS = 2 * 60_000
/** One AI-config fs call (read / write / stat / readdir of one file or dir). */
const COMPUTER_FS_CALL_TIMEOUT_MS = 60_000
/** Deleting one tab's saved terminal output on its computer. */
const PTY_FORGET_TIMEOUT_MS = 10_000
/** Longest a call needing a computer waits for the desktop's local computer to enroll after boot. */
const LOCAL_COMPUTER_BOOT_WAIT_MS = 30_000
/** Longest the warm pool waits for the boot restore before warming anyway. */
const WARM_HOLD_FOR_RESTORE_MAX_MS = 5 * 60_000
/** A turn snapshot writes a tree of a whole worktree. */
const TURN_GIT_OP_TIMEOUT_MS = 5 * 60_000
/** `gh` with no limit of its own: the computer then ends it at its 30 s default. */
const GH_DEFAULT_TIMEOUT_MS = 30_000
import {
  setChatSettingsDelegate,
  setTaskPathsDelegate,
  setTaskSessionPromptReader,
  agentSessionsEvents
} from '@slayzone/task/server'
import { readHubSessionRetentionDays, readHubStunAddresses } from '@slayzone/platform/hub-switches'
import { createChatCompaction } from './chat-compaction'
import {
  createComputerChatMaintenance,
  createComputerChatCommandBarrier
} from './computer-chat-maintenance'
import {
  currentSecurityContext,
  runAsSecurityActor,
  runWithSecurityContext
} from '@slayzone/platform/security-log'
import {
  createLocalComputerBootGate,
  type BootUnanswered,
  type LocalComputerBootGate
} from './local-computer-boot-gate'
import {
  currentPathScope,
  PathScopeRequiredError,
  assertKnownTarget,
  pathScopeFor
} from '@slayzone/platform/path-scope'
import { createComputerRequestAuthorizer } from './computer-request-authorizer'
import { createComputerArtifactStorage } from './computer-artifacts'
import { createArtifactStore, setArtifactStorage } from '@slayzone/task-artifacts/server'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  openPath as nativeOpenPath,
  openExternal as nativeOpenExternal,
  pathExists as nativePathExists,
  showItemInFolder as nativeShowItemInFolder
} from './shell-native'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  checkCliInstalled,
  checkCliInstalledAtTarget,
  hubProcessesEnabled
} from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  assertHubIntegrationsEnabled,
  assertHubLocalExecEnabled,
  refuseNoComputer
} from '@slayzone/platform/hub-switch-refusal'
import {
  setNotifyEvents,
  setMenuEvents,
  setTaskTriggerBus,
  setAppDeps,
  getAppDeps,
  setBackupOps,
  setAuthEvents,
  setComputersDeps,
  setHubAdminDeps,
  setHubDiskComputer,
  setHubDiskTaskRoots,
  requestGithubSignInStart,
  hubGithubSignInConvexUrl,
  evictAgentTree,
  checkOwnership,
  resetAgentHookStateForTest,
  type AppDeps,
  type NotifyEventMap,
  type MenuEventMap,
  type AuthEventMap,
  type RestApiDeps,
  type FloatingAgentState
} from '@slayzone/api'
import { createChatAttachmentReader } from './chat-attachment-reader'
import { createHostBridge, type HostBridge } from './host-bridge.js'
import { getDesktopBridgeCapUrl, getDesktopBridgeToken } from './desktop-bridge-address.js'
import { getServerBuildInfo } from './build-info.js'
import {
  taskOps,
  configureTaskRuntimeAdapters,
  startArtifactWatcher,
  handleAttentionTransition,
  registerConversationHealer,
  registerConversationResolver,
  setTaskSessionLedger,
  setTaskDeps,
  getTaskOp,
  resolveMainAgentLaunch,
  resolveChatAgentLaunch,
  startMainAgent,
  restoreRunningChatAgents,
  type TaskRuntimeAdapters
} from '@slayzone/task/server'
import type { TasksChange } from '@slayzone/task-contracts'
import {
  handleTerminalStateChange,
  relocateProjectIcons,
  setProjectComputerResolver,
  setProjectFolderHost,
  NoComputerForFolderError
} from '@slayzone/projects/server'
import {
  createPtyOps,
  createDbPtySpawnLookups,
  setPtyBackend,
  setPtySpawnLookups,
  setRemoteMcpEnvProvider,
  ptyEvents,
  setClaudeTranscriptLocator,
  listPtys,
  hasPty,
  hasLivePty,
  getBuffer,
  getBufferSince,
  writePty,
  submitPty,
  killPty,
  killPtysByTaskId,
  requestEnsureAlive,
  subscribeToPtyData,
  subscribeToStateChange,
  onSessionChange,
  notifyGlobalStateListeners,
  getState,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput,
  setSessionBackgroundJobs,
  probeSessionBackgroundJobs,
  configurePtyHost,
  onTaskReachedTerminal,
  runtimeOnTaskReachedTerminal,
  setTaskAgentsStopper,
  stopTaskAgents,
  midReplySessionIds,
  broadcastRespawnRequest,
  initWarmProcessManager,
  createDbWarmPoolDataOps,
  reapOrphanWarms,
  reconcileWarmPool,
  reserveWarmTaskId,
  onGlobalStateChange,
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark,
  createDbChatDataOps,
  setPtyEnricher,
  resetTerminalRuntimeForTest,
  setAgentLifecycleEvents,
  setPtyDeps,
  defaultConversationRegistry,
  setChatDeps,
  getChatDeps,
  setExecutionContextProbe,
  setTerminalCommandProbe,
  getPtyDirectTarget,
  onPtyInputSubmit,
  type AgentLifecycleEventMap,
  type PtySessionWindow
} from '@slayzone/terminal/hub'
import {
  SIDE_QUESTION_TIMEOUT_MS,
  AGENT_STARTUP_SETTING,
  parseAgentStartupMode,
  warmPoolEnabled,
  type TerminalState
} from '@slayzone/terminal-contracts'
import type { AgentId } from '@slayzone/terminal-contracts'
import {
  createIntegrationOps,
  ensureIntegrationSchema,
  resetSyncFlags,
  setCredentialCipher,
  setIntegrationOps
} from '@slayzone/integrations/server'
import { setTelemetryEvents, type TelemetryEventMap } from '@slayzone/telemetry/server'
import {
  initAiConfigOps,
  getAiConfigOps,
  setSlayExecutor,
  setAiConfigFsRouting,
  aiConfigComputerGone
} from '@slayzone/ai-config/server'
import { createRoutingSlayExecutor } from './slay-routing'
import {
  AgentHistoryOfflineError,
  setTurnGitRouting,
  type TurnListOutcome,
  type TurnRecordOutcome
} from '@slayzone/agent-turns/server'
import type { TurnsRequest } from '@slayzone/chat-runtime/shared'
import { setUsageCollectRouting, type UsageCollectReply } from '@slayzone/usage-analytics/server'
import { setTestScanRouting } from '@slayzone/test-panel/server'
import {
  AutomationEngine,
  setAutomationsEvents,
  setAutomationCommandRouting,
  setAutomationWrittenListener,
  type AutomationsEventMap
} from '@slayzone/automations/server'
import {
  recordDiagnosticEvent,
  bindDiagnosticsDbs,
  getDiagnosticsConfig,
  clearConfigCache as clearDiagnosticsConfigCache
} from '@slayzone/diagnostics/server'
import {
  processEvents,
  initProcessManager,
  createProcess,
  spawnProcess,
  updateProcess,
  stopProcess,
  removeProcess,
  restartProcessForUi,
  restartProcessDetailed,
  startProcess,
  removeTaskProcesses,
  listForTask,
  listAllProcesses,
  subscribeToProcessLogs,
  setProcessComputerResolver,
  setProcessPathScopeResolver,
  setProcessComputerReachability,
  setProcessSpawnPreparer,
  setProcessWrittenListener,
  processesComputerConnected,
  processesComputerRemoved,
  isAdoptedOnComputer,
  setProcessBackend,
  killAllProcesses,
  setProcessesDeps
} from '@slayzone/processes/server'
import { noComputerWorkspaceFs, setWorkspaceDeps } from '@slayzone/file-editor/hub'
import {
  setGhExecutor,
  invalidateProjectReposCache,
  resetWorktreeColorsForTest,
  hubWorktreeExecAdapters,
  defaultWorktreePolicyAdapters,
  executeGitOp,
  setGitOpTransport,
  deliverGitWatchEvent,
  gitWatchComputerGone,
  setAiCommandRunner
} from '@slayzone/worktrees/hub'
import { createComputerProjectSync } from './computer-project-sync'
// Computer transport: computer gateway + hub-auth + computer resolution, wired
// unconditionally at boot (a hub always accepts computers).
import {
  ghExecResultSchema,
  claudeSessionLocateResultSchema,
  gitOpResultSchema,
  agentConfigFsResultSchema,
  usageCollectResultSchema,
  testPanelScanResultSchema,
  gitWatchEventSchema,
  GIT_WATCH_EVENT,
  HubToComputerMethods,
  projectListResultSchema
} from '@slayzone/computer-transport/shared'
import {
  createHubComputerGateway,
  createRoutingPtyBackend,
  createRoutingProcessBackend,
  createRemoteFsAdapters,
  type HubComputerGateway
} from '@slayzone/computer-transport/server'
import {
  createHubAuth,
  findHubUser,
  type EntraClientCredential,
  type HubAuth,
  idpRolesOf,
  type SsoConfig
} from '@slayzone/hub-auth/server'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import type { HubSsoBootConfig } from './boot-rules.js'
import { ssoConfigFromBoot } from './sso-config.js'
import { resolveAllowedWebOrigins } from './ws-origin.js'

import { createHubUsersCapability, createJoinTokenAccountLookup } from './hub-users.js'
import { createAdminContentErasure } from '@slayzone/content-erasure/admin'
import { configureContentErasure, startErasureRetries } from '@slayzone/content-erasure/server'
import {
  compactDiagnosticContent,
  eraseDiagnosticContent,
  flushWriteQueue
} from '@slayzone/diagnostics/server'
import { type BreakGlass, createBreakGlass } from './break-glass.js'
import { verifyRestBearer } from './rest-auth.js'
import {
  hasLiveWebSession,
  SSO_WEB_SESSION_LIFETIME,
  webLogin,
  webSessionCookieSecure
} from './web-sessions.js'
import { attachAgentHookRelayConsumer, computerOwnerOf } from './agent-hook-relay-consumer.js'
import { countRunningWork, createNewWorkGuard } from './computer-new-work.js'
import {
  DEFAULT_LOCAL_COMPUTER_NAME,
  deterministicLocalComputerId,
  getComputer,
  recordedProjectRoot,
  setComputerBindingChangedListener,
  setComputerRemovedListener
} from '@slayzone/computers/server'
import { createComputerAuthAdapters } from './computer-auth.js'
import { createComputerPlacement, BindComputerError } from './computer-placement.js'
import { createRemoteMcpEnvProvider } from './remote-mcp-env-provider.js'
import { wireTabFlagRecorders } from './tab-flag-recorders.js'
import { wireIdleClose } from './idle-close.js'
import { startIntegrationPollers } from './integrations-pollers.js'
import { wireIntegrationPush } from './integrations-push.js'
import { buildBackupOps } from './backup.js'
import { startFdWatch } from './fd-watch.js'
import { startSessionRetention } from './session-retention.js'
import { repairSharedSessionClaims } from './shared-session-repair.js'
import { recoverTaskSessionTabs } from './session-tab-recovery.js'
import {
  type ComputerSessionLedger,
  createComputerSessionLedger,
  lateSessionStore
} from '@slayzone/chat-runtime/hub'
import { startSsoRecheck } from './sso-recheck.js'
import { createTrpcConnectionRegistry, type TrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker, type UserAccessRevoker } from './user-access.js'
import { getDatabasePathFromEnv } from './db.js'
import { resolveAuthDbPath } from './auth-db.js'
import { createPtyEnricher, tabsEvents } from '@slayzone/task-terminals/server'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '@slayzone/api/txns'

/**
 * Composition root for the standalone server: populates every transport
 * registry the tRPC routers + REST routes resolve their implementations from.
 *
 * Pure-Node capabilities are wired for real (task ops, integrations, feedback,
 * processes, automation engine). Electron-shell capabilities (clipboard,
 * dialogs, windows, WCV browser, floating agent panel, …) get explicit
 * fail-loud stubs — the renderer never talks to this process until the flip
 * (slice 7), and post-flip those procedures move to the Electron-hosted shell
 * router. pty/chat registries are NOT populated yet (terminal runtime is still
 * electron-coupled — inversion slice); their procedures throw the registry's
 * own "not initialized" error and the pty REST routes 501.
 *
 * Dark-mode discipline: NOTHING here starts a background job. The automation
 * engine is constructed but never `start()`ed (no cron tick, no catchup, no
 * event listeners) — double-firing against the Electron host's live engine on
 * the same database would duplicate runs. Standalone mode may flip these on
 * via `opts.standalone`.
 */

const NOT_AVAILABLE = 'not available in standalone server'

function unavailable(name: string): never {
  throw new Error(`${name} ${NOT_AVAILABLE}`)
}

/**
 * A throwing stand-in for an electron-only function dep. `never[]` params are
 * what makes the constraint accept ANY function shape: parameters are
 * contravariant, and every parameter type is a supertype of `never`.
 */
function stub<T extends (...args: never[]) => unknown>(name: string): T {
  return ((..._args: unknown[]) => unavailable(name)) as unknown as T
}

/**
 * A silently-doing-nothing stand-in, the counterpart to `stub`. Reaching a
 * `stub` is a bug (fail loud); reaching a `noop` is normal — shared code calls
 * these on every host, and off-Electron there is simply nothing to act on (no
 * window chrome, no native menu, no WebContentsView z-order to maintain).
 */
const noop = (): void => {
  // Deliberately empty — see above.
}

export type ServerComposition = {
  closeErasures: () => Promise<void>
  notifyRenderer: (change?: TasksChange) => void
  automationEngine: AutomationEngine
  restDeps: RestApiDeps
  /** Late-bound by the server once listen() resolves the actual port. */
  setBoundPort: (port: number) => void
  /** Hub computer gateway (computer-WS multiplexer), or `null` until its async init
   *  resolves (see `computersReady`). A later unit mounts it onto the server's WS
   *  upgrade path. */
  readonly computerGateway: HubComputerGateway | null
  /** Hub-auth (better-auth) instance backing computer enroll/verify, or `null`
   *  until the async init resolves (same as `computerGateway`). */
  readonly hubAuth: HubAuth | null
  /** Resolves once the async computer init (createHubAuth + gateway) has finished.
   *  A later unit awaits this before reading the two fields above / mounting the
   *  gateway. */
  computersReady: Promise<void>
  /** What failed the async computer init, or null. Kept, not only logged: a hub with
   *  login refuses to boot on it (boot rule B18); the desktop runs degraded. */
  readonly computersInitError: Error | null
  /** Feed the computer listener's bound WS URL back into the computers registry
   *  (`mintJoinToken` embeds it in a join token). The server host resolves it only
   *  after it binds its port, which happens AFTER composeServer returns — so it's a
   *  late-bound setter, not a constructor arg. */
  setComputerListenerInfo: (info: { hubUrl: string }) => void
  /** Authenticated `/trpc` sockets by account (T-12): server.ts tracks them, revoking
   *  an account closes them. */
  trpcConnections: TrpcConnectionRegistry
  /** Ends what an account holds outside hub-auth (T-12, user-access.ts). */
  userAccess: UserAccessRevoker
  /** Emergency admin access while sign-in is down (break-glass.ts). */
  breakGlass: BreakGlass
  /**
   * Reads of a task's computer-only data through the hub relay (robustness plan §9):
   * the computer holding it answers; offline is an answer (`computer-offline`).
   */
  computerTaskData: ComputerTaskDataRelay
  /** E2E-only (`POST /api/dev/reset`): wipe the DB and every runtime cache IN
   *  PROCESS. See `resetForTest` in composeServer. */
  resetForTest: () => Promise<void>
}

export function composeServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  /** Standalone (non-supervised) boot: hydrate the process registry and ensure
   *  aux schemas. Supervised (dark, Electron-owned DB): skip — the host did. */
  standalone: boolean
  /** `SLAYZONE_HUB_REQUIRE_LOGIN`: every client must sign in. Decides whether the
   *  REST routes that self-guard (join-token, hub users) demand a bearer, so they
   *  can never disagree with the outer gate about whether this hub authenticates. */
  requireLogin: boolean
  /**
   * `SLAYZONE_HUB_PUBLIC_ADDRESS` (`host[:port]`): where browsers and Entra reach
   * this hub. Becomes hub-auth's base URL. Unset = the loopback constant (below).
   */
  publicAddress?: string
  /** SSO sign-in, when on (`assertSsoCredential` in boot-rules.ts): the Entra tenant
   *  setup or a generic OpenID issuer, and the IdP-role mode's config. */
  sso?: HubSsoBootConfig<EntraClientCredential> | null
  /** `SLAYZONE_HUB_ENABLE_PASSWORD` (T-10). Absent = on, the desktop app's hub. */
  enablePassword?: boolean
  /**
   * Flood limits on (T-26): better-auth's rate limiter (hub-auth `rate-limit.ts`) and the
   * unauthenticated `/computers` caps (computer-transport `hub-gateway.ts`). Required, so
   * no caller can forget to decide; `server.ts` passes `boot.reachable`.
   */
  floodLimits: boolean
  /** Separate diagnostics events DB, and the payload-blob dir beside it
   *  (`diagnosticsBlobDirBeside`). When present, `recordDiagnosticEvent` in THIS
   *  process persists (and pre-bind buffered events flush) — without it the
   *  sidecar's diagnostics silently buffer + drop. */
  diagnostics?: { db: SlayzoneDb; blobDir: string }
}): ServerComposition {
  const { db, dataRoot } = opts
  const supervised = !opts.standalone

  // --- Computer transport (always on) -------------------------------------------
  // A hub always accepts computers: the gateway + hub-auth are built and the computer
  // listener binds at startup unconditionally, so a computer can connect (and join
  // tokens can mint) with no mode to flip. Co-located exec still runs IN-PROCESS —
  // a task only routes over the transport when it is explicitly bound to a computer
  // (`resolveTaskComputerId` → null ⇒ local.spawn), so always-on costs the common
  // laptop case nothing at runtime.
  //
  // Single HMAC secret backing hub-auth signing: better-auth's session/cookie
  // signer + the computer enroll/api-key credentials (createHubAuth). (The former
  // per-task agent-hook bearer is gone — a computer-routed hook posts to the
  // computer's own loopback relay, so no per-task token is minted or verified.)
  //
  // SECURITY SEAM (hub-auth-secret hardening): a STANDALONE boot resolves this in
  // bin.ts (applyStandaloneHubConfig → env SLAYZONE_HUB_AUTH_SECRET > config.json
  // computerTransportSecret > generated+persisted 256-bit secret) and sets the env BEFORE
  // composeServer runs. So in standalone the env is ALWAYS present and NEVER the
  // shared dev constant — a per-install unique secret means minted per-task
  // tokens can't be forged across installs (the npm-published bug). We assert
  // that invariant here rather than silently applying the constant. SUPERVISED
  // (Electron host) keeps the historical env-or-dev-constant default untouched:
  // the host controls the env, config.json is never consulted, and a dev/test
  // boot without the env still works exactly as before.
  const DEV_HUB_AUTH_SECRET = 'slayzone-dev-computer-secret'
  if (opts.standalone && !process.env.SLAYZONE_HUB_AUTH_SECRET) {
    // bin.ts must have seeded this; a standalone boot that reached composeServer
    // without it means the resolve step was skipped — fail loud instead of
    // signing tokens with a shared, forgeable constant.
    throw new Error(
      '[slayzone-hub] standalone boot reached composeServer without SLAYZONE_HUB_AUTH_SECRET — ' +
        'applyStandaloneHubConfig() must run first (bin.ts)'
    )
  }
  const hubAuthSecret = process.env.SLAYZONE_HUB_AUTH_SECRET ?? DEV_HUB_AUTH_SECRET
  // Populated by the async computer init (createHubAuth is async — migrations); a
  // later unit reads these after `computersReady` to mount the gateway in server.ts.
  let computerGatewayRef: HubComputerGateway | null = null
  // Direct client ↔ computer capabilities (direct-link.ts). Built with the gateway.
  let directLinkIssuer: DirectLinkIssuer | null = null
  let hubAuthRef: HubAuth | null = null
  // Who a join token is for (T-20), read through the late-bound ref above.
  const joinTokenAccounts = createJoinTokenAccountLookup(() => hubAuthRef)
  let computersReady: Promise<void> = Promise.resolve()
  let computersInitError: Error | null = null
  // Computer listener info the computers router bakes into a join token — bound late
  // by the server host (setComputerListenerInfo) once it knows its own computer URL.
  // Null until then, so `mintJoinToken` fails cleanly if called before the listener
  // is up.
  let computerHubUrl: string | null = null

  // Make this process's diagnostics queryable (pty + agent-pool run here). Bind
  // FIRST so every subsequent recordDiagnosticEvent persists and any buffered
  // pre-bind events flush. No-op if the host didn't pass a diagnostics DB.
  if (opts.diagnostics) {
    bindDiagnosticsDbs({
      settingsDb: db,
      diagnosticsDb: opts.diagnostics.db,
      blobDir: opts.diagnostics.blobDir,
      // The desktop records into this SAME machine-local diagnostics file from
      // its own config copy (the client store), and the Settings UI writes here,
      // over tRPC — so the desktop has to be told, or it keeps recording after
      // the user turns diagnostics off. `bridge` is declared below; this closure
      // only runs on a save, long after composeServer returns.
      //
      // Supervised only, by construction: a standalone hub has no desktop, and a
      // REMOTE hub has no bridge to the client that connects to it — so a remote
      // client's local diagnostics config stays whatever that client set.
      onConfigChanged: (next) => {
        void bridge?.appDeps.diagnosticsConfigChanged(next)
        // The hub's own policy push to every computer, not the saving caller's
        // request: run as the hub (the owner check is for callers' work).
        runAsSecurityActor(null, () => {
          for (const computer of computerGatewayRef?.listComputers() ?? []) {
            void computerGatewayRef
              ?.request(computer.computerId, HubToComputerMethods.chatRequest, {
                kind: 'diagnostics.configure',
                enabled: next.enabled,
                verbose: next.verbose
              })
              .catch(() => console.error('[chat] diagnostic policy sync pending'))
          }
        })
      }
    })
  }

  // Late-bound bound port (set once listen() resolves). Declared up front so the
  // host bridge can report it as the renderer-facing tRPC port (the renderer is
  // connected to THIS side-car, not the host).
  let boundPort = 0

  // --- Desktop capability bridge (supervised only) ---------------------------
  // When supervised by the Electron desktop app, Electron-only capabilities
  // (browser-WCV, clipboard, dialogs, backup, task-windows, floating-agent,
  // native menus, …) can't run in this plain-node process — they forward to the
  // desktop over the bridge, and desktop-originated events (native menus,
  // power-resume) stream back. Truly standalone (no desktop): bridge stays null
  // and the fail-loud stubs apply.
  const desktopCapUrl = getDesktopBridgeCapUrl()
  const bridge: HostBridge | null =
    supervised && desktopCapUrl
      ? createHostBridge(desktopCapUrl, {
          getTrpcPort: () => boundPort,
          token: getDesktopBridgeToken()
        })
      : null

  // --- Cross-domain event buses (this process's own instances) --------------
  const notifyEvents = new TypedEmitter<NotifyEventMap>()
  const automationsEvents = new TypedEmitter<AutomationsEventMap>()
  const telemetryEvents = new TypedEmitter<TelemetryEventMap>()
  // Native menu/app-shortcut events originate in the Electron host; when bridged
  // they arrive on `bridge.menuEvents`, which ALSO carries this process's own
  // emits (the MCP REST task-open route). Standalone: a local inert emitter.
  const menuEvents = bridge ? bridge.menuEvents : new TypedEmitter<MenuEventMap>()
  // Agent-lifecycle (hook-driven turn/state) — the agent-hook REST route lands
  // on THIS process now (pty runs here), so the side-car owns this bus.
  const agentLifecycleEvents = new TypedEmitter<AgentLifecycleEventMap>()

  // Task-row refresh signal. A `TasksChange` names exactly the rows a writer
  // touched, so the renderer patches those instead of reloading the board.
  const notifyTasksChanged = (change?: TasksChange): void => {
    notifyEvents.emit('tasks-changed', change)
  }
  // The generic "something changed" ping (REST/MCP/CLI writes, automations,
  // integrations): refresh tasks AND settings — the caller may have touched
  // either. A caller that names its task rows (`TasksChange`) is a pure
  // task-row write, so it skips the settings refresh: re-reading every
  // settings consumer for a task status flip was the bulk of idle traffic.
  const notifyRenderer = (change?: TasksChange): void => {
    notifyTasksChanged(change)
    if (!change) notifyEvents.emit('settings-changed')
  }

  // Fire-and-forget a best-effort boot task so a rejection can't become an
  // unhandledRejection that kills the whole hub. These are cleanup/optimization
  // steps (startup purge, process-registry hydration) — never load-bearing for
  // serving requests — so a failure (a transiently-locked DB, disk error, or a
  // schema not yet present on a supervised boot the host hasn't finished
  // migrating) must degrade to a logged skip, not a crash. Replaces bare
  // `void asyncThatQueriesTheDb(db)`, which had no catch.
  const bootBestEffort = (label: string, run: () => Promise<unknown>): void => {
    void run().catch((err) => {
      console.warn(
        `[hub] boot step "${label}" skipped: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  // Auth-callback bus — process-local (the sidecar socket server emits, the
  // `app.auth.onCallback` sub consumes; both in THIS process). Set before any
  // WS connection is accepted so the subscription's getAuthEvents() never throws.
  const authEvents = new TypedEmitter<AuthEventMap>()

  setNotifyEvents(notifyEvents)
  setAutomationsEvents(automationsEvents)
  setTelemetryEvents(telemetryEvents)
  setMenuEvents(menuEvents)
  setAgentLifecycleEvents(agentLifecycleEvents)
  setAuthEvents(authEvents)

  // Backup lives with the database now. `supervised` gates restore: on a hub a
  // client merely connects to, a whole-DB overwrite plus an app relaunch is not
  // something one client should be able to do to everyone.
  const backupOps = buildBackupOps({
    db,
    dataRoot,
    dbPath: getDatabasePathFromEnv(),
    supervised: !opts.standalone,
    closeDb: () => db.close(),
    appRelaunch: () => bridge?.appDeps.appRelaunch(),
    shellOpenPath: (p) => void (bridge ? bridge.appDeps.shellOpenPath(p) : nativeOpenPath(p))
  })
  setBackupOps(backupOps)
  // Arm the auto-backup timer at boot. v0.35.0 did (`startAutoBackup(db)` in the host's
  // boot); the hub refactor dropped the call, so the timer only started when someone
  // touched the setting — a user with the switch ON silently stopped getting backups.
  bootBestEffort('auto-backup-start', () => backupOps.startAuto())

  // --- Task ops --------------------------------------------------------------
  // Completion-event bus the task ops emit `db:tasks:*:done` on — handed to every
  // caller of the ops (tRPC via setTaskDeps, REST, MCP). Listeners: integration push
  // and the automation engine's tag trigger, both wired below.
  const taskBus = new EventEmitter()
  // Base task runtime adapters (worktrees = the in-process local git/fs impl from
  // @slayzone/worktrees/server). Extracted so the computer-routing path can re-supply a
  // COMPLETE object (configureTaskRuntimeAdapters shallow-merges over DEFAULTS,
  // not over the prior call — a partial second call would drop these fields).
  const taskWorktreeRouting = createTaskWorktreeRouting({
    db,
    requireLogin: opts.requireLogin,
    usable: () => execGateway?.listUsableComputers() ?? [],
    forTask: (taskId) => resolveComputerForTask(taskId),
    // Read at call time, like `forTask` (`placement` is built below).
    forOwner: (ownerUserId) => placement.forOwner(ownerUserId)
  })
  const baseTaskAdapters = {
    getDataRoot: () => dataRoot,
    worktrees: hubWorktreeExecAdapters,
    worktreePolicy: defaultWorktreePolicyAdapters,
    removeTaskProcesses,
    // A closed task's direct-link grants go with its agents (direct-link.ts).
    killPtysByTaskId: (taskId: string) => {
      killPtysByTaskId(taskId)
      void directLinkIssuer
        ?.revoke({ by: 'task', taskId }, 'task_closed')
        .then(reportDirectRevokeFailures)
    },
    // PTYs + chats here, and chats a computer owns (the stopper wired below).
    stopTaskAgents,
    recordDiagnosticEvent,
    // PTY lifecycle now lives in THIS process (slice 9), so the task-status
    // hooks must run here: status→terminal kills the task's PTYs (→ pty:exit
    // streams to the renderer), status→in_progress suggests a respawn.
    onReachedTerminal: onTaskReachedTerminal,
    requestPtyRespawn: broadcastRespawnRequest,
    // Where a task's worktree work goes (./task-worktree-routing.ts). Read at call
    // time (`placement` is built below, before any request can reach a task op). At
    // boot no computer is connected: the Trash purge waits, and runs again on
    // `computer-connected` (below, R5-1).
    projectRootForTask: taskWorktreeRouting.projectRootForTask,
    worktreeRootForTask: taskWorktreeRouting.worktreeRootForTask,
    worktreeComputerState: taskWorktreeRouting.worktreeComputerState
    // `satisfies`: a seam added to TaskRuntimeAdapters and not wired here fails the
    // typecheck — unwired, it silently falls back to its no-computer default.
  } satisfies TaskRuntimeAdapters
  configureTaskRuntimeAdapters(baseTaskAdapters)
  // Wire the cross-domain "stop a task's agents" seam to the REAL teardown: PTYs
  // + chat transports in THIS process, plus chats owned by a computer. Callers:
  // status→terminal (task-ops onReachedTerminal above, integrations sync/pull)
  // and pty.killTask (closing a scratch terminal's tab). The Electron host's
  // handler only sees its own (empty) session maps post-cutover.
  setTaskAgentsStopper(async (taskId) => {
    runtimeOnTaskReachedTerminal(taskId)
    await computerChat.stopTask(taskId).catch(() => {
      /* Disconnected computers reconcile on reconnect. */
    })
  })
  // The warm pool runs here (initWarmProcessManager below), so this is the one host
  // where a task created to be opened at once can take a warm agent's id.
  // Task ops write task data only — never settings — so they signal tasks-changed
  // alone (`notifyTasksChanged`, not `notifyRenderer`).
  setTaskDeps({
    ops: taskOps,
    onMutation: notifyTasksChanged,
    reserveWarmTaskId,
    bus: taskBus
  })

  // Conversation self-heal + authoritative resolver. `createPty` runs in THIS
  // process post-slice-9, so the healer/resolver seams it calls must be wired
  // here — pre-fix they were registered only in the Electron host, leaving the
  // sidecar's copy null: a stale/phantom conversation id then looped `--resume`
  // ("No conversation found") forever with no self-heal. Same orphaned-listener
  // class as the state-change consumers wired just below.
  // The heal is decided on the agent's computer (its ledger, transcripts and
  // checkout, robustness plan §9); the hub forwards and records its diagnostic.
  registerConversationHealer(db, notifyTasksChanged)
  // The resolver asks the agent's computer (its session ledger, robustness plan
  // §9). Sessions are per terminal tab (v201): the one-time per-tab recovery runs
  // per task on that computer before its first resolve (`computerSessionLedger`).
  registerConversationResolver()

  // Terminal state-change consumers: task auto-move + the needs_attention flag.
  // Both listened in the Electron host pre-cutover and regressed dead at slice 9
  // — the host's onGlobalStateChange registers on ITS bundled pty-manager copy,
  // whose session map is empty post-inversion. Transitions fire in THIS process
  // (the pty runtime lives here), so the consumers must listen here too.
  onGlobalStateChange(async (sessionId, newState, oldState) => {
    await handleTerminalStateChange(
      db,
      sessionId,
      newState,
      oldState,
      notifyTasksChanged,
      onTaskReachedTerminal
    )

    // Attention flag: PTY finished a turn (running → idle|error). Gated on
    // hasSessionUserInput so a spawn/banner settle never flags the task; the
    // renderer clears the flag when the user navigates into the task.
    try {
      const hasUserInput = hasSessionUserInput(sessionId)
      const changed = await handleAttentionTransition(
        db,
        sessionId,
        newState,
        oldState,
        hasUserInput
      )
      // Every attention decision is recorded: the set path failed silently for
      // months (no observable trace between "turn ended" and "flag in DB"), so
      // gate inputs + outcome must be visible in Diagnostics. Low frequency —
      // fires only on state transitions, a few per turn.
      recordDiagnosticEvent({
        level: 'info',
        source: 'task',
        event: 'task.attention_transition',
        sessionId,
        taskId: sessionId.split(':')[0],
        message: `${oldState} -> ${newState}`,
        payload: { hasUserInput, changed }
      })
      // `needs_attention` lives on this task's row only.
      if (changed) notifyTasksChanged({ taskIds: [sessionId.split(':')[0]] })
    } catch (err) {
      recordDiagnosticEvent({
        level: 'error',
        source: 'task',
        event: 'task.attention_transition_failed',
        sessionId,
        taskId: sessionId.split(':')[0],
        message: (err as Error).message
      })
    }
  })

  // Startup purge (stale soft-deleted + orphaned temp tasks) + artifact file
  // watcher. Both ran from the now-deleted registerTaskHandlers IPC bootstrap and
  // so regressed dead at the Slice 9 cutover; restored here in the data-authority
  // boot. The watcher feeds `artifactWatcherEvents` → the tRPC
  // `artifacts.onContentChanged` subscription. Purge is fire-and-forget.
  // E2E baseline: skip the onboarding wizard. Seeded HERE, deterministically, as
  // part of the boot sequence that ends with this process listening — the host
  // cannot write it (no DB handle) and doing it from there after the sidecar came
  // up was a fire-and-forget race that could leave the first spec staring at the
  // onboarding screen.
  if (process.env.PLAYWRIGHT === '1') {
    // Same baseline as `resetForTest`: onboarding done, CLI prompt + tour toast off. Whether the
    // install prompt opens depends on the HOST's `slay`, so it must never be ambient
    // in e2e — specs that test it set `cli_install_dismissed` back themselves.
    bootBestEffort('e2e-onboarding-seed', () =>
      db.run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true'), ('cli_install_dismissed', 'true'), ('tutorial_prompted', 'true')"
      )
    )
  }
  // T-23: session content older than SLAYZONE_HUB_SESSION_RETENTION_DAYS goes, shortly
  // after boot and then daily (session-retention.ts). Off by default — the desktop app's
  // hub creates no timer. Started before the purge below so that, when on, its
  // secure_delete zeroes what the purge frees too.
  startSessionRetention({ db })
  // Open-file watchdog (fd-watch.ts): a descriptor leak is a diagnostics warning long
  // before the hub runs out and every spawn — git included — fails.
  startFdWatch({ record: recordDiagnosticEvent })
  // Repoint migrated icon rows (absolute legacy paths) at the copies the desktop
  // app placed in this root. No-op on a standalone hub / once already repointed.
  bootBestEffort('project-icons-relocate', async () => {
    const moved = await relocateProjectIcons(db, join(dataRoot, 'project-icons'))
    if (moved > 0) console.log(`[project-icons] repointed ${moved} icon path(s) into ${dataRoot}`)
  })
  // Seed v1 versions for artifacts that predate version history. Idempotent, and
  // a domain txn (`artifact-txns.ts`), so `domainTxnRegistry` dispatches it here
  // unchanged. Ran on the Electron host before — which is why a STANDALONE hub
  // never seeded at all, leaving pre-history artifacts permanently version-less.
  bootBestEffort('artifact-version-seed', async () => {
    const report = await db.namedTxn('artifacts:seed-initial-versions', {
      dataDir: dataRoot,
      artifactsDir: join(dataRoot, 'artifacts')
    })
    if (report.seeded > 0 || report.skippedMissing > 0) {
      console.log(
        `[artifact-versions] seeded=${report.seeded} skippedMissing=${report.skippedMissing}`
      )
    }
  })
  startArtifactWatcher(join(dataRoot, 'artifacts'))

  // --- PTY + chat runtime --------------------------------------------------
  // Configure the pty-host bridge with a STUB window. node-pty spawns in THIS
  // process and its output fans out via `ptyEvents` (tRPC subscriptions), but
  // `ptyCreate`/`requestEnsureAlive` still require a non-null target window
  // (the guard pre-dates the tRPC fan-out; the window is otherwise only used by
  // legacy `webContents.send` redirect, a harmless no-op here). Without this the
  // windowless side-car returns "No window found" and terminals never spawn.
  // Theme: dark default (no nativeTheme off-Electron); ack flows via the tRPC
  // `pty.ackEnsureAlive` mutation, so the command bus stays inert.
  const stubPtyWindow: PtySessionWindow = {
    isDestroyed: () => false,
    webContents: { send: noop, getURL: () => '' }
  }
  configurePtyHost({
    getAllWindows: () => [stubPtyWindow],
    getFocusedWindow: () => stubPtyWindow,
    isDarkTheme: () => true,
    bus: { on: () => undefined }
  })
  // Computer resolution for exec routing: a task's explicit binding, else the
  // connected default computer (sole connected, else the one named
  // DEFAULT_LOCAL_COMPUTER_NAME; several unnamed → refuse to guess). On a hub with
  // login only the work owner's computers count, and every request is gated on that
  // again on its way out (T-19, ./computer-placement.ts).
  //
  // Deliberately simple: the reconnect grace + last-known-computer cache that used to
  // live here existed only to keep the no-fallback invariant from failing spawns
  // during a computer reconnect. With the fallback restored they are dead weight, and
  // a cache that can name a dead computer is worse than none. When enforcement lands
  // (plan phases A→D) this is replaced by a single `listUsableComputers()` authority
  // on the gateway, not by re-adding these.
  let execGateway: HubComputerGateway | null = null
  // The desktop's local computer boot window (./local-computer-boot-gate.ts): built
  // with the gateway (supervised hubs only), before the hub serves.
  let localBootGate: LocalComputerBootGate | null = null
  /** A computer-backed read during boot waits for the local computer (S6). */
  const throughLocalBoot = <T>(work: () => Promise<T>, when: BootUnanswered<T>): Promise<T> => {
    const gate = localBootGate
    return gate ? gate.settleWith(work, when) : work()
  }
  const placement = createComputerPlacement({
    db,
    requireLogin: opts.requireLogin,
    // `listUsableComputers`, NOT `listComputers`: usable = authenticated + heard from
    // inside the heartbeat window. An open-but-silent socket would otherwise be
    // picked and every dispatch to it would hang until the watchdog reaped it.
    usable: () => execGateway?.listUsableComputers() ?? []
  })
  const resolveExecComputer = placement.forSpec
  /** `rows` whose project this computer's owner owns — every row without login. */
  const ownProjects = async <T extends { id: string }>(
    computerId: string,
    rows: readonly T[]
  ): Promise<T[]> => {
    if (!opts.requireLogin) return [...rows]
    const out: T[] = []
    for (const row of rows) if (await placement.servesProject(computerId, row.id)) out.push(row)
    return out
  }
  /** Effective computer for a task: explicit binding, else connected default. */
  const resolveComputerForTask = placement.forTask
  /** Same, for a project — its default binding, else the connected default. */
  const resolveComputerForProject = placement.forProject

  // The agent-session ledger (robustness plan §9): created with the computer chat
  // services below, reached by the pty runtime wired before them.
  let computerSessionLedgerRef: ComputerSessionLedger | null = null
  const sessionLedger = (): ComputerSessionLedger => {
    if (!computerSessionLedgerRef) throw new Error('The session ledger is starting')
    return computerSessionLedgerRef
  }
  const sessionStore = lateSessionStore(sessionLedger)

  // Inject computer-aware spawn lookups BEFORE createPtyOps (which captures the
  // lookups at construction). Only `resolveComputerId` is overridden; the mode-row /
  // project-id reads keep their db defaults.
  const dbLookups = createDbPtySpawnLookups(db)
  setPtySpawnLookups({
    ...dbLookups,
    // Hand the task's remaining hub rows (computer-only data, §9) to the computer
    // before an agent of the task starts there: a resume must never miss them.
    resolveComputerId: async (taskId, context) => {
      const computerId = await computerChat.resolvePtyComputer(taskId, context)
      // The hub's remaining rows, its session intents and the task's one-time tab
      // recovery reach that computer before any resume is decided there.
      if (computerId) await sessionLedger().prepare(taskId, computerId)
      return computerId
    },
    resolveProjectComputerId: (projectId) => resolveComputerForProject(projectId)
  })
  // The session ledger is on the computer running the agents (robustness plan §9):
  // the terminal runtime's ledger calls go there (`computerSessionLedger.store`).
  setPtyDeps({ ops: createPtyOps(db, sessionStore), events: ptyEvents })

  // `terminal_tabs.agent_state` recorder — wired HERE for the same reason as
  // `wireIdleClose` below: the pty/chat runtimes live in THIS process, so the
  // Electron host's copy of the recorder fires for sessions it does not own
  // (i.e. never). Without this, no live agent is ever flagged, so
  // `listAutoRestoreTasks` is always empty and a restart lands every task on the
  // Start gate. See ./tab-flag-recorders.ts.
  wireTabFlagRecorders(db)
  // Pty enricher: decorates PtyInfo with task/tab context for the renderer's
  // session views. Registered on the host before, against a pty runtime it no
  // longer owns — the enricher is consulted where the sessions are, i.e. here.
  setPtyEnricher(createPtyEnricher(db))

  // Warm-process pool (plans/agent-sessions.md): pre-warm one agent per active
  // project so opening a task adopts instantly. PTY runs in THIS process
  // (slice 9), so the manager MUST be initialized here — the renderer's warm
  // tab-count reports (`pty.warmSetProjectTabCounts`) land in this process, not
  // the Electron host. It was only ever wired in the host, so it went dead when
  // pty moved to the sidecar; this restores it. `isEnabled` reads a cached
  // `terminal_agent_startup` (sync; refreshed on settings change): the pool runs in
  // the `auto` and `instant` startup modes, not `manual` (`warmPoolEnabled`).
  let prewarmEnabled = false
  const refreshPrewarm = async (): Promise<void> => {
    try {
      const row = await db.get<{ value?: string }>('SELECT value FROM settings WHERE key = ?', [
        AGENT_STARTUP_SETTING
      ])
      prewarmEnabled = warmPoolEnabled(parseAgentStartupMode(row?.value))
    } catch {
      /* keep last-known value */
    }
  }
  void refreshPrewarm()
  // Boot restore (task/server/agent-restore.ts) brings back the chat agents that ran
  // at shutdown as each computer connects. The pool holds NEW warm agents until the
  // first pass is done, so it never boots agents in front of the ones coming back
  // (on 2026-11-11 it booted 7 before any restore had even been asked for). Never
  // held for good: a computer that never connects restores nothing.
  let warmHeldForRestore = true
  const releaseWarmPool = (): void => {
    if (!warmHeldForRestore) return
    warmHeldForRestore = false
    reconcileWarmPool()
  }
  setTimeout(releaseWarmPool, WARM_HOLD_FOR_RESTORE_MAX_MS).unref()
  // Every `settings.set` signals its key now: re-read only for this setting (or an
  // unscoped ping, which may have written anything).
  notifyEvents.on('settings-changed', (change) => {
    if (!change || change.keys.includes(AGENT_STARTUP_SETTING)) void refreshPrewarm()
  })
  initWarmProcessManager({
    db,
    ops: createDbWarmPoolDataOps(db, sessionStore),
    isEnabled: () => prewarmEnabled,
    // `settings.set` writes the row but emits no settings-changed, so the cache
    // above would otherwise stay stale until the next boot — i.e. changing the
    // startup mode in Settings did nothing until restart.
    refreshEnabled: refreshPrewarm,
    // The project's folder on the computer it will warm on (hub copy).
    getProjectRoot: (projectId, computerId) => recordedProjectRoot(db, projectId, computerId),
    // Warm on the computer this project's tasks will actually resolve to. Reads the
    // project's default binding through the SAME resolver a spawn uses, so a warm
    // agent is never booted on a machine no task will land on.
    resolveComputerId: (projectId) => resolveComputerForProject(projectId),
    spawnsAllowed: () => !warmHeldForRestore
  })

  // Chat content and provider processes belong to the owning computer.
  const legacyChatDiagnostics = opts.diagnostics
    ? createLegacyChatDiagnostics({
        db: opts.diagnostics.db,
        blobDir: opts.diagnostics.blobDir,
        resolveTask: createDiagnosticTaskResolver(db)
      })
    : undefined
  if (legacyChatDiagnostics)
    bootBestEffort('chat-privacy-boundary', async () => {
      await legacyChatDiagnostics.initialize()
      const count = await legacyChatDiagnostics.unassigned()
      if (count)
        recordDiagnosticEvent({
          level: 'warn',
          source: 'server',
          event: 'chat.legacy_diagnostics_unassigned',
          payload: { count }
        })
    })
  const chatCompaction = createChatCompaction(db)
  const chatRetentionPolicy = readHubSessionRetentionDays()
  if (!chatRetentionPolicy.ok) throw new Error(chatRetentionPolicy.message)
  const computerChat = createComputerChatServices({
    db,
    retentionDays: chatRetentionPolicy.days,
    onProviderTransitionSuperseded: ({ id, conversationId, taskId, reason }) =>
      recordDiagnosticEvent({
        level: 'warn',
        source: 'server',
        event: 'chat.provider_transition_superseded',
        taskId,
        message: `Provider switch ${id} superseded: ${reason}`,
        payload: { transitionId: id, conversationId }
      }),
    diagnosticsConfig: getDiagnosticsConfig,
    diagnostics: legacyChatDiagnostics,
    // Created below; only called once both exist (a relayed history read, a chat invoke).
    flushTask: (taskId, computerId, kinds) =>
      computerDataHandoff.flushTask(taskId, computerId, kinds),
    legacyData: createDbChatDataOps(db, sessionStore),
    attachments: createChatAttachmentReader(db, dataRoot),
    request: async (computerId, request) => {
      if (!execGateway) throw new Error('Chat computer gateway is starting')
      return execGateway.request(
        computerId,
        HubToComputerMethods.chatRequest,
        request,
        typeof request === 'object' &&
          request !== null &&
          'kind' in request &&
          ['backup.create', 'backup.restore'].includes(String(request.kind))
          ? 120_000
          : typeof request === 'object' &&
              request !== null &&
              'kind' in request &&
              request.kind === 'invoke' &&
              'value' in request &&
              typeof request.value === 'object' &&
              request.value !== null &&
              'method' in request.value &&
              request.value.method === 'askSideQuestion'
            ? SIDE_QUESTION_TIMEOUT_MS + 5_000
            : undefined
      )
    },
    admitComputer: async (computerId) => {
      await placement.forTarget({ computerId })
    },
    // A new chat of the task starts on this computer: hand it the hub's rows first.
    resolveComputer: async (taskId) => {
      const computerId = await resolveComputerForTask(taskId)
      if (computerId) await sessionLedger().prepare(taskId, computerId)
      return computerId
    },
    resolveAvailabilityComputer: async (taskId) => {
      try {
        return await resolveComputerForTask(taskId)
      } catch (error) {
        if (error instanceof BindComputerError) return null
        throw error
      }
    },
    connected: (id) => (execGateway?.listUsableComputers() ?? []).some((c) => c.computerId === id),
    chatRuntimeReady: (id) =>
      (execGateway?.listComputers() ?? []).find((c) => c.computerId === id)?.chatRuntimeReady !==
      false,
    defaultComputer: () => placement.forCaller(),
    gate: async (computerId, taskId) => placement.gate?.(computerId, { kind: 'task', id: taskId }),
    onTasksChanged: (taskId) => notifyTasksChanged({ taskIds: [taskId] }),
    onSessionsChanged: (taskId) => agentSessionsEvents.emit('agent-sessions:changed', { taskId }),
    hasLiveTask: async (taskId) =>
      (await listPtys()).some((p) => p.taskId === taskId && hasLivePty(p.sessionId)) ||
      computerChat.relay.sessions
        .list()
        .some((s) => s.taskId === taskId && !['not-spawned', 'dead', 'error'].includes(s.state)),
    onState: async (sessionId, state, previous, hasUserInput) => {
      if (hasUserInput && state !== 'dead') markSessionUserInput(sessionId)
      else clearSessionUserInputMark(sessionId)
      if (state !== 'not-spawned') {
        const oldState = previous === 'not-spawned' ? 'dead' : previous
        ptyEvents.emit('state-change', sessionId, state, oldState)
        await notifyGlobalStateListeners(sessionId, state, oldState)
      }
    },
    // A chat agent's background commands: the same stream a terminal agent's count is on.
    onBackgroundJobs: (sessionId, count) => {
      ptyEvents.emit('background-jobs', sessionId, count)
    }
  })
  // Computer-only data (robustness plan §9, P0): what the hub still holds of it goes
  // to the computer owning its task, once; reads go to that computer (direct link or
  // this relay), never to a hub copy.
  // The hub's own Needs-attention ledger (no computer): e.g. a task path no computer takes.
  const hubFaults = createAsyncFaultLedger(db, { origin: 'hub' })
  const computerDataHandoff = createComputerDataHandoff({
    db,
    // Through the lifecycle barrier: a task's pause/delete reaches the computer first.
    request: (computerId, request) => computerChat.lifecycle.request(computerId, request),
    track: (taskId, computerId) => computerChat.lifecycle.track(taskId, computerId),
    fallbackTarget: async (taskId) => {
      try {
        return await resolveComputerForTask(taskId)
      } catch (error) {
        if (error instanceof BindComputerError) return null
        throw error
      }
    },
    ledger: (computerId) => createAsyncFaultLedger(db, { origin: 'hub', computerId }),
    isUnreachable: isComputerUnreachable,
    // A task's paths go to the computer holding its folders (§9, Phase 7a).
    kinds: { [TASK_PATH_KIND]: taskPathHandoffKind(db, { ledger: hubFaults }) },
    // The computer a task's paths first reached holds its folders from then on (7e).
    delivered: async (kind, taskId, computerId) => {
      if (kind === TASK_PATH_KIND) await recordHolder(db, taskId, computerId)
      // Restored settings filled in on the computer: open chats re-read them (S4).
      if (kind === CHAT_SETTINGS_KIND) computerChat.relay.settingsChanged(taskId)
    }
  })
  // Every write of a task's worktree path / base dir runs on that computer: the hub
  // keeps no path (§9, Phase 7e), only whether each is set.
  const computerTaskPaths = createComputerTaskPaths({
    db,
    targetOf: (kind, taskId) => computerDataHandoff.targetOf(kind, taskId),
    flushTask: (taskId, computerId, kinds) =>
      computerDataHandoff.flushTask(taskId, computerId, kinds),
    usable: (computerId) => execGateway?.isComputerUsable(computerId) ?? false,
    request: (computerId, request) => computerChat.lifecycle.request(computerId, request),
    ledger: hubFaults
  })
  setTaskPathsDelegate({
    ...computerTaskPaths,
    // A read while the local computer boots waits for it: "loading", never
    // "connect it to start" on a desktop (S6).
    read: (taskIds) =>
      throughLocalBoot(() => computerTaskPaths.read(taskIds), {
        unanswered: (states) => Object.values(states).some((s) => s.state === 'offline')
      })
  })
  computerSessionLedgerRef = createComputerSessionLedger({
    db,
    request: (computerId, request) => computerChat.lifecycle.request(computerId, request),
    // A session read while the local computer boots waits for it (S6).
    target: (taskId) =>
      throughLocalBoot(() => computerDataHandoff.target(taskId), {
        unanswered: (computerId) =>
          computerId === null || !(execGateway?.isComputerUsable(computerId) ?? false)
      }),
    usable: (computerId) => execGateway?.isComputerUsable(computerId) ?? false,
    flushTask: (taskId, computerId) => computerDataHandoff.flushTask(taskId, computerId),
    track: (taskId, computerId) => computerChat.lifecycle.track(taskId, computerId),
    recoverTabs: async (taskId, computerId) => {
      await recoverTaskSessionTabs(
        {
          db,
          diagnostics: opts.diagnostics?.db ?? null,
          record: recordDiagnosticEvent,
          ledger: sessionLedger(),
          computerId
        },
        taskId
      )
    },
    onChanged: (taskId) => agentSessionsEvents.emit('agent-sessions:changed', { taskId })
  })
  const computerSessionLedger = sessionLedger()
  setTaskSessionLedger(computerSessionLedger)
  const computerTaskData = createComputerTaskDataRelay({
    target: (taskId) => computerDataHandoff.target(taskId),
    usable: (computerId) => execGateway?.isComputerUsable(computerId) ?? false,
    flushTask: (taskId, computerId) => computerDataHandoff.flushTask(taskId, computerId),
    request: (computerId, request) => computerChat.lifecycle.request(computerId, request)
  })
  setArtifactStorage(
    dataRoot,
    createComputerArtifactStorage({
      db,
      local: createArtifactStore(dataRoot),
      chat: computerChat,
      request: computerChat.lifecycle.request
    })
  )
  // Full chat events only for tabs a hub client watches (chat-relay-watch.ts).
  const chatRelayWatch = createChatRelayWatch({
    log: (message, detail) => console.warn(`[chat] ${message}`, detail),
    // Each computer hears only of the watched tabs it holds (mid-move: both ends).
    computersOfTab: async (tabId) => {
      const owner = await computerChat.ownership.forTab(tabId)
      if (!owner || owner.state === 'deleted') return []
      return [owner.computerId, owner.sourceComputerId, owner.destinationComputerId].filter(
        (id): id is string => id !== null
      )
    },
    onOwnershipChange: (listener) => computerChat.ownership.onChange(listener),
    computers: () => computerGatewayRef?.listUsableComputers().map((c) => c.computerId) ?? [],
    send: (computerId, config) => {
      const gateway = computerGatewayRef
      if (!gateway) return Promise.resolve()
      return gateway.request(computerId, HubToComputerMethods.chatRequest, {
        kind: 'relay.watch',
        ...config
      })
    }
  })
  setChatDeps({
    ...computerChat.relay,
    resolveScopedLaunch: async (target, ctx) => {
      const launch = await resolveChatAgentLaunch(db, target, (id) => getTaskOp(db, id))
      // The first owner gate checked client input. Check the actual stored folder
      // too: editing a task must not let a launch enter another user's project.
      await checkOwnership({
        ctx,
        path: 'chat.start',
        type: 'mutation',
        getRawInput: async () => launch
      })
      return launch
    },
    computers: computerChat.computers,
    testing: computerChat.testing,
    availability: computerChat.availability,
    watchEvents: chatRelayWatch.watch
  })
  setChatSessionSource(computerChat.relay.sessions)
  // Turn snapshots: an agent terminal's submitted prompt and a chat turn's result.
  // Each is recorded (git and row) on the checkout's computer (§9, v207).
  wireTurnRecording(db, { onPtyInputSubmit, chatEvents: computerChat.relay.events })
  defaultConversationRegistry.registerConversationHolder('chat', computerChat.relay.conversations)
  // Prompt reads while the local computer boots wait for it (S6).
  const promptsOffline = { offline: (e: unknown) => e instanceof AgentHistoryOfflineError }
  setAgentPromptReader((_db, taskId, agentId) =>
    throughLocalBoot(() => computerChat.prompts(taskId, agentId), promptsOffline)
  )
  // A computer-owned chat's settings change on its computer, never in a hub copy.
  setChatSettingsDelegate(computerChat.chatSettings)
  setTaskSessionPromptReader((_db, taskId, ids) =>
    throughLocalBoot(() => computerChat.promptSummaries(taskId, ids), promptsOffline)
  )
  // Every saved event is reported to the hub (`saved`), relayed in full or not
  // (docs/direct-link.md): the prompt lists follow it even for a tab no hub client watches.
  computerChat.relay.events.on('saved', (tabId, saved) => {
    if (saved.kind !== 'user-message' && saved.kind !== 'user-message-delivery') return
    void computerChat.ownership
      .forTab(tabId)
      .then((owner) => {
        if (!owner) return
        agentPromptsEvents.emit('agent-prompts:changed', owner.taskId)
        agentSessionsEvents.emit('agent-sessions:changed', { taskId: owner.taskId })
      })
      .catch(() => console.error('[chat] prompt notification pending'))
  })
  let resettingForTest = false
  const chatNotificationChains = new Map<string, Promise<void>>()
  let maintainComputerChat = (computerId: string, _opts?: { reconnect?: boolean }) =>
    computerChat.lifecycle.sync(computerId)
  let syncComputerChatLifecycle = (computerId: string) => computerChat.lifecycle.sync(computerId)
  let drainComputerChatMaintenance = async () => {
    /* Gateway not initialized yet. */
  }
  const syncChatLifecycle = (): void => {
    if (resettingForTest) return
    // The hub's own housekeeping on every computer — `tasks-changed` fires inside the
    // caller's request that changed a task, but this is not that caller's work.
    runAsSecurityActor(null, () => {
      for (const computer of execGateway?.listUsableComputers() ?? [])
        void syncComputerChatLifecycle(computer.computerId).catch(() => {
          /* Delivery remains pending for the next tick. */
        })
    })
  }
  notifyEvents.on('tasks-changed', syncChatLifecycle)
  // Covers startup purges, offline deletions and legacy tasks never opened in this boot.
  const chatLifecycleTimer = setInterval(syncChatLifecycle, 10_000)
  chatLifecycleTimer.unref()
  const chatMigrationTimer = setInterval(() => {
    if (resettingForTest) return
    for (const computer of execGateway?.listUsableComputers() ?? [])
      void maintainComputerChat(computer.computerId).catch(() => {
        /* Retry disconnected or busy computers on the next tick. */
      })
  }, 60_000)
  chatMigrationTimer.unref()

  // --- AI config / context manager --------------------------------------------
  // Build the ai-config + marketplace ops singletons that back the tRPC
  // aiConfigRouter (getAiConfigOps/getMarketplaceOps). Their initializer used to
  // live in the ai-config IPC handler registrar, deleted at the Slice 9 cutover
  // (commit 9c809e8d) WITHOUT moving init here — so every aiConfig.* proc threw
  // "aiConfigOps not initialized" (context manager fully broken). Restore it in
  // the data-authority boot, alongside the other ops.
  initAiConfigOps(db)

  // --- Integrations + feedback ------------------------------------------------
  // Unconditional now. It was standalone-only because the Electron host ran it in
  // supervised mode — the host no longer opens this database, so if the hub skipped
  // it the integrations tables would simply never be created.
  ensureIntegrationSchema(db)
  const integrationHandles = createIntegrationOps(db)
  setIntegrationOps(integrationHandles)
  // Push local task edits out to Linear/GitHub. Listens on `taskBus` — the SAME
  // bus the task ops emit through (`ipcMain?.emit(...)` with an injected bus).
  // The Electron host held the only listeners, on its real `ipcMain`, which the
  // ops stopped using when they moved here: push-on-edit has been silently dead.
  wireIntegrationPush({
    db,
    taskBus,
    notifyTasksChanged: notifyRenderer,
    pushGithubTask: integrationHandles.pushGithubTask
  })
  // Pull-sync. v0.35.0's host started both pollers at boot; the slice-9 move to the hub
  // took push-on-edit and dropped these, so Linear/GitHub/Jira stopped pulling.
  startIntegrationPollers({ db, notifyTasksChanged: notifyRenderer })
  // Credential encryption needs Electron safeStorage, absent in this
  // ELECTRON_RUN_AS_NODE process. Supervised: forward encrypt/decrypt to the
  // host's safeStorage over the capability bridge (base64 on the wire).
  // Standalone (no host): leave the cipher unset — the plaintext fallback
  // applies, gated purely on cipher availability (no env flag; see
  // integrations/server/credentials.ts allowPlaintextFallback).
  if (bridge) {
    const hostCipher = bridge.appDeps.credentialCipher
    setCredentialCipher({
      isEncryptionAvailable: () => hostCipher.isEncryptionAvailable(),
      encryptString: async (secret) =>
        Buffer.from(await hostCipher.encryptStringToB64(secret), 'base64'),
      decryptString: (encrypted) => hostCipher.decryptStringFromB64(encrypted.toString('base64'))
    })
  }

  // --- Processes ---------------------------------------------------------------
  // This process owns the process-manager runtime: the renderer drives process
  // ops here (supervised) and standalone owns its own. The Electron host no
  // longer inits it in local mode (would double-spawn auto-restart processes).
  bootBestEffort('process-manager-init', () => initProcessManager(db))
  setProcessesDeps({
    create: createProcess,
    spawn: spawnProcess,
    update: updateProcess,
    stop: stopProcess,
    remove: removeProcess,
    restart: restartProcessForUi,
    listForTask,
    listAll: listAllProcesses,
    removeForTask: removeTaskProcesses,
    events: processEvents
  })

  // --- Automation engine (constructed, never started — see header) -------------
  const notifyAutomationsChanged = (): void => {
    automationsEvents.emit('changed')
    notifyRenderer()
  }
  const automationEngine = new AutomationEngine(db, notifyAutomationsChanged)
  // Single-owner engine (slice 9): this is the one process that sees EVERY task
  // mutation — the renderer's tRPC mutations AND the CLI/MCP REST data routes
  // both run here, and `taskEvents` is process-local. So start the engine here
  // (cron + task-event + tag triggers). The Electron host's engine is NOT started
  // in local mode — two engines on the shared DB would double-fire. Electron-only
  // `powerMonitor 'resume'` is forwarded over the bridge → runCatchup().
  automationEngine.start(taskBus)
  // Expose the engine's bus so the tRPC `tags.setForTask` path can fire the
  // tag-change trigger (`db:taskTags:setForTask:done`) — closes the slice-7 gap.
  setTaskTriggerBus(taskBus)
  bridge?.powerResume.on('resume', () => void automationEngine.runCatchup())

  // --- App-level deps: forwarded to the host when bridged (supervised), else
  // fail-loud stubs (truly standalone — no Electron host to forward to).
  if (bridge) {
    setAppDeps(bridge.appDeps)
  } else {
    const silentEmitter = new EventEmitter()
    setAppDeps({
      // No desktop to relaunch when standalone — restore is refused here anyway
      // (see buildBackupOps `supervised`), so this should never be reached.
      appRelaunch: stub('appRelaunch'),
      // Never reached: the only caller is gated on `bridge`, which is null here.
      diagnosticsConfigChanged: stub('diagnosticsConfigChanged'),
      // Task/tab browser registry — there are no WebContentsViews here, so every
      // member fails loud rather than pretending an empty registry (which would make
      // `hasTab` answer "no tab" and turn a missing capability into a 404).
      browserTabs: {
        getResolvedTabId: stub('browserTabs.getResolvedTabId'),
        listTabs: stub('browserTabs.listTabs'),
        hasTab: stub('browserTabs.hasTab'),
        waitForRegistration: stub('browserTabs.waitForRegistration'),
        execJs: stub('browserTabs.execJs'),
        loadUrl: stub('browserTabs.loadUrl'),
        getUrl: stub('browserTabs.getUrl'),
        capturePageToFile: stub('browserTabs.capturePageToFile')
      },

      clipboardWriteFilePaths: stub('clipboardWriteFilePaths'),
      clipboardReadFilePaths: stub('clipboardReadFilePaths'),
      clipboardHasFiles: stub('clipboardHasFiles'),

      screenshotCaptureView: stub('screenshotCaptureView'),

      usageFetch: stub('usageFetch'),
      usageTest: stub('usageTest'),

      // Implemented natively (node fs) — the Task Detail loader calls this uncaught
      // to validate a project path, so a throwing stub would fail the whole load.
      filesPathExists: nativePathExists,
      filesSaveTempImage: stub('filesSaveTempImage'),

      // Open URLs in the OS default browser (per-OS exec). The chromium-fork sidecar
      // has no Electron `shell.openExternal`; the renderer's GitHub-OAuth flow opens
      // the authorize URL through this. The desktop-handoff options are Electron-only
      // (WCV nav policy) and irrelevant headless — ignore them.
      shellOpenExternal: (url: string) => nativeOpenExternal(url),
      // Implemented natively (per-OS exec) so the Git/Editor panels' reveal + open
      // actions work on the standalone/fork sidecar without an Electron host.
      shellOpenPath: nativeOpenPath,
      shellShowItemInFolder: nativeShowItemInFolder,

      appGetVersion: () => '0.0.0-server',
      // Real directory (node os.homedir) — it is only a dialog default, and the
      // dialog itself is the stub that fails loud.
      appGetDownloadsDir: async () => join(homedir(), 'Downloads'),
      appGetTrpcPort: async () => boundPort,
      // Graceful read-path defaults (flag getters / cosmetics) — a throwing stub
      // here would break harmless renderer reads post-flip for no gain.
      appIsTestsPanelEnabled: () => false,
      // No desktop client to hold the flag when standalone.
      appSetLabFlag: stub('appSetLabFlag'),
      appIsLoopModeEnabled: () => false,
      appGetZoomFactor: () => 1,
      appGetProtocolClientStatus: () => ({
        scheme: 'slayzone',
        attempted: false,
        registered: false,
        // Closest existing reason: protocol registration is an Electron concern.
        reason: 'dev-skipped' as const
      }),
      appGetRendererZoomFactor: () => null,
      // Real fs probe (pure Node, no Electron) — the stub hardcoded
      // `installed: false`, so the "Install the slay CLI" dialog auto-opened for
      // every fork user even when the CLI was already installed.
      // PATH + `slay --version` exec on this machine; a hub with processes off must
      // not exec (T-06), so it reports only what is at the install target. No
      // expected version: this build has none to compare (`appGetVersion` above).
      appCheckCliInstalled: async () =>
        hubProcessesEnabled() ? checkCliInstalled() : checkCliInstalledAtTarget(),
      appInstallCli: stub('appInstallCli'),
      appAdjustZoom: stub('appAdjustZoom'),
      appRestartForUpdate: stub('appRestartForUpdate'),
      appCheckForUpdates: stub('appCheckForUpdates'),
      // Read-path: a renderer served BY this server is asking about the server
      // itself — report self status instead of a supervisor snapshot. It IS the
      // running build, so runningBuildId is its own; there's no supervisor here to
      // compare against disk → never stale.
      appGetSidecarStatus: () => ({
        health: 'ready' as const,
        port: boundPort || null,
        pid: process.pid,
        restarts: 0,
        totalRespawns: 0,
        dbPath: null,
        uptimeMs: Math.round(process.uptime() * 1000),
        runningBuildId: getServerBuildInfo().buildId,
        diskBuildId: null,
        stale: false
      }),
      appRevealSidecarLog: stub('appRevealSidecarLog'),

      appWindowGetContentBounds: () => null,
      appWindowGetDisplayScaleFactor: () => null,
      // Window-cosmetic setters no-op off-window in the Electron host too.
      appWindowSetTrafficLightPosition: noop,
      appWindowSetWindowButtonVisibility: noop,
      appFocusRenderer: noop,
      // No window to raise on a headless host.
      appRaiseMainWindow: noop,
      // No OS nativeTheme off-Electron. Default the preference to "system" so the
      // renderer resolves dark/light from `prefers-color-scheme` (ThemeContext);
      // an explicit light/dark still applies for the session. (Cross-restart
      // persistence of an explicit choice in the fork is a follow-up.)
      themeGetEffective: () => 'dark',
      themeGetSource: () => 'system',
      themeSet: async (pref) => (pref === 'light' ? 'light' : 'dark'),
      // No Electron safeStorage on a headless host — report unavailable so the
      // credential store uses its plaintext fallback (gated on availability). The encrypt/
      // decrypt stubs are never reached because the cipher stays unset standalone.
      credentialCipher: {
        isEncryptionAvailable: async () => false,
        encryptStringToB64: stub('credentialCipher.encryptStringToB64'),
        decryptStringFromB64: stub('credentialCipher.decryptStringFromB64')
      },
      // No native menu on a headless host.
      appRebuildMenuForShortcuts: noop,

      // Chromium-fork GitHub OAuth start. Unlike the Electron host (which blocks
      // waiting for the deep-link and returns the code inline), the fork CANNOT
      // receive the callback here — slayzone:// routes to the C++ shell → the
      // sidecar socket (sidecar-socket.ts) → the `app.auth.onCallback` sub. So we
      // only START the flow: fetch the GitHub authorize URL + PKCE verifier, open
      // the browser, and return `pending`. The renderer stashes the verifier and
      // completes the code when the sub delivers it. Reuses the shared
      // requestGithubSignInStart — same PKCE handshake as the Electron host.
      authGithubSystemSignIn: async (input: { convexUrl: string; redirectTo: string }) => {
        // Backstop for the router's check: no Convex POST, no browser open.
        assertHubIntegrationsEnabled({ op: 'sign_in', detail: { provider: 'github' } })
        // The browser opens on THIS machine (xdg-open): not on a hub that runs nothing
        // itself (T-06). Checked before the Convex POST, not swallowed by the catch.
        assertHubLocalExecEnabled({ op: 'shell.open_external', detail: { provider: 'github' } })
        try {
          if (!input?.convexUrl) return { ok: false as const, error: 'Convex URL is required' }
          if (input.redirectTo !== 'slayzone://auth/callback') {
            return { ok: false as const, error: `Unsupported redirect URI: ${input.redirectTo}` }
          }
          const start = await requestGithubSignInStart(
            // T-99 backstop: only this hub's own Convex, never a client-named host.
            hubGithubSignInConvexUrl(input.convexUrl),
            input.redirectTo,
            'chromium-sidecar'
          )
          const openErr = await nativeOpenExternal(start.redirect)
          if (openErr) {
            return {
              ok: false as const,
              verifier: start.verifier,
              error: `Failed to open browser for GitHub sign-in: ${openErr}`
            }
          }
          return { ok: true as const, verifier: start.verifier, pending: true as const }
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : 'GitHub sign-in failed'
          }
        }
      },
      dialogShowOpenDialog: stub('dialogShowOpenDialog'),
      dialogShowSaveDialog: stub('dialogShowSaveDialog'),

      // Artifact export needs an offscreen BrowserWindow — there is no Electron host
      // to forward to here, so these fail loud rather than silently producing nothing.
      artifactBuildExportHtml: stub('artifactBuildExportHtml'),
      artifactRenderPdfToFile: stub('artifactRenderPdfToFile'),
      artifactRenderPngToFile: stub('artifactRenderPngToFile'),
      // No OS window owns this process — nothing to close.
      windowClose: noop,

      browser: {
        createView: stub('browser.createView'),
        destroyView: stub('browser.destroyView'),
        destroyAllForTask: stub('browser.destroyAllForTask'),
        setBounds: stub('browser.setBounds'),
        setVisible: stub('browser.setVisible'),
        setLocked: stub('browser.setLocked'),
        hideAll: stub('browser.hideAll'),
        showAll: stub('browser.showAll'),
        setHandoffPolicy: stub('browser.setHandoffPolicy'),
        navigate: stub('browser.navigate'),
        goBack: stub('browser.goBack'),
        goForward: stub('browser.goForward'),
        reload: stub('browser.reload'),
        stop: stub('browser.stop'),
        executeJs: stub('browser.executeJs'),
        insertCss: stub('browser.insertCss'),
        setForcedTheme: stub('browser.setForcedTheme'),
        removeCss: stub('browser.removeCss'),
        setZoom: stub('browser.setZoom'),
        focus: stub('browser.focus'),
        findInPage: stub('browser.findInPage'),
        stopFindInPage: stub('browser.stopFindInPage'),
        setKeyboardPassthrough: stub('browser.setKeyboardPassthrough'),
        sendInputEvent: stub('browser.sendInputEvent'),
        openDevTools: stub('browser.openDevTools'),
        closeDevTools: stub('browser.closeDevTools'),
        isDevToolsOpen: stub('browser.isDevToolsOpen'),
        getUrl: stub('browser.getUrl'),
        getBounds: stub('browser.getBounds'),
        getZoomFactor: stub('browser.getZoomFactor'),
        getActualNativeBounds: stub('browser.getActualNativeBounds'),
        getViewVisible: stub('browser.getViewVisible'),
        getViewsForTask: () => [],
        getAllViewIds: () => [],
        listViews: () => [],
        getNativeChildViewCount: () => 0,
        isAllHidden: () => true,
        isFocused: () => false,
        isViewNativelyVisible: () => false,
        getPartition: stub('browser.getPartition'),
        getWebContentsId: stub('browser.getWebContentsId'),
        activateExtension: stub('browser.activateExtension'),
        getExtensions: () => [],
        loadExtension: stub('browser.loadExtension'),
        removeExtension: stub('browser.removeExtension'),
        discoverBrowserExtensions: () => [],
        importExtension: stub('browser.importExtension'),
        reparentToCurrentWindow: stub('browser.reparentToCurrentWindow'),
        // Event-shaped nav-state replay for late onEvent subscribers — none exist
        // in a WCV-less host.
        getAllStateSnapshots: () => [],
        getStateSnapshot: () => null,
        events: silentEmitter as AppDeps['browser']['events']
      },

      floatingAgent: {
        setEnabled: stub('floatingAgent.setEnabled'),
        setSessionId: stub('floatingAgent.setSessionId'),
        setPanelOpen: stub('floatingAgent.setPanelOpen'),
        toggleCollapse: stub('floatingAgent.toggleCollapse'),
        resetSize: stub('floatingAgent.resetSize'),
        detach: stub('floatingAgent.detach'),
        reattach: stub('floatingAgent.reattach'),
        getState: (): FloatingAgentState => ({
          kind: 'disabled',
          sessionId: null,
          mode: null,
          hasCustomSize: false
        }),
        getSession: () => null,
        getConfig: () => null,
        events: silentEmitter as AppDeps['floatingAgent']['events']
      },

      webview: {
        // Browser-tab bookkeeping exists to drive native z-order; there are no
        // native child views here, so registration has nothing to track.
        registerBrowserTab: noop,
        unregisterBrowserTab: noop,
        setActiveBrowserTab: noop,
        closeDevTools: stub('webview.closeDevTools'),
        isDevToolsOpened: () => false,
        disableDeviceEmulation: stub('webview.disableDeviceEmulation'),
        registerShortcuts: stub('webview.registerShortcuts'),
        setKeyboardPassthrough: stub('webview.setKeyboardPassthrough'),
        setDesktopHandoffPolicy: stub('webview.setDesktopHandoffPolicy'),
        openDevToolsBottom: stub('webview.openDevToolsBottom'),
        openDevToolsDetached: stub('webview.openDevToolsDetached'),
        enableDeviceEmulation: stub('webview.enableDeviceEmulation'),
        events: silentEmitter as AppDeps['webview']['events']
      },

      taskWindows: {
        open: stub('taskWindows.open'),
        close: stub('taskWindows.close'),
        list: () => [],
        setPrimaryActive: noop,
        getPrimaryActive: () => null,
        claimPanel: stub('taskWindows.claimPanel'),
        releasePanel: stub('taskWindows.releasePanel'),
        releaseAllForTask: stub('taskWindows.releaseAllForTask'),
        getOwnership: () => [],
        getWindowId: () => null,
        claimAndCloseOther: stub('taskWindows.claimAndCloseOther'),
        // Every window gets pty output through its own subscription here: there is
        // no per-window routing to claim (Electron main's legacy webContents path).
        // Renderers claim on every mount/focus, so this is normal, not a bug.
        claimSession: () => ({ ok: true }),
        events: silentEmitter as AppDeps['taskWindows']['events']
      }
    })
  }

  // Idle-close: config getter + sweep + the browser panel's engagement touch, all
  // in THIS process because the pty sessions are here (./idle-close.ts). After
  // setAppDeps: the browser `engaged` events arrive on its (bridged) emitter.
  const idleClose = wireIdleClose(db, getAppDeps().browser.events)

  // PTY state-machine bridge — shared by the agent-hook HTTP route (restDeps
  // below) AND the computer-relay `event` consumer (wired in the async gateway
  // block), so a local loopback hook and a computer-relayed hook drive the exact
  // same state machine through the exact same authority (processAgentHook).
  const terminalStateBridge = {
    findSession: findSessionByTaskIdAndMode,
    transition: transitionStateFromHook,
    markActive: markSessionActiveFromHook,
    noteConversationId: noteSessionConversationId,
    noteAwaitingInput: setSessionAwaitingInput,
    noteBackgroundJobs: setSessionBackgroundJobs,
    probeBackgroundJobs: (
      sessionId: string,
      jobs: ReadonlyArray<{
        id: string
        kind: 'shell' | 'monitor'
        command: string | null
      }>
    ) => probeSessionBackgroundJobs(sessionId, [...jobs])
  }

  // Drop the session's agent-tree (subagent-liveness tracker) so a killed PTY
  // can't leave a stale subagent id behind forever — without this, a session
  // killed mid-turn (rather than exited cleanly; SIGKILL doesn't let claude
  // fire its own `SessionEnd` hook) permanently sticks resolveState on
  // 'background': spinner never clears though nothing is running.
  //
  // Two listeners, not because `exit` needs an id-reuse guard (it doesn't —
  // see below) but because `exit` is unreliable for the replace/respawn case
  // specifically:
  //  - `exit` fires unconditionally and is ALWAYS safe to act on: both the
  //    natural onExit path (`session.pty !== target` guard) and the kill
  //    watchdog (`sessions.get(sessionId) === session` guard) in pty-manager.ts
  //    only ever invoke the finalizer for the CURRENTLY-registered generation
  //    at that session id — so `exit` can never fire for a generation that has
  //    already been replaced. (Do NOT re-add a `!hasPty` check here: the id is
  //    deliberately still present when `exit` fires — `sessions.delete` is
  //    deferred ~100ms past the emit to let trailing onData drain — so such a
  //    guard is always-false and makes eviction unreachable for every plain
  //    kill, which is the common case this fix targets.)
  //  - The flip side is that `exit` NEVER fires for the OUTGOING generation of
  //    a replace: `createPty`'s replace-existing-session branch calls
  //    `killPty` and immediately spawns the new session on the same id
  //    (without awaiting the old process's actual death), so by the time the
  //    old process's onExit/watchdog would otherwise run, the identity guards
  //    above see the new session and skip the old finalizer entirely — the old
  //    tree would never be evicted through this path. `replacing` fires
  //    SYNCHRONOUSLY at the moment of replacement, strictly before the new
  //    session exists, to cover exactly that gap.
  ptyEvents.on('replacing', (sessionId) => evictAgentTree(sessionId))
  ptyEvents.on('exit', (sessionId) => evictAgentTree(sessionId))

  // T-12: disabling an account (or an Entra refusal) also ends its web sessions, its
  // open /trpc sockets and its computers — see user-access.ts.
  const trpcConnections = createTrpcConnectionRegistry()
  const userAccess = createUserAccessRevoker({
    db,
    getGateway: () => computerGatewayRef,
    connections: trpcConnections,
    revokeDirectGrants: async (userId) =>
      reportDirectRevokeFailures(
        await directLinkIssuer?.revoke({ by: 'user', userId }, 'user_access_ended')
      )
  })
  // Break-glass (break-glass.ts): off unless login is required; closing its account
  // revokes everything the account holds, like disabling any other (T-12).
  const breakGlass = createBreakGlass({
    getAuth: () => hubAuthRef,
    requireLogin: opts.requireLogin,
    revokeUser: (userId) => userAccess.revokeUser(userId)
  })

  // --- REST deps (capability slots; absent → 501) ------------------------------
  const hubUsers = createHubUsersCapability(() => hubAuthRef, userAccess, { db })
  const adminErasure = createAdminContentErasure({
    db,
    dataRoot,
    findUser: async (id) => {
      if (!hubAuthRef) throw new Error('Hub accounts are unavailable')
      return findHubUser(hubAuthRef, id)
    }
  })
  setHubAdminDeps({ dataRoot, users: hubUsers, erasure: adminErasure })
  configureContentErasure(db, {
    cleanupAdditionalStores: async (target) => {
      if (!opts.diagnostics) return
      await flushWriteQueue()
      await eraseDiagnosticContent(opts.diagnostics.db, opts.diagnostics.blobDir ?? null, target)
    },
    compactAdditionalStores: async () => {
      if (opts.diagnostics) await compactDiagnosticContent(opts.diagnostics.db)
    },
    // Item deletes return once rows/files are gone; the VACUUM that removes their old
    // free pages and WAL frames runs once per burst, and only then are they complete.
    compaction: { quietMs: 30_000, maxDelayMs: 5 * 60_000 },
    beforeDelete: async (taskIds) => {
      for (const taskId of taskIds) {
        baseTaskAdapters.killPtysByTaskId(taskId)
        baseTaskAdapters.removeTaskProcesses(taskId)
      }
    },
    beforeResume: async (scope) => {
      if (scope.kind !== 'user') return
      const user = hubAuthRef ? await findHubUser(hubAuthRef, scope.userId) : null
      if (!user?.disabledAt) throw new Error('USER_NOT_DISABLED')
    },
    cleanupComputer: async (request) =>
      runAsSecurityActor(null, async () => {
        if (!execGateway?.listUsableComputers().some((c) => c.computerId === request.computerId))
          throw new Error('COMPUTER_UNAVAILABLE')
        const gateway = execGateway
        return eraseTasksOnComputer({
          taskIds: request.taskIds,
          ledger: createAsyncFaultLedger(db, { origin: 'hub', computerId: request.computerId }),
          revisionOf: async (taskId) =>
            (
              await db.get<{ revision: number }>(
                'SELECT revision FROM chat_task_lifecycle WHERE task_id=?',
                [taskId]
              )
            )?.revision ?? null,
          erase: async (taskId, revision) =>
            (await gateway.request(
              request.computerId,
              HubToComputerMethods.chatRequest,
              { kind: 'task.erase', jobId: request.jobId, taskId, revision },
              60_000
            )) as ErasureReply
        })
      }),
    // An unbound task's worktree is on the default computer (the old Trash purge's
    // rule); the engine persists the pick so retries never follow a later default.
    resolveWorktreeComputer: taskWorktreeRouting.erasedWorktreeComputer,
    // The hub keeps no path (§9, 7e): the computer holding the worktree names it.
    releaseWorktree: async (target, liveTaskIds) =>
      runAsSecurityActor(null, async () => {
        if (!target.computerId || !execGateway?.isComputerUsable(target.computerId))
          throw new Error('COMPUTER_UNAVAILABLE')
        const answer = (await computerChat.lifecycle.request(target.computerId, {
          kind: 'taskPaths',
          value: { op: 'release', taskId: target.taskId, liveTaskIds }
        })) as { worktreePath: string | null; shared: boolean }
        if (!answer || typeof answer.shared !== 'boolean')
          throw new Error('Invalid task path release answer')
        return answer
      }),
    forgetWorktree: async (target) =>
      runAsSecurityActor(null, async () => {
        if (!target.computerId || !execGateway?.isComputerUsable(target.computerId)) return
        await computerChat.lifecycle
          .request(target.computerId, {
            kind: 'taskPaths',
            value: { op: 'forget', taskId: target.taskId }
          })
          .catch(() => undefined)
      }),
    cleanupWorktree: async (target) =>
      runAsSecurityActor(null, async () => {
        if (!target.computerId || !target.repoPath || !target.path)
          throw new Error('WORKTREE_LOCATION_UNKNOWN')
        if (!execGateway?.listUsableComputers().some((c) => c.computerId === target.computerId))
          throw new Error('COMPUTER_UNAVAILABLE')
        await execGateway.request(
          target.computerId,
          'git.removeWorktree',
          { projectPath: target.repoPath, worktreePath: target.path },
          60_000
        )
      }),
    onProgress: () => notifyRenderer()
  })
  const erasureRetries = startErasureRetries(db, dataRoot)
  const restDeps: RestApiDeps = {
    captureAgentPrompt: computerChat.captureHook,
    // The agent-session ledger is on the computer running the reporting agent (§9).
    agentSessionLedger: {
      computerFor: async (hook, reporterComputerId) => {
        if (reporterComputerId) return reporterComputerId
        const live = findSessionByTaskIdAndMode(hook.taskId, hook.mode as AgentId, hook.tabId)
        const running = live ? getPtyDirectTarget(live)?.computerId : null
        return running ?? (await computerSessionLedger.forTask(hook.taskId))
      },
      recordHookConversation: (computerId, args) =>
        computerSessionLedger.recordHookConversation(computerId, args),
      confirmSessionConversation: (computerId, args) =>
        computerSessionLedger.confirmSessionConversation(computerId, args),
      markSessionFirstTurn: (computerId, conversationId) =>
        computerSessionLedger.markSessionFirstTurn(computerId, conversationId)
    },
    db,
    notifyRenderer,
    automationEngine,
    agentLifecycle: agentLifecycleEvents,
    menu: menuEvents,
    taskBus,
    // NOTE: no per-task hub-bearer verifier. A computer-routed pty's hook posts to
    // the COMPUTER's own loopback relay (which forwards to the hub over the authed
    // ws channel via the gateway `event` consumer wired below) — the hook never
    // carries a bearer, so there is nothing to verify on the agent-hook route.
    //
    // SECURITY DECISION (intentional — do NOT re-add per-task scoping): the old
    // path minted a per-task bearer and rejected a hook whose token taskId != the
    // payload taskId. That guarded a threat this trust model does not have. The
    // standing trust boundary is TWO layers: (1) the computer→hub ws channel is
    // AUTHENTICATED at enroll (hub-auth api-key), so only an enrolled computer can
    // relay hooks at all; (2) `processAgentHook` only mutates a session that
    // `bridge.findSession(taskId, mode)` actually resolves, so a hook cannot
    // fabricate state for a non-existent session. An enrolled computer already
    // executes the agents and spawns the PTYs for its tasks — a per-hook bearer
    // guarded a side door on a house whose front door it already holds. Re-adding
    // it would also force per-agent bearers back into subprocess env, undoing the
    // byte-identical-local-vs-remote agent env the benign-forwarder redesign won.
    // FUTURE TRIGGER: if computers ever become UNTRUSTED / multi-tenant, restore
    // scoping as a CHANNEL-level claim (computer X may only drive tasks assigned to
    // X), NOT a per-agent bearer.
    // Computer listener info for the loopback `POST /api/computers/join-token` route —
    // the MAIN process's boot-time auto-enroll mints through it (no tRPC client in
    // main). Closed over the SAME late-bound refs the computers registry reads
    // (setComputerListenerInfo feeds them once the /computers listener binds).
    computers: {
      getHubUrl: () => computerHubUrl,
      // Same late-bound ref the tRPC `computers.list` reads, so the REST twin
      // (`GET /api/computers`, what `slay computer ls` calls) can never report a
      // different connection status than the app's Computers tab.
      getGateway: () => computerGatewayRef,
      // Who a join token is for (T-20): the same lookup as `computers.mintJoinToken`.
      findAccount: joinTokenAccounts,
      // What the desktop's main process may add to its CSP (direct-link-gate.ts).
      directAddresses: (userId) => directLinkIssuer?.issuedAddresses(userId) ?? [],
      // `slay hub computers takeovers|replace`: the same offers and refusals as tRPC.
      takeoverCandidates: () => computerChat.takeoverCandidates(),
      localComputerId: supervised ? deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME) : null
    },
    // Operator account management for the `/api/hub/users` routes
    // (`slay hub users add|ls|disable|enable|role`) — the ONLY way to create an
    // account now that public signup is closed (hub-auth auth.ts `disableSignUp`).
    //
    // Closed over the SAME late-bound `hubAuthRef` that `get hubAuth()` below reads,
    // for the same reason the `computers` slot above is getter-shaped: hub-auth is
    // built inside the async `computersReady` IIFE, long after this literal is
    // constructed. `ready` is therefore a function, never a captured value — and it
    // stays false permanently if `createHubAuth` threw (that failure is swallowed
    // into a diagnostic), which the route surfaces as a 503 naming
    // `computer.init_failed`. Disabling also revokes the account's web sessions,
    // sockets and computers (see user-access.ts).
    hubUsers,
    // Bearer authority for routes that self-guard rather than sitting behind the
    // outer gate — `POST /api/computers/join-token` (so `slay computer mint` can
    // target a hub on another machine) and `/api/hub/users` (so `slay hub users …`
    // keeps working once loopback alone is no longer sufficient).
    //
    // Deliberately the SAME two pieces the outer gate uses — the login switch and
    // `verifyRestBearer` — so a route-level decision can never disagree with the
    // gate about whether this hub authenticates at all, or about which sessions
    // count. Getter-shaped for the usual reason: hub-auth is built inside the
    // async `computersReady` IIFE, long after this literal exists.
    //
    // Keyed on the switch, not on `supervised` and not on a deployment mode: an
    // earlier version derived this from the mode and `hubAuthRef !== null`, which
    // drifted from the outer gate and let a loopback peer (any peer, behind a reverse
    // proxy) mint join tokens and administer accounts with no bearer. False when
    // login is off (the desktop app's hub), which keeps both routes loopback-only
    // there exactly as before.
    restAuth: {
      required: () => opts.requireLogin && hubAuthRef !== null,
      verifyBearer: (headers, cookies) =>
        verifyRestBearer(hubAuthRef, db, headers, cookies, breakGlass)
    },
    // Scoped browser login. Absent only when hub-auth failed to init — a hub with
    // login off has no meaningful login to offer, but the slot itself does not
    // depend on the switch: nothing stops an operator from opening the web UI
    // against such a hub's loopback listener, and doing so should behave the same
    // as any other hub's login.
    webLogin: {
      login: (email, password) =>
        webLogin(hubAuthRef, db, email, password, {
          secure: webSessionCookieSecure(opts.publicAddress)
        })
    },
    // Raise the host window for the CLI/agent `tasks/open` foreground path. The
    // route itself runs HERE (emits the `open-task` menu event on the side-car's
    // bus → renderer); only the window raise is bridged to the Electron host.
    windowActions: bridge
      ? { raiseMainWindow: () => void bridge.appDeps.appRaiseMainWindow() }
      : undefined,
    // Artifact export runs HERE — the `task_artifacts` row it needs is in THIS
    // process's DB. Only the offscreen render crosses to the Electron host, via
    // the same three AppDeps slots the tRPC download path already uses. That is
    // the inversion: previously the whole handler was reverse-proxied to the
    // desktop, which then needed its own connection to the shared DB purely to
    // answer a request this process had just forwarded to it.
    //
    // Absent when standalone (no host to render on) → the routes 501, unchanged.
    artifactExport: bridge
      ? {
          buildExportHtml: (content, mode, title) =>
            bridge.appDeps.artifactBuildExportHtml(content, mode, title),
          renderPdfToFile: (content, mode, title, destPath) =>
            bridge.appDeps.artifactRenderPdfToFile(content, mode, title, destPath),
          renderPngToFile: (content, mode, title, destPath) =>
            bridge.appDeps.artifactRenderPngToFile(content, mode, title, destPath)
        }
      : undefined,
    // Browser routes also run HERE now: they read and write `tasks.browser_tabs`,
    // which is in THIS process's DB, and reach the host only for operations on the
    // live WebContents. That pairing is why they used to be proxied wholesale —
    // the old BrowserAccess handed back a handle, so the handler had to run where
    // the handle was, which is not where the row is.
    //
    // Absent when standalone (no WebContentsViews) → the routes 501, unchanged.
    browser: bridge
      ? {
          // Every member is async — the registry lives on the host, so each one is
          // a bridge round-trip. `BrowserAccess` was made async wholesale rather
          // than cached here on purpose: a snapshot of "which tabs exist" goes
          // stale the moment a user closes one, and these routes exist to drive a
          // live browser.
          getResolvedBrowserTabId: (taskId, tabId) =>
            bridge.appDeps.browserTabs.getResolvedTabId(taskId, tabId),
          listBrowserTabs: (taskId) => bridge.appDeps.browserTabs.listTabs(taskId),
          hasBrowserTab: (taskId, tabId) => bridge.appDeps.browserTabs.hasTab(taskId, tabId),
          waitForBrowserRegistration: (taskId, opts) =>
            bridge.appDeps.browserTabs.waitForRegistration(taskId, opts),
          execJs: (taskId, tabId, code) => bridge.appDeps.browserTabs.execJs(taskId, tabId, code),
          loadUrl: (taskId, tabId, url) => bridge.appDeps.browserTabs.loadUrl(taskId, tabId, url),
          getUrl: (taskId, tabId) => bridge.appDeps.browserTabs.getUrl(taskId, tabId),
          capturePageToFile: (taskId, tabId, destPath) =>
            bridge.appDeps.browserTabs.capturePageToFile(taskId, tabId, destPath)
        }
      : undefined,
    pty: {
      listPtys,
      hasPty,
      hasLivePty,
      getBuffer,
      getBufferSince,
      writePty,
      submitPty,
      killPty,
      requestEnsureAlive,
      subscribeToPtyData,
      subscribeToStateChange,
      onSessionChange,
      getState
    },
    // CLI completion guard: PTYs + chats (every computer) of the task mid-reply.
    taskAgents: {
      midReplySessionIds: async (taskId) =>
        midReplySessionIds(taskId, [...(await listPtys()), ...computerChat.relay.sessions.list()])
    },
    // `slay chat` / `slay agent`: the chat relay, the state bus chat states share
    // with ptys, and the task's main-agent resolution (`task.startMainAgent`'s).
    chat: {
      deps: getChatDeps,
      onStateChange: (cb) => {
        const listener = (sessionId: string, state: TerminalState) => cb(sessionId, state)
        ptyEvents.on('state-change', listener)
        return () => ptyEvents.off('state-change', listener)
      },
      launch: (taskId) => resolveMainAgentLaunch(db, taskId, (id) => getTaskOp(db, id)),
      startMain: (taskId) => startMainAgent(db, { taskId }, (id) => getTaskOp(db, id))
    },
    terminalStateBridge,
    processes: {
      listAll: listAllProcesses,
      remove: removeProcess,
      stop: stopProcess,
      start: startProcess,
      restart: restartProcessDetailed,
      subscribeToLogs: subscribeToProcessLogs
    }
  }

  // Open the host event stream + prime the browser snapshot cache. Done last so
  // the local emitters (set via setAppDeps above) exist before frames arrive.
  bridge?.connect()

  // --- Computer gateway + hub-auth (async; dark until a computer enrolls) ----------
  // Built off the main path because `createHubAuth` runs better-auth migrations
  // (async). Ordering is safe: the ledger DB stays local (Model A — never
  // proxied); `setPtySpawnLookups` already ran synchronously above; and the
  // routing backends are read per-spawn via getPtyBackend()/getProcessBackend(),
  // so injecting them once the gateway resolves takes effect for later spawns
  // without a mid-session straddle. With no computer registered every spawn's
  // resolved computerId is null → the routing backends fall through to local, so
  // behavior matches computer-OFF until a computer actually enrolls.
  // Populate the computers registry synchronously (the router may be called before
  // the async gateway init below resolves). The getters read the late-bound refs,
  // so `list` sees the gateway once it exists and `mintJoinToken` sees the
  // URL once the server host feeds it via setComputerListenerInfo.
  // Needs attention (P3): the hub's own faults and each computer's, over the
  // late-bound gateway (a computer not connected shows its last snapshot).
  const itemFaults = createItemFaultService({
    db,
    isConnected: (computerId) =>
      !!execGateway?.listUsableComputers().some((c) => c.computerId === computerId),
    requestComputer: async (computerId, value) => {
      if (!execGateway) throw new Error('COMPUTER_UNAVAILABLE')
      return execGateway.request(computerId, HubToComputerMethods.chatRequest, value, 30_000)
    }
  })
  setComputersDeps({
    itemFaults,
    getGateway: () => computerGatewayRef,
    getHubUrl: () => computerHubUrl,
    // Who a join token is for (T-20), over the late-bound hub-auth ref; consulted
    // only on a hub with login. The REST twin reads the same function.
    findAccount: joinTokenAccounts,
    // Before the gateway is up there is no computer to reach: the client relays.
    issueDirectLink: (target, caller, options) =>
      directLinkIssuer
        ? directLinkIssuer.issue(target, caller, options)
        : Promise.resolve({ available: false, reason: 'no-computer' }),
    directRtcConnect: (grantId, sdp, caller) =>
      directLinkIssuer
        ? directLinkIssuer.rtcConnect(grantId, sdp, caller)
        : Promise.resolve({ ok: false, reason: 'refused' }),
    // The desktop app's own co-spawned computer (its enroll name always maps to this
    // id, see the local-computer dedup below) is never disabled or deleted on its own
    // hub. A standalone hub spawns no computer of its own, so it protects none.
    localComputerId: supervised ? deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME) : null,
    // What blocks disabling a computer: its terminals, agents and processes, asked of the
    // computer itself. Not connected yet (gateway still starting) = nothing runs.
    runningWorkOn: async (computerId) =>
      computerGatewayRef ? countRunningWork(computerGatewayRef, computerId) : 0,
    // Chats a computer holds that the hub assigns to another (a re-enrolled machine):
    // offered to the user as "replace <old> with <new>" (`computers.takeovers`).
    takeoverCandidates: () => computerChat.takeoverCandidates(),
    // Live status for the Settings list, from the events the gateway ALREADY
    // emits. Their only consumer until now was exec-proxies disposing pty
    // sessions, so every signal about a computer going away was computed and
    // discarded — the list had no polling and refreshed only on a click.
    //
    // The gateway ref is late-bound, so resolve it when someone subscribes; a
    // subscription opened before init returns an inert unsubscribe rather than
    // capturing null forever.
    subscribeComputerStatus: (listener) => {
      const gateway = computerGatewayRef
      if (!gateway) return () => undefined
      const up = (p: { computer: { computerId: string } }): void =>
        listener({ computerId: p.computer.computerId, connected: true })
      const down = (p: { computerId: string }): void =>
        listener({ computerId: p.computerId, connected: false })
      gateway.events.on('computer-connected', up)
      gateway.events.on('computer-disconnected', down)
      // The watchdog's own event — this is what covers a socket that is open but
      // silent, which no client-side timer could observe.
      gateway.events.on('computer-lost', down)
      return () => {
        gateway.events.off('computer-connected', up)
        gateway.events.off('computer-disconnected', down)
        gateway.events.off('computer-lost', down)
      }
    }
  })

  // Remote-MCP-env provider. Wired synchronously here — it depends only on
  // boundPort (read LAZILY inside the closure), which does not need the async
  // gateway — so a computer-routed pty spawned before `computersReady` resolves still
  // gets a valid hub base URL (used by the `slay` CLI's hub REST access). A task
  // not bound to a computer keeps today's loopback env (the provider short-circuits
  // on a null computerId). See `createRemoteMcpEnvProvider` for hubBaseUrl derivation.
  setRemoteMcpEnvProvider(createRemoteMcpEnvProvider({ getBoundPort: () => boundPort }))

  computersReady = (async () => {
    const sso: SsoConfig | undefined = opts.sso ? ssoConfigFromBoot(opts.sso) : undefined
    const hubAuth = await createHubAuth({
      dbPath: resolveAuthDbPath(dataRoot),
      // better-auth baseURL. A hub other machines reach is addressed by its public
      // address (`https://` unless the host is loopback, rule A1): it is where Entra
      // redirects back to (`<baseURL>/api/auth/callback/microsoft`, registered on the
      // app) and the origin browsers send. Without one — the desktop app's hub and
      // every loopback-only hub — a fixed loopback constant, as before: computers
      // authenticate by api-key/bearer, never by cookies or redirects, so nothing
      // there reads it.
      baseURL: opts.publicAddress
        ? hubUrlFromAddr(opts.publicAddress, 'http')
        : 'http://127.0.0.1:8788',
      // The same browser origins the /trpc origin guard accepts (the public origin plus
      // SLAYZONE_HUB_ALLOWED_WEB_ORIGINS), for better-auth's callback-URL and CSRF
      // checks. Empty on the desktop app's hub (its parent clears both variables).
      trustedOrigins: resolveAllowedWebOrigins(),
      secret: hubAuthSecret,
      ...(sso ? { sso } : {}),
      // Off: no password sign-in or account with a password (hub-auth password.ts).
      ...(opts.enablePassword === false ? { enablePassword: false } : {}),
      rateLimit: opts.floodLimits
    })
    hubAuthRef = hubAuth
    // The IdP-role mode (hub-auth idp-roles.ts): its revocations reach what lives here —
    // web sessions, open sockets, direct-link grants — and a role change closes the
    // account's sockets. Attaching also revokes, here, the access of every human this
    // boot's activation invalidated, BEFORE the hub serves (server.ts awaits this).
    const idp = idpRolesOf(hubAuth)
    if (idp) {
      await idp.attachHub({
        revokeExternal: (userId) => userAccess.endSessions(userId),
        onRoleChange: (userId) => userAccess.reconnectUser(userId),
        hasExternalSession: (userId) => hasLiveWebSession(db, userId, SSO_WEB_SESSION_LIFETIME)
      })
      // A `/trpc` socket closes at its account's evidence deadline unless re-proven.
      trpcConnections.setDeadline((userId) => idp.deadlineMs(userId))
    }
    // T-12: with SSO sign-in, every signed-in account is re-checked with the issuer
    // hourly — or, in the IdP-role mode, swept ahead of its deadline (sso-recheck.ts).
    // No-op without SSO — the desktop app's hub creates no timer.
    startSsoRecheck({ auth: hubAuth, sso, db, revoker: userAccess })
    // Identity-based local-computer dedup (Wave3.5-D5): tell the auth adapters
    // which enroll name is the co-located auto-spawned computer so it collapses to
    // ONE deterministic-id row instead of orphaning one per boot. MUST match the
    // name the supervised computer enrolls under — both derive the SHARED
    // DEFAULT_LOCAL_COMPUTER_NAME const (the supervised computer defaults to it when
    // SLAYZONE_SUPERVISED=1), so they can't silently diverge. Remote computers (any
    // other name) keep the fresh-uuid path.
    const localComputerName = DEFAULT_LOCAL_COMPUTER_NAME
    // On the hub's own disk, only the co-spawned local computer's folders are the hub's
    // (the desktop app's). A standalone hub has none: what any computer reports
    // describes that computer's disk, never the hub's (api access.ts, Q1).
    const hubDiskComputer = supervised ? deterministicLocalComputerId(localComputerName) : null
    setHubDiskComputer(hubDiskComputer)
    // Its tasks' folders on that disk come from it, never from a hub copy (§9 Phase 7c).
    setHubDiskTaskRoots(
      hubDiskComputer
        ? () =>
            readComputerTaskRoots(
              {
                db,
                request: (computerId, request) =>
                  computerChat.lifecycle.request(computerId, request),
                usable: (computerId) => execGateway?.isComputerUsable(computerId) ?? false
              },
              hubDiskComputer
            )
        : null
    )
    // Assigned further down, once the workspace-fs adapters exist. The
    // `computer-connected` listener below only calls it on a later event, so the
    // forward reference is never read before it is set.
    let syncComputerProjects: (computerId: string) => Promise<void> = async () => undefined
    const chatCommandBarrier = createComputerChatCommandBarrier({
      lifecycle: computerChat.lifecycle.syncNative
    })
    const newWorkGuard = createNewWorkGuard(db)
    // A task-scoped request (spawn, exec, file/git read) waits for the task's staged
    // paths to reach that computer: the computer judges it against them (S3).
    const taskPathGate = createTaskPathRequestGate({
      flushTaskPaths: (taskId, computerId) =>
        computerDataHandoff.flushTask(taskId, computerId, [TASK_PATH_KIND])
    })
    const computerGateway = createHubComputerGateway({
      // THE owner check (G2): every hub→computer request, whatever routed it, is
      // refused on a computer its caller does not own. The hub's own work passes.
      authorizeRequest: createComputerRequestAuthorizer(placement.gate),
      beforeRequest: async (computerId, method, params) => {
        if (!resettingForTest) await chatCommandBarrier(computerId, method)
        // A disabled computer takes no new work (`computers.setDisabled`).
        await newWorkGuard(computerId, method, params)
        if (!resettingForTest) await taskPathGate(computerId, method, params)
      },
      verifyGeneration: (id, generation) => acceptComputerGeneration(db, id, generation),
      // The dedup is the DESKTOP hub's alone: only there is a computer of that name its
      // own co-spawned child. A standalone hub is shared by many machines, so a
      // computer enrolling under the name there is just a computer — giving every one
      // the same deterministic id would collapse different machines onto one row.
      ...createComputerAuthAdapters({
        db,
        auth: hubAuth,
        ...(supervised ? { localComputerName } : {})
      }),
      // Off: no caps on unauthenticated sockets (a hub nobody else can reach).
      ...(opts.floodLimits ? {} : { floodLimits: false as const })
    })
    computerGatewayRef = computerGateway
    directLinkIssuer = createDirectLinkIssuer({
      gateway: computerGateway,
      resolvePty: async (sessionId) => getPtyDirectTarget(sessionId),
      // An ACTIVE owner only: a tab mid-migration, deleted, or whose computer lost
      // its history is the relay's to explain.
      resolveChat: async (tabId) => {
        const owner = await computerChat.ownership.forTab(tabId)
        if (!owner || owner.state !== 'active' || !owner.computerId) return null
        if (await computerChat.ownership.unavailable(owner.id)) return null
        // A restored chat never starts before its saved settings (and the task's
        // paths and session ledger) reached its computer (S4). Offline: the direct
        // link cannot reach it either; the relay explains.
        if (!computerGateway.isComputerUsable(owner.computerId)) return null
        await computerDataHandoff.flushTask(owner.taskId, owner.computerId, DECISIVE_HANDOFF_KINDS)
        return { computerId: owner.computerId, epoch: owner.epoch, taskId: owner.taskId }
      },
      // A task's computer-only data: on the computer holding it, with whatever the hub
      // still held of it delivered first (so a direct read never misses it).
      resolveTask: async (taskId) => {
        const computerId = await computerDataHandoff.target(taskId)
        if (computerId === null || !computerGateway.isComputerUsable(computerId)) return null
        await computerDataHandoff.flushTask(taskId, computerId)
        return { computerId }
      },
      ...(placement.gate ? { gate: placement.gate } : {}),
      onChatOwnershipChange: (listener) => computerChat.ownership.onChange(listener),
      // IdP-role mode: grants never outlive the caller's role evidence.
      accessDeadlineMs: (userId) => idpRolesOf(hubAuth)?.deadlineMs(userId) ?? null,
      // Validated at boot (rule B19), so this is the parsed value.
      stunAddresses: () => {
        const stun = readHubStunAddresses()
        return stun.ok ? stun.addresses : []
      }
    })
    // Every (re)connect: the computer keeps exactly the grants this hub still holds
    // (none after a hub restart), so nothing it granted outlives what the hub knows.
    computerGateway.events.on('computer-connected', ({ computer }) => {
      void directLinkIssuer?.computerConnected(computer.computerId).catch((err: unknown) =>
        console.warn('[direct-link] reset on connect failed', {
          computerId: computer.computerId,
          error: String(err)
        })
      )
      void chatRelayWatch.computerConnected(computer.computerId)
    })

    // Agent-hook relay consumer (hub/computer split): a computer-routed pty posts its
    // lifecycle hook to the computer's OWN loopback relay, which forwards the raw
    // envelope here over the authed ws channel as a generic `event`
    // (name: 'agent-hook'). Feed it through the SAME `processAgentHook` authority
    // the local loopback HTTP route uses. Extracted + unit-tested in
    // agent-hook-relay-consumer.ts.
    attachAgentHookRelayConsumer(computerGateway, restDeps, terminalStateBridge)

    // Route ALL OS-level exec (pty / chat agents / processes) to a computer. There
    // is no in-process fallback: an unresolved computer raises
    // NoComputerAvailableError so "which machine ran this?" is never an invisible
    // property of DB state.
    //
    // Bind the gateway into the shared `resolveExecComputer` declared above, so the
    // spawn-time lookups and these exec backends resolve IDENTICALLY. Any spec
    // arriving with a null computerId still gets the connected default here.
    execGateway = computerGateway
    setPtyBackend(
      createRoutingPtyBackend({
        gateway: computerGateway,
        resolveComputerId: (spec) => resolveExecComputer(spec.computerId),
        gate: placement.gate
      })
    )
    // Warm agents are the COMPUTER's processes, so they outlive a hub or sidecar
    // restart — unlike the old hub-local pool, whose children died with it. An
    // unclaimed pre-booted agent is a billable LLM process with no owner, so
    // reconcile against the computer's own list on every (re)connect and reap
    // whatever this hub is no longer tracking.
    const asComputerOwner = async (computerId: string, work: () => Promise<void>) => {
      if (!opts.requireLogin) return work()
      const actor = await computerOwnerOf(db, computerId)
      return runWithSecurityContext({ actor, ip: null, route: 'computer chat maintenance' }, work)
    }
    const chatMaintenance = createComputerChatMaintenance({
      asOwner: asComputerOwner,
      faults: async (id) => {
        await itemFaults.refreshComputer(id)
      },
      projects: (id) => syncComputerProjects(id),
      recover: (id, force) => computerChat.recoverComputer(id, force),
      lifecycle: computerChat.lifecycle.sync,
      handoff: async (id) => {
        await computerDataHandoff.deliverTo(id)
        // The session ledger lives there (robustness plan §9): the hub's session
        // intents it missed, then one task per provider session there.
        await computerSessionLedger.onComputerConnected(id)
        await repairSharedSessionClaims({
          db,
          record: recordDiagnosticEvent,
          ledger: computerSessionLedger,
          computerId: id
        })
      },
      sessions: computerChat.relay.refreshSessions,
      migrate: async (id) => {
        await computerChat.migrateIdleComputer(id)
        await chatCompaction.run()
        await legacyChatDiagnostics?.compact()
      }
    })
    maintainComputerChat = (id, runOpts) => chatMaintenance.run(id, runOpts)
    syncComputerChatLifecycle = (id) => asComputerOwner(id, () => computerChat.lifecycle.sync(id))
    drainComputerChatMaintenance = () => chatMaintenance.drain()
    computerGateway.events.on('computer-connected', ({ computer }) => {
      computerChat.invalidateRecovery(computer.computerId)
      if (!resettingForTest)
        void maintainComputerChat(computer.computerId, { reconnect: true }).catch(() =>
          console.error('[chat] computer reconciliation pending')
        )
      void reapOrphanWarms(computer.computerId)
    })
    // Bring back the chat agents that ran at shutdown on this computer — once per
    // computer per hub run, whatever any client is doing (agent-restore.ts).
    const restoredComputers = new Set<string>()
    computerGateway.events.on('computer-connected', ({ computer }) => {
      const id = computer.computerId
      if (resettingForTest || restoredComputers.has(id)) return
      restoredComputers.add(id)
      void restoreRunningChatAgents(db, {
        getTask: (taskId) => getTaskOp(db, taskId),
        belongsHere: async (taskId) => {
          try {
            return (await resolveComputerForTask(taskId)) === id
          } catch {
            return false
          }
        }
      }).finally(releaseWarmPool)
    })
    // Background processes run on the computer that owns their task / project, like
    // every other workspace exec (docs/exec-boundary.md). The manager resolves the
    // computer before EVERY spawn (initial, start, restart, auto-restart) — async —
    // and the backend routes by that id; with none, the process shows "connect a
    // computer" instead of starting on the hub.
    setProcessBackend(
      createRoutingProcessBackend({
        gateway: computerGateway,
        resolveComputerId: (spec) => spec.computerId,
        // Runs adopted after a hub restart are the manager's: a reconnect keeps them.
        keepUntracked: isAdoptedOnComputer
      })
    )
    setProcessComputerResolver(async ({ taskId, projectId }) => {
      if (taskId) return resolveComputerForTask(taskId)
      if (projectId) return resolveComputerForProject(projectId)
      return resolveExecComputer(null)
    })
    // Every spawn names its task (with the project THIS hub records for it) or its
    // project: the computer confines its cwd to that scope's folders and no longer
    // knows task → project for a task with no worktree (a task process stored with
    // no project id). A global process names neither and is sent unscoped.
    setProcessPathScopeResolver((target) => pathScopeFor(db, target))
    // A kept run whose computer is offline is not a survivor (G3): it is ended, and a
    // Start or Stop asked meanwhile done, when that computer reconnects.
    setProcessComputerReachability((computerId) => computerGateway.isComputerUsable(computerId))
    // A deleted or revoked computer never returns — whoever removed it (Settings,
    // REST, a departing user's cleanup): the runs it kept are forgotten.
    setComputerRemovedListener((computerId) => {
      processesComputerRemoved(computerId)
      // Chat work addressed to a deleted or replaced computer moves or is retired now
      // (a revoked one waits), and the computers holding its chats adopt them now.
      void computerChat
        .computerRemoved(computerId)
        .catch((error: unknown) => console.error('[chat] computer retirement failed:', error))
      // Its direct-link grants go with it, whoever removed it (docs/direct-link.md).
      void directLinkIssuer
        ?.revoke({ by: 'computer', computerId }, 'computer_removed')
        .then(reportDirectRevokeFailures)
    })
    // Auto-restart processes that found no computer start now; runs a previous hub
    // left on this computer show as orphaned (Stop/Start reach them there).
    computerGateway.events.on('computer-connected', ({ computer }) => {
      if (resettingForTest) return
      void processesComputerConnected(computer.computerId).catch(() =>
        console.error('[processes] computer reconciliation failed')
      )
    })
    // Only normalized, computer-persisted chat events cross this channel.
    // A chat command a client sent straight to the computer (docs/direct-link.md):
    // drain metadata as after a relayed command — in the same per-computer order.
    const chatDirectWrite = createChatDirectWriteHandler({
      forTab: (tabId) => computerChat.ownership.forTab(tabId),
      drainMetadata: (computerId, conversationId) =>
        computerChat.relay.drainMetadata(computerId, false, undefined, undefined, conversationId)
    })
    computerGateway.events.on('event', ({ computerId, name, payload }) => {
      if ((name !== 'chat-runtime' && name !== CHAT_DIRECT_WRITE_EVENT_NAME) || resettingForTest)
        return
      const previous = chatNotificationChains.get(computerId) ?? Promise.resolve()
      const next = previous
        .then(() =>
          asComputerOwner(computerId, () =>
            name === CHAT_DIRECT_WRITE_EVENT_NAME
              ? chatDirectWrite(computerId, payload)
              : computerChat.relay.receive(computerId, payload)
          )
        )
        .catch(() => {
          console.error('[chat] rejected computer notification')
        })
      chatNotificationChains.set(computerId, next)
      void next.finally(() => {
        if (chatNotificationChains.get(computerId) === next)
          chatNotificationChains.delete(computerId)
      })
    })
    // Re-configure with a COMPLETE object (shallow-merge over defaults): re-supply
    // every base field so nothing is dropped, plus the routing worktree adapter.
    configureTaskRuntimeAdapters({
      ...baseTaskAdapters,
      worktrees: taskWorktreeRouting.remoteWorktrees({
        gateway: computerGateway,
        gate: placement.gate,
        local: hubWorktreeExecAdapters
      })
    })
    // `gh` authenticates as whoever owns the machine it runs on. Run on the hub,
    // the PR panel spoke as the HUB while the agent pushed as the COMPUTER — two
    // identities for one repository, and only one of them held credentials for it.
    // Route the single `spawnGh` chokepoint; the eleven typed gh functions and
    // their parsing stay here untouched.
    // The git panel: each op runs on the computer that holds the checkout (the
    // router resolves it like the workspace fs, owner-gated with login).
    const gateGitOp = createGitOpGate(placement.gate, () => currentSecurityContext()?.actor ?? null)
    setGitOpTransport({
      request: async (computerId, params, timeoutMs, target) => {
        // A caller's op is gated as what it works on; the hub's own reads pass.
        await gateGitOp(computerId, target)
        return gitOpResultSchema.parse(
          await computerGateway.request(computerId, HubToComputerMethods.gitOp, params, timeoutMs)
        ).result
      },
      watchStart: async (computerId, params) => {
        await computerGateway.request(computerId, HubToComputerMethods.gitWatchStart, params)
      },
      watchStop: async (computerId, params) => {
        await computerGateway.request(computerId, HubToComputerMethods.gitWatchStop, params)
      }
    })
    computerGateway.events.on('event', ({ computerId, name, payload }) => {
      if (name !== GIT_WATCH_EVENT) return
      const parsed = gitWatchEventSchema.safeParse(payload)
      if (parsed.success) deliverGitWatchEvent(computerId, parsed.data)
    })
    computerGateway.events.on('computer-disconnected', ({ computerId }) =>
      gitWatchComputerGone(computerId)
    )
    computerGateway.events.on('computer-lost', ({ computerId }) => gitWatchComputerGone(computerId))
    // The test panel's scan reads the project's files: on the project's computer,
    // under the project's path scope (§9 Phase 7b).
    setTestScanRouting({
      computerFor: ({ projectId }) => placement.forTarget({ projectId }),
      scan: async (computerId, input) =>
        testPanelScanResultSchema.parse(
          await computerGateway.request(
            computerId,
            HubToComputerMethods.testPanelScan,
            input,
            COMPUTER_SCAN_TIMEOUT_MS
          )
        )
    })
    // Agent usage logs are on the computers: each refresh asks every usable one for
    // what is new since the read offsets it keeps (robustness plan §9, v209).
    setUsageCollectRouting({
      computers: () => computerGateway.listUsableComputers().map((c) => c.computerId),
      // The hub's machine's own computer reads the logs the old hub-disk cursors index.
      localComputerId: () => deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME),
      // The hub's own cache of every computer's usage logs, refreshed for whoever
      // asked: run as the hub, not as that caller.
      collect: async (computerId, request) => {
        const reply = usageCollectResultSchema.parse(
          await runAsSecurityActor(null, () =>
            computerGateway.request(
              computerId,
              HubToComputerMethods.usageCollect,
              request,
              USAGE_COLLECT_TIMEOUT_MS
            )
          )
        )
        return {
          results: reply.results as unknown as UsageCollectReply['results'],
          ...(reply.next ? { next: reply.next } : {}),
          ...(reply.receipt ? { receipt: reply.receipt } : {})
        }
      }
    })
    // AI-config files (instructions, skills, MCP): a project's on the computer of the
    // scope the call names (§9 Phase 7c — never routed by a path), the computer-level
    // ones on an explicit computer or the caller's own — each fs call one
    // agentConfig.fs.
    setAiConfigFsRouting({
      computerForProject: ({ taskId, projectId }) =>
        placement.forTarget(taskId ? { taskId } : projectId ? { projectId } : {}),
      computerForCaller: (computerId) => placement.forTarget(computerId ? { computerId } : {}),
      request: async (computerId, call) =>
        agentConfigFsResultSchema.parse(
          await computerGateway.request(
            computerId,
            HubToComputerMethods.agentConfigFs,
            call,
            COMPUTER_FS_CALL_TIMEOUT_MS
          )
        ).result
    })
    computerGateway.events.on('computer-disconnected', ({ computerId }) =>
      aiConfigComputerGone(computerId)
    )
    // The conflict analysis's agent CLI runs on the caller's own computer (agents run
    // on computers); with none (null) it runs here, refused where processes are off.
    setAiCommandRunner(async (argv, timeoutMs) => {
      const computerId = await placement.forCaller()
      if (computerId == null) return null
      return execRunOnComputer(computerGateway, computerId, { argv, timeoutMs })
    })
    // Terminal settings probes (a mode's binary, a docker / ssh context) run on the
    // caller's computer as one exec.run; with none, "connect a computer".
    const computerProbes = createComputerProbes({
      computerFor: () => placement.forCaller(),
      run: (computerId, params) => execRunOnComputer(computerGateway, computerId, params)
    })
    setTerminalCommandProbe(computerProbes.command)
    setExecutionContextProbe(computerProbes.executionContext)
    // Automation shell actions (run_command, ai) run on the task's, else the project's,
    // computer as one exec.run; with none, the engine refuses ("connect a computer").
    setAutomationCommandRouting({
      computerFor: async ({ taskId, projectId }) => {
        if (taskId) return resolveComputerForTask(taskId)
        if (projectId) return resolveComputerForProject(projectId)
        return null
      },
      isReachable: (computerId) => computerGateway.isComputerUsable(computerId),
      run: (computerId, command) => execRunOnComputer(computerGateway, computerId, command),
      // `{{task.worktree_path}}` / path conditions: as the computer the actions run on
      // holds them (§9 7c/7d).
      taskPaths: (computerId, taskId) =>
        readComputerTaskPath(
          {
            request: (id, request) => computerChat.lifecycle.request(id, request),
            usable: (id) => computerGateway.isComputerUsable(id),
            flushTask: (id, target, kinds) => computerDataHandoff.flushTask(id, target, kinds)
          },
          computerId,
          taskId
        )
    })
    // Cron catch-ups that waited for a computer (launch, wake) run now (H1).
    computerGateway.events.on('computer-connected', () => {
      if (!resettingForTest) void automationEngine.computerConnected()
    })
    // Resume durable cleanup when a recorded computer reconnects.
    computerGateway.events.on('computer-connected', () => {
      if (!resettingForTest)
        bootBestEffort('erasure-retry-on-connect', () => erasureRetries.retry())
    })
    // A deleted tab's terminal output, saved on its computer to outlive restarts,
    // goes with it — also when nothing runs in the tab (deleted after a restart).
    // Best-effort: a computer offline now sweeps it by age.
    tabsEvents.on('tab:deleted', ({ taskId, tabId }) => {
      void (async () => {
        const computerId = await placement.forTarget({ taskId })
        if (!computerId) return
        await computerGateway.request(
          computerId,
          HubToComputerMethods.ptyForget,
          { sessionId: `${taskId}:${tabId}`, taskId },
          PTY_FORGET_TIMEOUT_MS
        )
      })().catch(() => {
        /* best-effort, see above */
      })
    })
    // Agent-turn snapshots live on the checkout's computer (robustness plan §9, P0;
    // v207): its git and its rows. Resolved like the git panel (by path, or by the
    // task for a boundary). A computer that is not connected: the history is offline
    // (the hub keeps no copy).
    const turnsRequest = async (computerId: string, value: TurnsRequest) => {
      try {
        return await computerGateway.request(
          computerId,
          HubToComputerMethods.chatRequest,
          { kind: 'turns', value },
          TURN_GIT_OP_TIMEOUT_MS
        )
      } catch (error) {
        if (isComputerUnreachable(error)) throw new AgentHistoryOfflineError()
        throw error
      }
    }
    setTurnGitRouting({
      computerForTask: (taskId) => placement.forTarget({ taskId }),
      request: async (computerId, op, input) =>
        gitOpResultSchema.parse(
          await computerGateway.request(
            computerId,
            HubToComputerMethods.gitTurnOp,
            { op, input },
            TURN_GIT_OP_TIMEOUT_MS
          )
        ).result,
      record: async (computerId, input) =>
        (await turnsRequest(computerId, { op: 'record', ...input })) as TurnRecordOutcome,
      list: async (computerId, input) =>
        (await turnsRequest(computerId, { op: 'list', ...input })) as TurnListOutcome
    })
    setGhExecutor(async (args, opts) => {
      // `gh` runs where the checkout is: on the computer of the path scope the
      // procedure opened (§9 Phase 7b: the task or project it names, never a bare
      // path), resolved — and, with login, admitted (T-19: `gh` speaks as the
      // machine's account, never someone else's) — like any workspace target. The
      // computer confines its cwd to that scope's folders.
      const scope = currentPathScope()
      if (!scope) throw new PathScopeRequiredError('gh')
      const computerId = await placement.forTarget(
        scope.kind === 'task' ? { taskId: scope.taskId } : { projectId: scope.projectId }
      )
      // No computer: `gh` has nowhere to run ("connect a computer") — the hub never
      // runs it itself.
      if (computerId == null || !opts.cwd) refuseNoComputer({ op: 'gh' })
      const res = await computerGateway.request(
        computerId,
        HubToComputerMethods.ghExec,
        {
          args,
          cwd: opts.cwd,
          ...(opts.timeout ? { timeoutMs: opts.timeout } : {}),
          ...(opts.stdin === undefined ? {} : { stdin: opts.stdin })
        },
        // `gh` ends itself at its own limit; the reply gets room after it.
        (opts.timeout ?? GH_DEFAULT_TIMEOUT_MS) + EXEC_RUN_REPLY_GRACE_MS
      )
      return ghExecResultSchema.parse(res)
    })

    // Where a Claude conversation's transcript is, and which folder to resume it
    // from (a session that used EnterWorktree keeps it under the worktree's
    // project dir). Asked of the computer the session runs on — its disk, not the
    // hub's. A failure is "unknown" upstream, never "missing".
    setClaudeTranscriptLocator(async (req) => {
      const computerId = resolveExecComputer(req.computerId)
      if (computerId == null) throw new Error('no computer for this session')
      if (placement.gate) await placement.gate(computerId, { kind: 'task', id: req.taskId })
      const res = await computerGateway.request(
        computerId,
        HubToComputerMethods.claudeSessionLocate,
        {
          ...(req.cwd ? { cwd: req.cwd } : {}),
          ...(req.projectId ? { projectId: req.projectId } : {}),
          sessionIds: req.sessionIds
        }
      )
      return claudeSessionLocateResultSchema.parse(res).sessions
    })

    setSlayExecutor(
      createRoutingSlayExecutor({
        resolveComputer: (target) => placement.forTarget(target),
        gateway: computerGateway
      })
    )

    // Workspace filesystem — the directory picker, the project-path probe, and
    // (later) the editor panel. Same resolution as the exec backends above, which
    // is the entire point: the picker must browse the filesystem the agent will
    // actually get. Serving these from the hub is what made a task on a remote
    // computer report "No repository path configured" for a path that existed.
    // No computer: "connect a computer" — the hub never reads a project folder itself.
    const localWorkspaceFs = noComputerWorkspaceFs
    // The hub's own maintenance on connect (below): the computer is named by the
    // gateway event, not by a caller, and what it is handed is cut to its owner's
    // projects (T-19).
    const workspaceFs = createRemoteFsAdapters({
      gateway: computerGateway,
      local: localWorkspaceFs
    })
    // What users reach (`workspace.*`, `fileEditor.*`, repo discovery): the same
    // adapters — the caller's owner check is the gateway's, for every request (G2).
    const userWorkspaceFs = workspaceFs
    // Project folders: where each computer keeps each project, kept in step between
    // the computer's own record and the hub's copy. The local computer is matched by
    // its deterministic id (re-enrollment keeps it), never by name.
    const projectSync = createComputerProjectSync({
      db,
      localComputerId: deterministicLocalComputerId(localComputerName),
      ops: {
        listRoots: (computerId) => workspaceFs.listRoots(computerId),
        setAllowedRoots: (computerId, roots) => workspaceFs.setAllowedRoots(computerId, roots),
        pathExists: (computerId, path) => workspaceFs.pathExists(computerId, path),
        setProjectPath: (computerId, projectId, path) =>
          workspaceFs.setProjectPath(computerId, projectId, path),
        forgetProjectPath: (computerId, projectId) =>
          workspaceFs.forgetProjectPath(computerId, projectId),
        listProjectPaths: async (computerId) => {
          const listed = projectListResultSchema.parse(
            await computerGateway.request(computerId, HubToComputerMethods.projectList, {})
          )
          return listed.projects.map((p) => ({ projectId: p.projectId, path: p.path }))
        },
        // The tasks' folders as that computer holds them (the hub keeps no path, §9 7e).
        listTaskFolders: async (computerId, taskIds) =>
          (
            await readComputerTaskRoots(
              {
                db,
                usable: (id) => execGateway?.isComputerUsable(id) ?? false,
                request: (id, request) => computerChat.lifecycle.request(id, request)
              },
              computerId,
              taskIds
            )
          ).map((r) => r.root)
      },
      // A computer places only its owner's projects (T-19): a report naming anyone
      // else's would make paths on it resolve to their project (access.ts `path`).
      servedProjects: async (computerId, projectIds) =>
        (
          await ownProjects(
            computerId,
            projectIds.map((id) => ({ id }))
          )
        ).map((r) => r.id),
      onChanged: () => notifyTasksChanged(),
      record: ({ level, event, message, payload }) =>
        recordDiagnosticEvent({ level, source: 'server', event, message, payload })
    })
    syncComputerProjects = (computerId) => projectSync.onConnect(computerId)
    // The local computer's other work folders — the worktree base setting, an
    // automation's own folder and a background process's — are registered again when
    // they change (M6).
    if (supervised) {
      setAutomationWrittenListener(() => void projectSync.localWorkFoldersChanged())
      setProcessWrittenListener(() => void projectSync.localWorkFoldersChanged())
      // And before every process start on the local computer, awaited: a start on its
      // (re)connect — an auto-restart process that waited for it — must not reach it
      // before its roots cover the process's folder (it would be refused).
      const localComputerId = deterministicLocalComputerId(localComputerName)
      setProcessSpawnPreparer(({ computerId }) =>
        computerId === localComputerId ? projectSync.localWorkFoldersChanged() : Promise.resolve()
      )
      notifyEvents.on('settings-changed', (change) => {
        if (!change || change.keys.includes('worktree_base_path'))
          void projectSync.localWorkFoldersChanged()
      })
    }
    // Every Project the hub returns names the computer its work really runs on.
    // Without login a stored default IS the answer (forProject would re-read it);
    // with login it must still pass the owner check.
    setProjectComputerResolver((project) =>
      !opts.requireLogin && project.default_computer_id
        ? Promise.resolve(project.default_computer_id)
        : placement.forProject(project.id)
    )
    // A changed computer choice changes which folder clients show.
    setComputerBindingChangedListener(() => notifyTasksChanged())
    // Every write of a project's folder (create, update, REST, CLI) lands on a
    // computer through the same per-computer sequence as connect.
    // Right after the app starts, the local computer is registered but not yet
    // connected: a folder chosen then is recorded for it as pending and delivered when
    // it connects, instead of being refused. Only for a caller who may use it.
    const localComputerId = deterministicLocalComputerId(localComputerName)
    const registeredLocalComputer = async (): Promise<string | null> => {
      const local = await getComputer(db, localComputerId)
      if (!local || local.revoked_at != null) return null
      return placement.forTarget({ computerId: localComputerId }).catch(() => null)
    }
    setProjectFolderHost({
      computerForNewProject: async () =>
        (await placement.forCaller()) ?? (await registeredLocalComputer()),
      computerForProject: async (projectId) =>
        (await placement.forProject(projectId)) ?? (await registeredLocalComputer()),
      setFolder: (computerId, projectId, path) =>
        projectSync.setFolder(computerId, projectId, path),
      forgetFolder: (computerId, projectId) => projectSync.forgetFolder(computerId, projectId)
    })
    localBootGate = supervised
      ? createLocalComputerBootGate({
          events: computerGateway.events,
          localComputerId,
          usable: (computerId) => computerGateway.isComputerUsable(computerId),
          registered: async () => {
            const local = await getComputer(db, localComputerId)
            return !!local && local.revoked_at == null
          },
          timeoutMs: LOCAL_COMPUTER_BOOT_WAIT_MS
        })
      : null
    setWorkspaceDeps({
      fs: {
        ...userWorkspaceFs,
        // Choosing a folder updates the computer AND the hub's copy at once, under
        // the computer's lock. No computer = nowhere to record it: refused, rather
        // than kept in this process's memory and lost on restart.
        setProjectPath: async (computerId, projectId, path) => {
          if (computerId == null) throw new NoComputerForFolderError()
          return projectSync.setFolder(computerId, projectId, path)
        },
        forgetProjectPath: async (computerId, projectId) => {
          if (computerId == null) throw new NoComputerForFolderError()
          await projectSync.forgetFolder(computerId, projectId)
        }
      },
      // An explicit computer (the caller's own, with login), else the task's, else the
      // project's, else the caller's default — see ./computer-placement.ts. While the
      // desktop's local computer is still enrolling after boot, a call waits for it
      // (never the hub's own disk): a file restored at boot opens once it is there.
      // A task or project this hub does not have is refused (NOT_FOUND) before any
      // pick: with no row it has no binding, and fell through to the DEFAULT computer
      // — another hub's project's folder sent to this machine. An explicit computer is
      // the caller's choice (the create-project picker names one before any row).
      resolveComputer: async (target) => {
        if (target.computerId == null) await assertKnownTarget(db, target)
        const gate = localBootGate
        return gate ? gate.settle(() => placement.forTarget(target)) : placement.forTarget(target)
      },
      // No computer at all = this hub's own disk, which for a supervised hub IS the
      // desktop's. Otherwise only the co-spawned local computer shares a machine
      // with the user; every remote one is somewhere they cannot see.
      isLocalComputer: (computerId) => {
        if (computerId == null) return true
        const computer = computerGateway.listComputers().find((r) => r.computerId === computerId)
        return computer?.name === localComputerName
      }
    })
  })().catch((err) => {
    computersInitError = err instanceof Error ? err : new Error(String(err))
    recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'computer.init_failed',
      message: computersInitError.message
    })
  })

  /**
   * E2E-only full reset, in process. It replaced restarting the side-car after
   * the DB wipe (~550ms per spec, and the restart never killed agents running on
   * the computer — those leaked across specs). Order matters:
   *  1. stop every agent/process and AWAIT exits, so no exit handler writes into
   *     the wiped DB;
   *  2. drop + re-migrate (the `computers` rows survive, so the gateway and the
   *     computer's connection stay up — no re-dial);
   *  3. seed the e2e baseline + re-publish boot-time rows the wipe erased
   *     (`server_port`), then re-read every cache that holds DB rows or
   *     test seams — the seed is raw SQL, so no settings-changed event fires.
   * Deliberately NOT here: the automation engine (reads the DB per event, and
   * stop/start would double its listeners) and the gateway.
   */
  const resetForTest = async (): Promise<void> => {
    resettingForTest = true
    try {
      await drainComputerChatMaintenance()
      await Promise.all(
        (execGateway?.listUsableComputers() ?? []).map((pc) =>
          computerChat.lifecycle.sync(pc.computerId)
        )
      )
      await Promise.allSettled([...chatNotificationChains.values()])
      await computerChat.resetForTest()
      for (const pc of execGateway?.listUsableComputers() ?? [])
        await execGateway!.request(pc.computerId, HubToComputerMethods.chatRequest, {
          kind: 'test.reset'
        })
      await resetTerminalRuntimeForTest()
      killAllProcesses()
      await db.namedTxn('db:reset-for-test', {})
      // Post-onboarding baseline every spec was written against. `manual` startup =
      // the Start gate + no warm pool (a fresh DB defaults to `auto`); specs that
      // exercise another mode set it themselves.
      const baseline: Array<[string, string]> = [
        ['onboarding_completed', 'true'],
        // CLI install/update prompt off: it depends on the host's `slay`, so specs
        // that test it opt in by clearing this.
        ['cli_install_dismissed', 'true'],
        // "Want a quick tour?" toast off: it would land in every spec's first
        // seconds and shift any toast a spec is driving.
        ['tutorial_prompted', 'true'],
        [AGENT_STARTUP_SETTING, 'manual']
      ]
      // Boot-time write the wipe erased: the CLI/agents discover this process via
      // `settings.server_port` (port-claim.ts). A restart re-claimed it at listen.
      if (boundPort) baseline.push(['server_port', String(boundPort)])
      for (const [key, value] of baseline) {
        await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
      }
      await idleClose.rewarm()
      await refreshPrewarm()
      await initProcessManager(db)
      await backupOps.startAuto()
      integrationHandles.testClearGithubMocks()
      resetSyncFlags()
      clearDiagnosticsConfigCache()
      resetWorktreeColorsForTest()
      invalidateProjectReposCache()
      resetAgentHookStateForTest()
    } finally {
      resettingForTest = false
    }
  }

  return {
    closeErasures: () => erasureRetries.close(),
    resetForTest,
    notifyRenderer,
    automationEngine,
    restDeps,
    setBoundPort: (port: number) => {
      boundPort = port
    },
    get computerGateway(): HubComputerGateway | null {
      return computerGatewayRef
    },
    get hubAuth(): HubAuth | null {
      return hubAuthRef
    },
    computersReady,
    get computersInitError(): Error | null {
      return computersInitError
    },
    setComputerListenerInfo: (info) => {
      computerHubUrl = info.hubUrl
    },
    trpcConnections,
    userAccess,
    breakGlass,
    /** Reads of a task's computer-only data through the hub relay (robustness plan §9). */
    computerTaskData
  }
}
