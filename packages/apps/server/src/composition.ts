import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  openPath as nativeOpenPath,
  pathExists as nativePathExists,
  showItemInFolder as nativeShowItemInFolder
} from './shell-native'
import type { SlayzoneDb } from '@slayzone/platform'
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
  type AppDeps,
  type NotifyEventMap,
  type AutomationsEventMap,
  type TelemetryEventMap,
  type MenuEventMap,
  type AgentLifecycleEventMap,
  type RestApiDeps,
  type FloatingAgentState
} from '@slayzone/transport/server'
import { createHostBridge, type HostBridge } from './host-bridge.js'
import {
  taskOps,
  configureTaskRuntimeAdapters,
  startArtifactWatcher,
  purgeStaleAndOrphanedTasks
} from '@slayzone/task/server'
import {
  createPtyOps,
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
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
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
  subscribeToProcessLogs
} from '@slayzone/processes/server'

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
}

export function composeServer(opts: {
  db: SlayzoneDb
  dataRoot: string
  /** Standalone (non-supervised) boot: hydrate the process registry and ensure
   *  aux schemas. Supervised (dark, Electron-owned DB): skip — the host did. */
  standalone: boolean
}): ServerComposition {
  const { db, dataRoot } = opts
  const supervised = !opts.standalone

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

  setNotifyEvents(notifyEvents)
  setAutomationsEvents(automationsEvents)
  setTelemetryEvents(telemetryEvents)
  setMenuEvents(menuEvents)
  setAgentLifecycleEvents(agentLifecycleEvents)

  // --- Task ops --------------------------------------------------------------
  // Completion-event bus the task ops emit on (Electron host: ipcMain). Nothing
  // subscribes here yet — the engine's tag-trigger listener attaches in
  // standalone mode only, when the engine is started (slice 7).
  const taskBus = new EventEmitter()
  configureTaskRuntimeAdapters({
    getDataRoot: () => dataRoot,
    killTaskProcesses,
    killPtysByTaskId,
    recordDiagnosticEvent,
    // PTY lifecycle now lives in THIS process (slice 9), so the task-status
    // hooks must run here: status→terminal kills the task's PTYs (→ pty:exit
    // streams to the renderer), status→in_progress suggests a respawn.
    onReachedTerminal: onTaskReachedTerminal,
    requestPtyRespawn: broadcastRespawnRequest
  })
  // Wire the cross-domain "task reached terminal status" seam to the REAL
  // teardown (kill PTYs + chat transports). PTYs/chats live in THIS process now,
  // so both the task-ops adapter (onReachedTerminal, above) and server-pure
  // callers (integrations sync/pull) must tear them down here — the Electron
  // host's handler only sees its own (empty) session maps post-cutover.
  setOnTaskReachedTerminalHandler(runtimeOnTaskReachedTerminal)
  setTaskDeps({ ops: taskOps, onMutation: notifyRenderer })

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
  setPtyDeps({ ops: createPtyOps(db), events: ptyEvents })
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

    shellOpenExternal: stub('shellOpenExternal'),
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
    appCheckCliInstalled: () => ({ installed: false }),
    appInstallCli: stub('appInstallCli'),
    appAdjustZoom: stub('appAdjustZoom'),
    appRestartForUpdate: stub('appRestartForUpdate'),
    appCheckForUpdates: stub('appCheckForUpdates'),
    // Read-path: a renderer served BY this server is asking about the server
    // itself — report self status instead of a supervisor snapshot.
    appGetSidecarStatus: () => ({
      health: 'ready' as const,
      port: boundPort || null,
      pid: process.pid,
      restarts: 0,
      totalRespawns: 0,
      dbPath: null,
      uptimeMs: Math.round(process.uptime() * 1000)
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
    // No nativeTheme off-Electron — remote/standalone UI hides theme controls.
    themeGetEffective: () => 'dark',
    themeGetSource: () => 'dark',
    themeSet: async () => 'dark',
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

    authGithubSystemSignIn: stub('authGithubSystemSignIn'),
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

  return {
    notifyRenderer,
    automationEngine,
    restDeps,
    setBoundPort: (port: number) => {
      boundPort = port
    }
  }
}
