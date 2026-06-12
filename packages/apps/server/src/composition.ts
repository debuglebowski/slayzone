import { EventEmitter } from 'node:events'
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
  setAppDeps,
  setPtyDeps,
  setChatDeps,
  type AppDeps,
  type NotifyEventMap,
  type AutomationsEventMap,
  type TelemetryEventMap,
  type MenuEventMap,
  type RestApiDeps,
  type FloatingAgentState
} from '@slayzone/transport/server'
import { taskOps, configureTaskRuntimeAdapters } from '@slayzone/task/server'
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
  setSessionAwaitingInput
} from '@slayzone/terminal/server'
import { createIntegrationOps, ensureIntegrationSchema } from '@slayzone/integrations/server'
import { buildFeedbackOps } from '@slayzone/feedback/server'
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

  // --- Cross-domain event buses (this process's own instances) --------------
  const notifyEvents = new TypedEmitter<NotifyEventMap>()
  const automationsEvents = new TypedEmitter<AutomationsEventMap>()
  const telemetryEvents = new TypedEmitter<TelemetryEventMap>()
  const menuEvents = new TypedEmitter<MenuEventMap>()

  const notifyRenderer = (): void => {
    notifyEvents.emit('tasks-changed')
    notifyEvents.emit('settings-changed')
  }

  setNotifyEvents(notifyEvents)
  setAutomationsEvents(automationsEvents)
  setTelemetryEvents(telemetryEvents)
  setMenuEvents(menuEvents)

  // --- Task ops --------------------------------------------------------------
  // Completion-event bus the task ops emit on (Electron host: ipcMain). Nothing
  // subscribes here yet — the engine's tag-trigger listener attaches in
  // standalone mode only, when the engine is started (slice 7).
  const taskBus = new EventEmitter()
  configureTaskRuntimeAdapters({
    getDataRoot: () => dataRoot,
    killTaskProcesses,
    killPtysByTaskId,
    recordDiagnosticEvent
    // requestPtyRespawn / onReachedTerminal: renderer-facing — no-op defaults.
  })
  setTaskDeps({ ops: taskOps, onMutation: notifyRenderer })

  // --- PTY + chat runtime (host bridge stays inert: no windows, tRPC-only) ----
  setPtyDeps({ ops: createPtyOps(db), events: ptyEvents })
  setChatDeps({
    ops: createChatOps(db),
    queueOps: createChatQueueOps(db),
    events: chatEvents,
    queueEvents: chatQueueEvents
  })

  // --- Integrations + feedback ------------------------------------------------
  if (opts.standalone) ensureIntegrationSchema(db)
  setIntegrationOps(createIntegrationOps(db))
  const feedbackOps = buildFeedbackOps(db)

  // --- Processes ---------------------------------------------------------------
  if (opts.standalone) void initProcessManager(db)
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

  // --- App-level deps: real where pure, fail-loud stubs where electron-bound ---
  let boundPort = 0
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

    filesPathExists: stub('filesPathExists'),
    filesSaveTempImage: stub('filesSaveTempImage'),

    shellOpenExternal: stub('shellOpenExternal'),
    shellOpenPath: stub('shellOpenPath'),

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
      dbPath: null,
      uptimeMs: Math.round(process.uptime() * 1000)
    }),
    appRevealSidecarLog: stub('appRevealSidecarLog'),

    appWindowGetContentBounds: () => null,
    appWindowGetDisplayScaleFactor: () => null,
    // Window-cosmetic setters no-op off-window in the Electron host too.
    appWindowSetTrafficLightPosition: () => {},
    appWindowSetWindowButtonVisibility: () => {},

    authGithubSystemSignIn: stub('authGithubSystemSignIn'),
    dialogShowOpenDialog: stub('dialogShowOpenDialog'),
    windowClose: () => {},

    browser: {
      createView: stub('browser.createView'),
      destroyView: stub('browser.destroyView'),
      destroyAllForTask: stub('browser.destroyAllForTask'),
      setBounds: stub('browser.setBounds'),
      setVisible: stub('browser.setVisible'),
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

  // --- REST deps (capability slots; absent → 501) ------------------------------
  const restDeps: RestApiDeps = {
    db,
    notifyRenderer,
    automationEngine,
    menu: menuEvents,
    taskBus,
    // browser / artifactExport / windowActions / legacyBroadcast: absent —
    // those are Electron-shell capabilities (routes 501).
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

  return {
    notifyRenderer,
    automationEngine,
    restDeps,
    setBoundPort: (port: number) => {
      boundPort = port
    }
  }
}
