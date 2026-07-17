import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  openPath as nativeOpenPath,
  openExternal as nativeOpenExternal,
  pathExists as nativePathExists,
  showItemInFolder as nativeShowItemInFolder
} from './shell-native'
import type { SlayzoneDb } from '@slayzone/platform'
import { checkCliInstalled } from '@slayzone/platform'
import { TypedEmitter } from '@slayzone/platform/events'
import {
  setTaskDeps,
  setIntegrationOps,
  setProcessesDeps,
  setNotifyEvents,
  setAutomationsEvents,
  setTelemetryEvents,
  setMenuEvents,
  setAgentLifecycleEvents,
  setTaskTriggerBus,
  setAppDeps,
  setPtyDeps,
  setChatDeps,
  setAuthEvents,
  setRunnersDeps,
  requestGithubSignInStart,
  type AppDeps,
  type NotifyEventMap,
  type AutomationsEventMap,
  type TelemetryEventMap,
  type MenuEventMap,
  type AgentLifecycleEventMap,
  type AuthEventMap,
  type RestApiDeps,
  type FloatingAgentState
} from '@slayzone/transport/server'
import { createHostBridge, type HostBridge } from './host-bridge.js'
import { getServerBuildInfo } from './build-info.js'
import {
  taskOps,
  configureTaskRuntimeAdapters,
  defaultWorktreeExecAdapters,
  startArtifactWatcher,
  purgeStaleAndOrphanedTasks,
  handleAttentionTransition,
  registerConversationHealer,
  registerConversationResolver
} from '@slayzone/task/server'
import { handleTerminalStateChange } from '@slayzone/projects/server'
import {
  createPtyOps,
  createDbPtySpawnLookups,
  setPtyBackend,
  setPtySpawnLookups,
  setRemoteMcpEnvProvider,
  localPtyBackend,
  ptyEvents,
  createChatOps,
  createChatQueueOps,
  chatEvents,
  chatQueueEvents,
  listPtys,
  hasPty,
  getBuffer,
  writePty,
  submitPty,
  killPty,
  killPtysByTaskId,
  requestEnsureAlive,
  subscribeToPtyData,
  subscribeToStateChange,
  onSessionChange,
  getState,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput,
  configurePtyHost,
  onTaskReachedTerminal,
  runtimeOnTaskReachedTerminal,
  setOnTaskReachedTerminalHandler,
  broadcastRespawnRequest,
  initWarmProcessManager,
  onGlobalStateChange,
  hasSessionUserInput,
  type PtySessionWindow
} from '@slayzone/terminal/server'
import {
  createIntegrationOps,
  ensureIntegrationSchema,
  setCredentialCipher
} from '@slayzone/integrations/server'
import { buildFeedbackOps } from '@slayzone/feedback/server'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { AutomationEngine } from '@slayzone/automations/server'
import { recordDiagnosticEvent, bindDiagnosticsDbs } from '@slayzone/diagnostics/server'
import {
  processEvents,
  initProcessManager,
  createProcess,
  spawnProcess,
  updateProcess,
  stopProcess,
  killProcess,
  restartProcess,
  killTaskProcesses,
  listForTask,
  listAllProcesses,
  subscribeToProcessLogs,
  setProcessBackend,
  localProcessBackend
} from '@slayzone/processes/server'
// Runner transport: runner gateway + hub-auth + runner resolution, wired
// unconditionally at boot (a hub always accepts runners).
import {
  createHubRunnerGateway,
  createRoutingPtyBackend,
  createRoutingProcessBackend,
  createRemoteWorktreeAdapters,
  type HubRunnerGateway
} from '@slayzone/runner-transport/server'
import { createHubAuth, verifyTaskToken, type HubAuth } from '@slayzone/hub-auth/server'
import { DEFAULT_LOCAL_RUNNER_NAME, resolveTaskRunnerId } from '@slayzone/runners/server'
import { createRunnerAuthAdapters } from './runner-auth.js'
import { createRemoteMcpEnvProvider } from './remote-mcp-env-provider.js'

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

/** A throwing stand-in for an electron-only function dep. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- single chokepoint for typed stubs
function stub<T extends (...args: any[]) => any>(name: string): T {
  return ((..._args: unknown[]) => unavailable(name)) as unknown as T
}

export type ServerComposition = {
  notifyRenderer: () => void
  automationEngine: AutomationEngine
  restDeps: RestApiDeps
  /** Late-bound by the server once listen() resolves the actual port. */
  setBoundPort: (port: number) => void
  /** Hub runner gateway (runner-WS multiplexer), or `null` until its async init
   *  resolves (see `runnersReady`). A later unit mounts it onto the server's WS
   *  upgrade path. */
  readonly runnerGateway: HubRunnerGateway | null
  /** Hub-auth (better-auth) instance backing runner enroll/verify, or `null`
   *  until the async init resolves (same as `runnerGateway`). */
  readonly hubAuth: HubAuth | null
  /** Resolves once the async runner init (createHubAuth + gateway) has finished.
   *  A later unit awaits this before reading the two fields above / mounting the
   *  gateway. */
  runnersReady: Promise<void>
  /** Feed the runner listener's bound WS URL + the hub identity's TLS cert
   *  fingerprint back into the runners registry (`mintJoinToken` embeds both in
   *  a join token). The server host resolves these only after it binds the runner
   *  port + loads `loadOrCreateHubIdentity`, which happens AFTER composeServer
   *  returns — so it's a late-bound setter, not a constructor arg. */
  setRunnerListenerInfo: (info: { hubUrl: string; certFingerprint: string }) => void
}

export function composeServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  /** Standalone (non-supervised) boot: hydrate the process registry and ensure
   *  aux schemas. Supervised (dark, Electron-owned DB): skip — the host did. */
  standalone: boolean
  /** Separate diagnostics events DB. When present, `recordDiagnosticEvent` in
   *  THIS process persists (and pre-bind buffered events flush) — without it the
   *  sidecar's diagnostics silently buffer + drop. */
  diagnosticsDb?: SlayzoneDb
}): ServerComposition {
  const { db, dataRoot } = opts
  const supervised = !opts.standalone

  // --- Runner transport (always on) -------------------------------------------
  // A hub always accepts runners: the gateway + hub-auth are built and the runner
  // listener binds at startup unconditionally, so a runner can connect (and join
  // tokens can mint) with no mode to flip. Co-located exec still runs IN-PROCESS —
  // a task only routes over the transport when it is explicitly bound to a runner
  // (`resolveTaskRunnerId` → null ⇒ local.spawn), so always-on costs the common
  // laptop case nothing at runtime.
  //
  // Single HMAC secret backing ALL hub-auth signing: better-auth's session/cookie
  // signer (createHubAuth) AND the per-task bearer tokens the remote-MCP-env
  // provider mints (mintTaskToken) / the agent-hook route verifies
  // (verifyTaskToken). Hoisted so all three use ONE secret — a mismatch would make
  // every minted token unverifiable.
  //
  // SECURITY SEAM (runner-secret hardening): a STANDALONE boot resolves this in
  // bin.ts (applyStandaloneHubConfig → env SLAYZONE_RUNNER_TRANSPORT_SECRET > config.json
  // runnerTransportSecret > generated+persisted 256-bit secret) and sets the env BEFORE
  // composeServer runs. So in standalone the env is ALWAYS present and NEVER the
  // shared dev constant — a per-install unique secret means minted per-task
  // tokens can't be forged across installs (the npm-published bug). We assert
  // that invariant here rather than silently applying the constant. SUPERVISED
  // (Electron host) keeps the historical env-or-dev-constant default untouched:
  // the host controls the env, config.json is never consulted, and a dev/test
  // boot without the env still works exactly as before.
  const DEV_RUNNER_TRANSPORT_SECRET = 'slayzone-dev-runner-secret'
  if (opts.standalone && !process.env.SLAYZONE_RUNNER_TRANSPORT_SECRET) {
    // bin.ts must have seeded this; a standalone boot that reached composeServer
    // without it means the resolve step was skipped — fail loud instead of
    // signing tokens with a shared, forgeable constant.
    throw new Error(
      '[slayzone-hub] standalone boot reached composeServer without SLAYZONE_RUNNER_TRANSPORT_SECRET — ' +
        'applyStandaloneHubConfig() must run first (bin.ts)'
    )
  }
  const runnerTransportSecret = process.env.SLAYZONE_RUNNER_TRANSPORT_SECRET ?? DEV_RUNNER_TRANSPORT_SECRET
  // Populated by the async runner init (createHubAuth is async — migrations); a
  // later unit reads these after `runnersReady` to mount the gateway in server.ts.
  let runnerGatewayRef: HubRunnerGateway | null = null
  let hubAuthRef: HubAuth | null = null
  let runnersReady: Promise<void> = Promise.resolve()
  // Runner listener info the runners router bakes into a join token — bound late
  // by the server host (setRunnerListenerInfo) once it knows its own runner URL +
  // cert fingerprint. Null until then, so `mintJoinToken` fails cleanly if
  // called before the listener is up.
  let runnerHubUrl: string | null = null
  let runnerCertFingerprint: string | null = null

  // Make this process's diagnostics queryable (pty + agent-pool run here). Bind
  // FIRST so every subsequent recordDiagnosticEvent persists and any buffered
  // pre-bind events flush. No-op if the host didn't pass a diagnostics DB.
  if (opts.diagnosticsDb) {
    bindDiagnosticsDbs({ settingsDb: db, diagnosticsDb: opts.diagnosticsDb })
  }

  // Late-bound bound port (set once listen() resolves). Declared up front so the
  // host bridge can report it as the renderer-facing tRPC port (the renderer is
  // connected to THIS side-car, not the host).
  let boundPort = 0

  // --- Host capability bridge (supervised only) ------------------------------
  // When supervised by the Electron host, Electron-only capabilities (browser-WCV,
  // clipboard, dialogs, backup, task-windows, floating-agent, native menus, …)
  // can't run in this plain-node process — they forward to the host over the
  // bridge, and host-originated events (native menus, power-resume) stream back.
  // Truly standalone (no host): bridge stays null and the fail-loud stubs apply.
  const hostCapUrl = process.env.SLAYZONE_HOST_CAP_URL
  const bridge: HostBridge | null =
    supervised && hostCapUrl
      ? createHostBridge(hostCapUrl, { getTrpcPort: () => boundPort })
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

  const notifyRenderer = (): void => {
    notifyEvents.emit('tasks-changed')
    notifyEvents.emit('settings-changed')
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

  // --- Task ops --------------------------------------------------------------
  // Completion-event bus the task ops emit on (Electron host: ipcMain). Nothing
  // subscribes here yet — the engine's tag-trigger listener attaches in
  // standalone mode only, when the engine is started (slice 7).
  const taskBus = new EventEmitter()
  // Base task runtime adapters (no worktrees override → the task server's local
  // git/fs default stays bound). Extracted so the runner-routing path can re-supply a
  // COMPLETE object (configureTaskRuntimeAdapters shallow-merges over DEFAULTS,
  // not over the prior call — a partial second call would drop these fields).
  const baseTaskAdapters = {
    getDataRoot: () => dataRoot,
    killTaskProcesses,
    killPtysByTaskId,
    recordDiagnosticEvent,
    // PTY lifecycle now lives in THIS process (slice 9), so the task-status
    // hooks must run here: status→terminal kills the task's PTYs (→ pty:exit
    // streams to the renderer), status→in_progress suggests a respawn.
    onReachedTerminal: onTaskReachedTerminal,
    requestPtyRespawn: broadcastRespawnRequest
  }
  configureTaskRuntimeAdapters(baseTaskAdapters)
  // Wire the cross-domain "task reached terminal status" seam to the REAL
  // teardown (kill PTYs + chat transports). PTYs/chats live in THIS process now,
  // so both the task-ops adapter (onReachedTerminal, above) and server-pure
  // callers (integrations sync/pull) must tear them down here — the Electron
  // host's handler only sees its own (empty) session maps post-cutover.
  setOnTaskReachedTerminalHandler(runtimeOnTaskReachedTerminal)
  setTaskDeps({ ops: taskOps, onMutation: notifyRenderer })

  // Conversation self-heal + authoritative resolver. `createPty` runs in THIS
  // process post-slice-9, so the healer/resolver seams it calls must be wired
  // here — pre-fix they were registered only in the Electron host, leaving the
  // sidecar's copy null: a stale/phantom conversation id then looped `--resume`
  // ("No conversation found") forever with no self-heal. Same orphaned-listener
  // class as the state-change consumers wired just below.
  registerConversationHealer(db, notifyRenderer)
  registerConversationResolver(db)

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
      () => notifyEvents.emit('tasks-changed'),
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
      if (changed) notifyEvents.emit('tasks-changed')
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
  void purgeStaleAndOrphanedTasks(db)
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
    webContents: { send: () => {}, getURL: () => '' }
  }
  configurePtyHost({
    getAllWindows: () => [stubPtyWindow],
    getFocusedWindow: () => stubPtyWindow,
    isDarkTheme: () => true,
    bus: { on: () => undefined }
  })
  // Inject runner-aware spawn lookups BEFORE createPtyOps (which captures the
  // lookups at construction). Only `resolveRunnerId` is overridden — it needs the
  // db, not the gateway, so it's safe to wire synchronously here; the mode-row /
  // project-id reads keep their db defaults. With no runner assigned,
  // `resolveTaskRunnerId` returns null → the spec carries a null runnerId → every
  // routing backend below falls through to local (in-process, the common case).
  const dbLookups = createDbPtySpawnLookups(db)
  setPtySpawnLookups({
    ...dbLookups,
    resolveRunnerId: (taskId) => resolveTaskRunnerId(db, taskId)
  })
  setPtyDeps({ ops: createPtyOps(db), events: ptyEvents })
  // Warm-process pool (plans/agent-sessions.md): pre-warm one agent per active
  // project so opening a task adopts instantly. PTY runs in THIS process
  // (slice 9), so the manager MUST be initialized here — the renderer's warm
  // tab-count reports (`pty.warmSetProjectTabCounts`) land in this process, not
  // the Electron host. It was only ever wired in the host, so it went dead when
  // pty moved to the sidecar; this restores it. `isEnabled` reads a cached
  // `terminal_prewarm_enabled` (sync; refreshed on settings change). Raw
  // `=== '1'` keeps it strictly opt-in.
  let prewarmEnabled = false
  const refreshPrewarm = async (): Promise<void> => {
    try {
      const row = await db.get<{ value?: string }>(
        "SELECT value FROM settings WHERE key = 'terminal_prewarm_enabled'"
      )
      prewarmEnabled = row?.value === '1'
    } catch {
      /* keep last-known value */
    }
  }
  void refreshPrewarm()
  notifyEvents.on('settings-changed', () => void refreshPrewarm())
  initWarmProcessManager({
    db,
    isEnabled: () => prewarmEnabled,
    getProjectRoot: async (projectId) => {
      const row = await db.get<{ path?: string }>('SELECT path FROM projects WHERE id = ?', [
        projectId
      ])
      return row?.path ?? null
    }
  })
  setChatDeps({
    ops: createChatOps(db),
    queueOps: createChatQueueOps(db),
    events: chatEvents,
    queueEvents: chatQueueEvents
  })

  // --- AI config / context manager --------------------------------------------
  // Build the ai-config + marketplace ops singletons that back the tRPC
  // aiConfigRouter (getAiConfigOps/getMarketplaceOps). Their initializer used to
  // live in the ai-config IPC handler registrar, deleted at the Slice 9 cutover
  // (commit 9c809e8d) WITHOUT moving init here — so every aiConfig.* proc threw
  // "aiConfigOps not initialized" (context manager fully broken). Restore it in
  // the data-authority boot, alongside the other ops.
  initAiConfigOps(db)

  // --- Integrations + feedback ------------------------------------------------
  if (opts.standalone) ensureIntegrationSchema(db)
  setIntegrationOps(createIntegrationOps(db))
  // Credential encryption needs Electron safeStorage, absent in this
  // ELECTRON_RUN_AS_NODE process. Supervised: forward encrypt/decrypt to the
  // host's safeStorage over the capability bridge (base64 on the wire).
  // Standalone (no host): leave the cipher unset — the plaintext fallback
  // (gated by SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS / NODE_ENV=test) applies.
  if (bridge) {
    const hostCipher = bridge.appDeps.credentialCipher
    setCredentialCipher({
      isEncryptionAvailable: () => hostCipher.isEncryptionAvailable(),
      encryptString: async (secret) =>
        Buffer.from(await hostCipher.encryptStringToB64(secret), 'base64'),
      decryptString: (encrypted) => hostCipher.decryptStringFromB64(encrypted.toString('base64'))
    })
  }
  const feedbackOps = buildFeedbackOps(db)

  // --- Processes ---------------------------------------------------------------
  // This process owns the process-manager runtime: the renderer drives process
  // ops here (supervised) and standalone owns its own. The Electron host no
  // longer inits it in local mode (would double-spawn auto-restart processes).
  void initProcessManager(db)
  setProcessesDeps({
    create: createProcess,
    spawn: spawnProcess,
    update: updateProcess,
    stop: stopProcess,
    kill: killProcess,
    restart: restartProcess,
    listForTask,
    listAll: listAllProcesses,
    killTask: killTaskProcesses,
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
    // backup — file-level DB copies + Finder reveal live with the Electron host
    // until the slice-7 router split relocates the data half.
    backupList: stub('backupList'),
    backupCreate: stub('backupCreate'),
    backupRename: stub('backupRename'),
    backupDelete: stub('backupDelete'),
    backupRestore: stub('backupRestore'),
    backupGetSettings: stub('backupGetSettings'),
    backupSetSettings: stub('backupSetSettings'),
    backupRevealInFinder: stub('backupRevealInFinder'),

    clipboardWriteFilePaths: stub('clipboardWriteFilePaths'),
    clipboardReadFilePaths: stub('clipboardReadFilePaths'),
    clipboardHasFiles: stub('clipboardHasFiles'),

    screenshotCaptureView: stub('screenshotCaptureView'),
    leaderboardGetLocalStats: stub('leaderboardGetLocalStats'),

    exportAll: stub('exportAll'),
    exportProject: stub('exportProject'),
    importBundle: stub('importBundle'),

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

    feedbackListThreads: feedbackOps.listThreads,
    feedbackCreateThread: feedbackOps.createThread,
    feedbackGetMessages: feedbackOps.getMessages,
    feedbackAddMessage: feedbackOps.addMessage,
    feedbackUpdateThreadDiscordId: feedbackOps.updateThreadDiscordId,
    feedbackDeleteThread: feedbackOps.deleteThread,

    appGetVersion: () => '0.0.0-server',
    appGetTrpcPort: async () => boundPort,
    // Graceful read-path defaults (flag getters / cosmetics) — a throwing stub
    // here would break harmless renderer reads post-flip for no gain.
    appIsTestsPanelEnabled: () => false,
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
    appCheckCliInstalled: () => checkCliInstalled(),
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
    appWindowSetTrafficLightPosition: () => {},
    appWindowSetWindowButtonVisibility: () => {},
    appFocusRenderer: () => {},
    // No window to raise on a headless host.
    appRaiseMainWindow: () => {},
    // No OS nativeTheme off-Electron. Default the preference to "system" so the
    // renderer resolves dark/light from `prefers-color-scheme` (ThemeContext);
    // an explicit light/dark still applies for the session. (Cross-restart
    // persistence of an explicit choice in the fork is a follow-up.)
    themeGetEffective: () => 'dark',
    themeGetSource: () => 'system',
    themeSet: async (pref) => (pref === 'light' ? 'light' : 'dark'),
    // No Electron safeStorage on a headless host — report unavailable so the
    // credential store uses its plaintext fallback (gated by env). The encrypt/
    // decrypt stubs are never reached because the cipher stays unset standalone.
    credentialCipher: {
      isEncryptionAvailable: () => false,
      encryptStringToB64: stub('credentialCipher.encryptStringToB64'),
      decryptStringFromB64: stub('credentialCipher.decryptStringFromB64')
    },
    // No native menu on a headless host.
    appRebuildMenuForShortcuts: () => {},

    // Chromium-fork GitHub OAuth start. Unlike the Electron host (which blocks
    // waiting for the deep-link and returns the code inline), the fork CANNOT
    // receive the callback here — slayzone:// routes to the C++ shell → the
    // sidecar socket (sidecar-socket.ts) → the `app.auth.onCallback` sub. So we
    // only START the flow: fetch the GitHub authorize URL + PKCE verifier, open
    // the browser, and return `pending`. The renderer stashes the verifier and
    // completes the code when the sub delivers it. Reuses the shared
    // requestGithubSignInStart — same PKCE handshake as the Electron host.
    authGithubSystemSignIn: async (input: { convexUrl: string; redirectTo: string }) => {
      try {
        if (!input?.convexUrl) return { ok: false as const, error: 'Convex URL is required' }
        if (input.redirectTo !== 'slayzone://auth/callback') {
          return { ok: false as const, error: `Unsupported redirect URI: ${input.redirectTo}` }
        }
        const start = await requestGithubSignInStart(
          input.convexUrl,
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
    windowClose: () => {},

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
      registerBrowserTab: () => {},
      unregisterBrowserTab: () => {},
      setActiveBrowserTab: () => {},
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
      setPrimaryActive: () => {},
      getPrimaryActive: () => null,
      claimPanel: stub('taskWindows.claimPanel'),
      releasePanel: stub('taskWindows.releasePanel'),
      releaseAllForTask: stub('taskWindows.releaseAllForTask'),
      getOwnership: () => [],
      getWindowId: () => null,
      claimAndCloseOther: stub('taskWindows.claimAndCloseOther'),
      claimSession: stub('taskWindows.claimSession'),
      events: silentEmitter as AppDeps['taskWindows']['events']
    }
    })
  }

  // --- REST deps (capability slots; absent → 501) ------------------------------
  const restDeps: RestApiDeps = {
    db,
    notifyRenderer,
    automationEngine,
    agentLifecycle: agentLifecycleEvents,
    menu: menuEvents,
    taskBus,
    // Enforce the per-task hub bearer a runner-routed pty's hook carries. Verifier
    // is closed over `runnerTransportSecret` (the SAME secret the provider above
    // mints with). Loopback hooks send no bearer → the agent-hook route only
    // enforces when a token is present, so co-located hooks stay unaffected.
    verifyTaskToken: (token: string) => verifyTaskToken(runnerTransportSecret, token),
    // Runner listener info for the loopback `POST /api/runners/join-token` route —
    // the MAIN process's boot-time auto-enroll mints through it (no tRPC client in
    // main). Closed over the SAME late-bound refs the runners registry reads
    // (setRunnerListenerInfo feeds them once the /runners listener binds).
    runners: {
      getHubUrl: () => runnerHubUrl,
      getCertFingerprint: () => runnerCertFingerprint
    },
    // Raise the host window for the CLI/agent `tasks/open` foreground path. The
    // route itself runs HERE (emits the `open-task` menu event on the side-car's
    // bus → renderer); only the window raise is bridged to the Electron host.
    windowActions: bridge
      ? { raiseMainWindow: () => void bridge.appDeps.appRaiseMainWindow() }
      : undefined,
    // browser / artifactExport: Electron-only (live WebContents / offscreen
    // renderer). Their routes are reverse-proxied to the host's REST in server.ts
    // (supervised); absent here so a non-proxied hit still 501s in standalone.
    pty: {
      listPtys,
      hasPty,
      getBuffer,
      writePty,
      submitPty,
      killPty,
      requestEnsureAlive,
      subscribeToPtyData,
      subscribeToStateChange,
      onSessionChange,
      getState
    },
    terminalStateBridge: {
      findSession: findSessionByTaskIdAndMode,
      transition: transitionStateFromHook,
      markActive: markSessionActiveFromHook,
      noteConversationId: noteSessionConversationId,
      noteAwaitingInput: setSessionAwaitingInput
    },
    processes: {
      listAll: listAllProcesses,
      kill: killProcess,
      subscribeToLogs: subscribeToProcessLogs
    }
  }

  // Open the host event stream + prime the browser snapshot cache. Done last so
  // the local emitters (set via setAppDeps above) exist before frames arrive.
  bridge?.connect()

  // --- Runner gateway + hub-auth (async; dark until a runner enrolls) ----------
  // Built off the main path because `createHubAuth` runs better-auth migrations
  // (async). Ordering is safe: the ledger DB stays local (Model A — never
  // proxied); `setPtySpawnLookups` already ran synchronously above; and the
  // routing backends are read per-spawn via getPtyBackend()/getProcessBackend(),
  // so injecting them once the gateway resolves takes effect for later spawns
  // without a mid-session straddle. With no runner registered every spawn's
  // resolved runnerId is null → the routing backends fall through to local, so
  // behavior matches runner-OFF until a runner actually enrolls.
  // Populate the runners registry synchronously (the router may be called before
  // the async gateway init below resolves). The getters read the late-bound refs,
  // so `list` sees the gateway once it exists and `mintJoinToken` sees the
  // URL/fingerprint once the server host feeds them via setRunnerListenerInfo.
  setRunnersDeps({
    getGateway: () => runnerGatewayRef,
    getHubUrl: () => runnerHubUrl,
    getCertFingerprint: () => runnerCertFingerprint
  })

  // Remote-MCP-env provider. Wired synchronously here — it depends only on
  // boundPort (read LAZILY inside the closure) + runnerTransportSecret, neither of
  // which needs the async gateway — so a runner-routed pty spawned before
  // `runnersReady` resolves still gets a valid hub env. A task not bound to a
  // runner keeps today's loopback env (the provider short-circuits on a null
  // runnerId). See `createRemoteMcpEnvProvider` for hubBaseUrl + SLAYZONE_HUB_PUBLIC_URL.
  setRemoteMcpEnvProvider(
    createRemoteMcpEnvProvider({ runnerTransportSecret, getBoundPort: () => boundPort })
  )

  runnersReady = (async () => {
    const hubAuth = await createHubAuth({
      dbPath: join(dataRoot, 'hub-auth.sqlite'),
      baseURL: process.env.SLAYZONE_RUNNER_TRANSPORT_BASE_URL ?? 'http://127.0.0.1:8788',
      secret: runnerTransportSecret
    })
    hubAuthRef = hubAuth
    // Identity-based local-runner dedup (Wave3.5-D5): tell the auth adapters
    // which enroll name is the co-located auto-spawned runner so it collapses to
    // ONE deterministic-id row instead of orphaning one per boot. MUST match the
    // name main injects at auto-enroll — both read the SHARED
    // DEFAULT_LOCAL_RUNNER_NAME const (and honor the SAME SLAYZONE_RUNNER_NAME
    // override), so they can't silently diverge. Remote runners (any other name)
    // keep the fresh-uuid path.
    const localRunnerName = process.env.SLAYZONE_RUNNER_NAME ?? DEFAULT_LOCAL_RUNNER_NAME
    const runnerGateway = createHubRunnerGateway(
      createRunnerAuthAdapters({ db, auth: hubAuth, localRunnerName })
    )
    runnerGatewayRef = runnerGateway

    // Route OS-level exec (pty/proc) to the resolved runner; a null runnerId
    // (baked into the spec by the runner-aware spawn lookups above) falls
    // through to the in-process local backend.
    setPtyBackend(
      createRoutingPtyBackend({
        gateway: runnerGateway,
        local: localPtyBackend,
        resolveRunnerId: (spec) => spec.runnerId ?? null
      })
    )
    setProcessBackend(
      createRoutingProcessBackend({
        gateway: runnerGateway,
        local: localProcessBackend,
        resolveRunnerId: (spec) => spec.runnerId ?? null
      })
    )
    // Re-configure with a COMPLETE object (shallow-merge over defaults): re-supply
    // every base field so nothing is dropped, plus the routing worktree adapter.
    configureTaskRuntimeAdapters({
      ...baseTaskAdapters,
      worktrees: createRemoteWorktreeAdapters({
        gateway: runnerGateway,
        // Per-task worktree runner routing is a later unit — the WorktreeExecAdapters
        // seam carries no task id, so there's no task context to route on here.
        // null keeps worktree git/fs work hub-local (createRemoteWorktreeAdapters
        // degrades every method to `local`); the seam is wired, ready to route.
        resolveRunnerId: () => null,
        local: defaultWorktreeExecAdapters
      })
    })
  })().catch((err) => {
    recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'runner.init_failed',
      message: err instanceof Error ? err.message : String(err)
    })
  })

  return {
    notifyRenderer,
    automationEngine,
    restDeps,
    setBoundPort: (port: number) => {
      boundPort = port
    },
    get runnerGateway(): HubRunnerGateway | null {
      return runnerGatewayRef
    },
    get hubAuth(): HubAuth | null {
      return hubAuthRef
    },
    runnersReady,
    setRunnerListenerInfo: (info) => {
      runnerHubUrl = info.hubUrl
      runnerCertFingerprint = info.certFingerprint
    }
  }
}
