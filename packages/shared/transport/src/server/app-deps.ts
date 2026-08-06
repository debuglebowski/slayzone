// App-level dependencies that the router needs but cannot import directly.
//
// The chat ops live in `@slayzone/terminal/electron`, which lazily `require`s
// `electron` and pulls in `node-pty` — both forbidden inside the transport
// package (it must run under plain Node for the standalone `@slayzone/hub`
// host). So we `import type` only (erased at build → zero electron at runtime)
// and the Electron-main host injects the concrete instances at startup via
// `setChatDeps()`. A standalone server without these wired would throw on the
// first chat procedure call.

import type { EventEmitter } from 'node:events'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { CliInstallResult } from '@slayzone/platform'
import type { DiagnosticsConfig } from '@slayzone/diagnostics/shared'
import type { AgentLifecycleEvent } from '@slayzone/terminal/shared'
import type {
  createChatOps,
  createChatQueueOps,
  ChatEventMap,
  ChatQueueEventMap,
  createPtyOps,
  PtyEventMap
} from '@slayzone/terminal/electron'
import type { IntegrationOps } from '@slayzone/integrations/server'
import type { TaskOps } from '@slayzone/task/server'
import type {
  BackupInfo,
  BackupSettings,
  ProcessInfo,
  ProcessEventMap,
  UpdateStatus,
  BrowserShortcutPayload,
  BrowserCreateTaskFromLinkIntent
} from '@slayzone/types'

/**
 * Backup ops — injected by the composition root rather than built in the router.
 *
 * Unlike leaderboard/feedback/export-import, backup needs things only the host
 * process knows: whether this hub is supervised (restore is refused otherwise),
 * the live DB file path, and how to close its own connection before that file is
 * overwritten. So it stays a registry, but the IMPLEMENTATION now lives with the
 * database instead of on the far side of a capability bridge.
 */
export type BackupOps = {
  list: () => Promise<BackupInfo[]>
  create: (name?: string) => Promise<BackupInfo>
  rename: (filename: string, name: string) => Promise<void>
  delete: (filename: string) => Promise<void>
  restore: (filename: string) => Promise<void>
  getSettings: () => Promise<BackupSettings>
  setSettings: (partial: Partial<BackupSettings>) => Promise<BackupSettings>
  revealInFinder: () => void
}

let backupOps: BackupOps | null = null

export function setBackupOps(ops: BackupOps): void {
  backupOps = ops
}

export function getBackupOps(): BackupOps {
  if (!backupOps) throw new Error('backupOps not initialized — call setBackupOps() at boot')
  return backupOps
}

// Floating global agent panel state — the payload `getState()` returns and the
// `state` event emits (mirrors floating-global-agent-panel.ts currentStatePayload).
// Lives transport-side (transport can't import from apps/app); the host conforms.
export type FloatingAgentState = {
  kind: string
  sessionId: string | null
  mode: 'auto' | 'manual' | null
  hasCustomSize: boolean
}
import type { ProviderUsage, UsageProviderConfig, UsageWindow } from '@slayzone/terminal/shared'

// Chat deps — ops + queue ops + the two streaming emitters the subscriptions
// subscribe to. Same instances back the IPC handlers (coexistence until slice 5).
export type ChatDeps = {
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<typeof createChatQueueOps>
  events: TypedEmitter<ChatEventMap>
  queueEvents: TypedEmitter<ChatQueueEventMap>
}

let chatDeps: ChatDeps | null = null

export function setChatDeps(deps: ChatDeps): void {
  chatDeps = deps
}

export function getChatDeps(): ChatDeps {
  if (!chatDeps) throw new Error('chatDeps not initialized — call setChatDeps() in main host first')
  return chatDeps
}

// Pty deps — ops + the single streaming emitter the pty subscriptions subscribe
// to. `createPtyOps`/`ptyEvents` live in `@slayzone/terminal/electron` (electron +
// node-pty), so `import type` only here; the Electron-main host injects the
// concrete instances via `setPtyDeps()`. Same instances back the IPC handlers
// (coexistence until slice 5).
export type PtyDeps = {
  ops: ReturnType<typeof createPtyOps>
  events: TypedEmitter<PtyEventMap>
}

let ptyDeps: PtyDeps | null = null

export function setPtyDeps(deps: PtyDeps): void {
  ptyDeps = deps
}

export function getPtyDeps(): PtyDeps {
  if (!ptyDeps) throw new Error('ptyDeps not initialized — call setPtyDeps() in main host first')
  return ptyDeps
}

// Integration ops — the electron-coupled domain ops (`@slayzone/integrations/server`
// pulls electron + node clients), injected by the host so the `integrationsRouter`
// and the still-live IPC handlers share one instance (coexistence until slice 5).
let integrationOps: IntegrationOps | null = null

export function setIntegrationOps(ops: IntegrationOps): void {
  integrationOps = ops
}

export function getIntegrationOps(): IntegrationOps {
  if (!integrationOps)
    throw new Error('integrationOps not initialized — call setIntegrationOps() in main host first')
  return integrationOps
}

// Task CRUD/deps/board ops — electron-coupled (`createTaskOp` pulls
// `@slayzone/worktrees/main` → electron). `import type` only here (erased at build →
// zero electron at runtime); the Electron-main host injects the concrete bundle via
// `setTaskDeps()` so the `task` router and the still-live IPC handlers share one
// implementation (coexistence until slice 5). The artifacts/template stores are
// electron-free and imported directly by their routers — not injected.
let taskOps: TaskOps | null = null
// Host-injected post-mutation callback (`notifyTasksChanged`) — the same renderer
// refresh signal the legacy IPC handlers fire. Threaded into the task router's
// OpDeps so tRPC mutations broadcast `notify.onTasksChanged` like the IPC path.
let taskOnMutation: (() => void) | undefined

export function setTaskDeps(deps: { ops: TaskOps; onMutation?: () => void }): void {
  taskOps = deps.ops
  taskOnMutation = deps.onMutation
}

export function getTaskOps(): TaskOps {
  if (!taskOps)
    throw new Error('taskOps not initialized — call setTaskDeps() in main host first')
  return taskOps
}

export function getTaskOnMutation(): (() => void) | undefined {
  return taskOnMutation
}

// Notify event bus — the cross-domain `tasks-changed` / `settings-changed`
// signals that back the `notify.*` subscriptions. The emitter is owned by the
// Electron-main host (`notify-renderer.ts`, which also drives the legacy IPC
// broadcast), injected here so the `notifyRouter` and the still-live
// `webContents.send` broadcast share one instance (coexistence until slice 5).
// `NotifyEventMap` lives transport-side because transport cannot import from
// `apps/app` (apps depend on packages, not vice-versa); the host conforms to it.
export type NotifyEventMap = {
  /** Any task data mutation — renderer refetches the board. No payload. */
  'tasks-changed': []
  /** Settings changed — renderer refetches affected config. No payload. */
  'settings-changed': []
  /**
   * The supervised embedded @slayzone/hub exhausted its restart backoff
   * (slice 7) — renderer shows a persistent toast. Emitted by the Electron
   * host's sidecar supervisor `onPermanentFailure`.
   */
  'embedded-server-failed': [{ attempts: number; message: string }]
}

let notifyEvents: TypedEmitter<NotifyEventMap> | null = null

export function setNotifyEvents(ev: TypedEmitter<NotifyEventMap>): void {
  notifyEvents = ev
}

export function getNotifyEvents(): TypedEmitter<NotifyEventMap> {
  if (!notifyEvents)
    throw new Error('notifyEvents not initialized — call setNotifyEvents() in main host first')
  return notifyEvents
}

// Automations-changed bus — fires when the AutomationEngine mutates automations
// (manual run, trigger fire, CRUD). Backs the `automations.onChanged` sub. The
// emitter is owned by the Electron-main host, injected here so the router and the
// still-live `automations:changed` webContents.send share one instance (dual-emit).
export type AutomationsEventMap = {
  /** Any automation data change — renderer invalidates affected queries. No payload. */
  changed: []
}

let automationsEvents: TypedEmitter<AutomationsEventMap> | null = null

export function setAutomationsEvents(ev: TypedEmitter<AutomationsEventMap>): void {
  automationsEvents = ev
}

export function getAutomationsEvents(): TypedEmitter<AutomationsEventMap> {
  if (!automationsEvents)
    throw new Error(
      'automationsEvents not initialized — call setAutomationsEvents() in main host first'
    )
  return automationsEvents
}

// Telemetry IPC-event bus — the main-side `setIpcSuccessHook` fans instrumented
// IPC successes here. Backs the `telemetry.onIpcEvent` sub. Host-owned, injected
// so the router and the still-live `telemetry:ipc-event` send share one instance.
export type TelemetryEventMap = {
  'ipc-event': [event: string, props: Record<string, unknown>]
}

let telemetryEvents: TypedEmitter<TelemetryEventMap> | null = null

export function setTelemetryEvents(ev: TypedEmitter<TelemetryEventMap>): void {
  telemetryEvents = ev
}

export function getTelemetryEvents(): TypedEmitter<TelemetryEventMap> {
  if (!telemetryEvents)
    throw new Error(
      'telemetryEvents not initialized — call setTelemetryEvents() in main host first'
    )
  return telemetryEvents
}

// Menu / app-shortcut event bus — the one-way main→renderer `app:*` / `browser:*`
// broadcasts driven by native menus, the `before-input-event` accelerator handler,
// the auto-updater, and the REST/MCP task-open routes. The emitter is owned by the
// Electron-main host (`menu-events.ts`, which is dual-emitted alongside the legacy
// `webContents.send` broadcasts), injected here so the `menuRouter` and the still-live
// IPC broadcasts share one instance (coexistence until the renderer drops IPC in
// slice 5). `MenuEventMap` lives transport-side because transport cannot import from
// `apps/app` (apps depend on packages, not vice-versa); the host conforms to it.
export type MenuEventMap = {
  'go-home': []
  'toggle-global-agent-panel': []
  'toggle-agent-status-panel': []
  'open-settings': []
  'open-project-settings': []
  'new-temporary-task': []
  'open-task': [payload: { taskId: string; background?: boolean }]
  'close-task': [taskId: string]
  'open-artifact': [payload: { taskId: string; artifactId: string }]
  'screenshot-trigger': []
  'close-current-focus': []
  'close-active-task': []
  'sync-session-id': []
  'reload-browser': []
  'reload-app': []
  'zoom-factor-changed': [factor: number]
  'update-status': [status: UpdateStatus]
  'browser-ensure-panel-open': [payload: { taskId: string; url?: string; tabId?: string }]
  'browser-create-tab': [
    payload: { taskId: string; tabId: string; url?: string; background?: boolean }
  ]
  'browser-agent-touched': [payload: { taskId: string; tabId: string }]
}

let menuEvents: TypedEmitter<MenuEventMap> | null = null

export function setMenuEvents(ev: TypedEmitter<MenuEventMap>): void {
  menuEvents = ev
}

export function getMenuEvents(): TypedEmitter<MenuEventMap> {
  if (!menuEvents)
    throw new Error('menuEvents not initialized — call setMenuEvents() in main host first')
  return menuEvents
}

export type AgentLifecycleEventMap = {
  event: [event: AgentLifecycleEvent]
}

let agentLifecycleEvents: TypedEmitter<AgentLifecycleEventMap> | null = null

export function setAgentLifecycleEvents(ev: TypedEmitter<AgentLifecycleEventMap>): void {
  agentLifecycleEvents = ev
}

export function getAgentLifecycleEvents(): TypedEmitter<AgentLifecycleEventMap> {
  if (!agentLifecycleEvents)
    throw new Error(
      'agentLifecycleEvents not initialized — call setAgentLifecycleEvents() in main host first'
    )
  return agentLifecycleEvents
}

// Auth-callback bus — backs the `app.auth.onCallback` subscription. The
// chromium-fork sidecar's Unix-socket server (sidecar-socket.ts) receives the
// `slayzone://auth/callback` deep-link from the C++ shell (auth:deep-link RPC)
// and emits the OAuth code/error here; the subscription fans it out to the
// renderer's ConvexAuthBridge, which completes the Convex sign-in. Unlike the
// other buses this one is process-LOCAL (emitter and subscriber both live in
// THIS sidecar process — no Electron-host injection); composeServer constructs
// and sets it before connections are accepted. Electron's renderer uses the
// inline-mutation path and never subscribes, so nothing emits here in Electron.
export type AuthEventMap = {
  /** OAuth deep-link callback relayed from the chromium shell → sidecar. */
  callback: [payload: { code?: string; error?: string }]
}

let authEvents: TypedEmitter<AuthEventMap> | null = null

export function setAuthEvents(ev: TypedEmitter<AuthEventMap>): void {
  authEvents = ev
}

export function getAuthEvents(): TypedEmitter<AuthEventMap> {
  if (!authEvents)
    throw new Error('authEvents not initialized — call setAuthEvents() in composeServer first')
  return authEvents
}

// Task-trigger bus — the AutomationEngine's `start(bus)` listens here for
// `db:taskTags:setForTask:done` (the tag-change trigger). Legacy host emitted it
// on `ipcMain`; the tRPC `tags.setForTask` path never did (the pre-existing
// trigger gap). The side-car sets this to the SAME EventEmitter it passes to
// `engine.start()`, so `tags.setForTask` can fire the trigger. Nullable — when
// unset (host/standalone with no started engine) the tags path just no-ops it.
export type TaskTriggerBus = {
  emit: (channel: string, ...args: unknown[]) => boolean
}

let taskTriggerBus: TaskTriggerBus | null = null

export function setTaskTriggerBus(bus: TaskTriggerBus): void {
  taskTriggerBus = bus
}

export function getTaskTriggerBus(): TaskTriggerBus | null {
  return taskTriggerBus
}

// Power-resume bus — Electron `powerMonitor.on('resume')` is host-only, but the
// AutomationEngine (which runs catchup on wake) lives in the side-car after the
// slice-9 cutover. The host fires `resume` on this emitter; the capability
// bridge forwards it to the side-car, which calls `automationEngine.runCatchup()`.
export type PowerResumeEventMap = {
  resume: []
}

let powerResumeEvents: TypedEmitter<PowerResumeEventMap> | null = null

export function setPowerResumeEvents(ev: TypedEmitter<PowerResumeEventMap>): void {
  powerResumeEvents = ev
}

export function getPowerResumeEvents(): TypedEmitter<PowerResumeEventMap> {
  if (!powerResumeEvents)
    throw new Error(
      'powerResumeEvents not initialized — call setPowerResumeEvents() in main host first'
    )
  return powerResumeEvents
}

// App-level ops — the grab-bag of main-process capabilities (backup, clipboard,
// screenshot, leaderboard, export/import, usage, …) that the `app` router wraps.
// Each is electron- or DB-coupled, so `import type` only here; the Electron-main
// host injects concrete impls via `setAppDeps()`. Same impls back the still-live
// IPC handlers (coexistence until slice 5). Signatures are Promise-typed because
// main's `SlayzoneDb` is async (worker_thread). A standalone server without these
// wired throws on the first app procedure call.
export type AppDeps = {
  /** Relaunch the desktop app. Used by backup restore, which overwrites the
   *  database file and must then restart everything pointing at it. */
  appRelaunch: () => void

  /**
   * Hand a saved diagnostics config to the desktop, which persists it to the
   * CLIENT store.
   *
   * Both processes record into the same machine-local diagnostics database but
   * hold separate copies of the config that gates it — the hub's in the shared
   * DB, the desktop's in the client store — and the Settings UI writes to the
   * hub. Without this the desktop keeps recording after the user turns
   * diagnostics off.
   */
  diagnosticsConfigChanged: (next: DiagnosticsConfig) => Promise<void>

  // clipboard
  clipboardWriteFilePaths: (paths: string[]) => void
  clipboardReadFilePaths: () => string[]
  clipboardHasFiles: () => boolean

  // screenshot
  screenshotCaptureView: (viewId: string) => Promise<{ success: boolean; path?: string }>

  // usage
  /** Providers are resolved from ctx.db by the caller — usage is an Electron
   *  `net.fetch` over rows that live in the database, so each half runs where it
   *  belongs instead of dragging a DB handle onto the host. */
  usageFetch: (
    providers: {
      customRows: { id: string; label: string; usage_config: string }[]
      builtinEnabled: Record<string, boolean>
    },
    force?: boolean
  ) => Promise<ProviderUsage[]>
  usageTest: (
    config: UsageProviderConfig
  ) => Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }>

  // files
  filesPathExists: (filePath: string) => Promise<boolean>
  filesSaveTempImage: (
    base64: string,
    mimeType: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>

  // shell
  shellOpenExternal: (
    url: string,
    options?: {
      blockDesktopHandoff?: boolean
      desktopHandoff?: { protocol?: string; hostScope?: string }
    }
  ) => void
  shellOpenPath: (absPath: string) => Promise<string>
  // Reveal + select an item in the OS file manager (Electron shell only) —
  // backs file-editor `showInFinder`. Forwarded over the capability bridge.
  shellShowItemInFolder: (absPath: string) => void


  // app metadata (read-only)
  appGetVersion: () => string
  /**
   * OS downloads folder — the default directory for artifact save dialogs.
   * Async because the capability bridge forwards every call over the wire; a
   * sync signature here would type-check (the bridge proxy is cast to AppDeps)
   * and then hand callers a Promise at runtime.
   */
  appGetDownloadsDir: () => Promise<string>
  appGetTrpcPort: () => Promise<number>
  appIsTestsPanelEnabled: () => boolean
  /**
   * Labs flags are CLIENT-scoped — they gate native menu items the host builds
   * before any hub exists, so they live in the client store. The read already came
   * through AppDeps; this is the matching write, without which the Labs tab would
   * update a hub row nothing reads.
   */
  appSetLabFlag: (key: 'labs_tests_panel' | 'labs_loop_mode', on: boolean) => Promise<void>
  appIsLoopModeEnabled: () => boolean
  appGetZoomFactor: () => number
  appGetProtocolClientStatus: () => {
    scheme: string
    attempted: boolean
    registered: boolean
    reason: 'registered' | 'dev-skipped' | 'registration-failed'
  }
  appGetRendererZoomFactor: () => number | null
  appCheckCliInstalled: () => { installed: boolean; path?: string }
  appInstallCli: () => Promise<CliInstallResult>
  appAdjustZoom: (command: 'in' | 'out' | 'reset') => number
  appRestartForUpdate: () => Promise<void>
  appCheckForUpdates: () => Promise<void>

  // shortcuts — rebuild the native app menu from the persisted custom-shortcut
  // overrides after the renderer writes them (was the `shortcuts:changed` IPC).
  // No-op on a headless host (no native menu).
  appRebuildMenuForShortcuts: () => void

  // side-car supervisor (dark-launch) — read-only status + log reveal for the
  // Diagnostics settings tab. Shape mirrors the host's `SidecarStatus`
  // (transport stays decoupled from the supervisor module).
  appGetSidecarStatus: () => {
    health: 'starting' | 'ready' | 'restarting' | 'failed'
    port: number | null
    pid: number | null
    restarts: number
    totalRespawns: number
    dbPath: string | null
    uptimeMs: number | null
    runningBuildId: string | null
    diskBuildId: string | null
    stale: boolean
  }
  appRevealSidecarLog: () => void

  // window
  appWindowGetContentBounds: () => {
    x: number
    y: number
    width: number
    height: number
  } | null
  appWindowGetDisplayScaleFactor: () => number | null
  // macOS traffic-light controls — windowId resolves the target window (tRPC:
  // ctx.windowId; IPC: event.sender). No-op off darwin / when the window can't be
  // resolved. Same impl backs `window:set-traffic-light-position` /
  // `window:set-window-button-visibility` IPC (coexistence until the bridge drops).
  appWindowSetTrafficLightPosition: (
    windowId: number | null,
    pos: { x: number; y: number } | null
  ) => void
  appWindowSetWindowButtonVisibility: (windowId: number | null, visible: boolean) => void
  // Pull OS keyboard focus back to the connection's renderer webContents (e.g.
  // so the browser find input receives keys instead of a focused WCV). Graceful
  // no-op when the window can't be resolved / isn't focused. windowId is the
  // caller's webContents id (ctx.windowId), matching `windowClose`.
  appFocusRenderer: (windowId: number | null) => void
  // Raise/show+focus the main window — the CLI/agent `tasks/open` foreground
  // path. Forwarded over the capability bridge so the side-car's REST route can
  // bring the Electron host window forward. No-op off-window (standalone).
  appRaiseMainWindow: () => void

  // Theme — Electron `nativeTheme`-backed (resolves 'system' against the OS), so
  // host-only. The `settings.*Theme` tRPC procedures resolve these (forwarded
  // over the capability bridge); the `theme:changed` event streams back on the
  // bridge's `theme` channel → the side-car's settingsEvents → onThemeChanged.
  themeGetEffective: () => 'dark' | 'light'
  themeGetSource: () => 'system' | 'light' | 'dark'
  themeSet: (pref: 'light' | 'dark' | 'system') => Promise<'dark' | 'light'>

  // Credential cipher — Electron `safeStorage`-backed, so host-only. The side-car
  // runs as ELECTRON_RUN_AS_NODE (no safeStorage), so its credential store
  // forwards encrypt/decrypt here over the bridge. Base64 strings on the wire
  // (superjson does not round-trip Buffer).
  credentialCipher: {
    isEncryptionAvailable: () => boolean
    encryptStringToB64: (secret: string) => string
    decryptStringFromB64: (b64: string) => string
  }

  // auth
  authGithubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) => Promise<unknown>

  // dialog (native file picker — same electron dialog API backs the
  // `dialog:showOpenDialog` IPC handler; coexistence until slice 5)
  dialogShowOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>
  // Native save sheet, parented to the focused window host-side so the side-car
  // never needs a window handle. Backs every artifact download.
  dialogShowSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>

  // Artifact export — offscreen BrowserWindow rendering, unavailable off the
  // Electron host. HTML building lives here too (not side-car side) because
  // buildMermaidPdfHtml resolves mermaid via require.resolve and silently falls
  // back to plain-code rendering when it misses; from the side-car bundle it
  // would miss every time and quietly downgrade mermaid exports. The renderers
  // write straight to destPath so multi-MB buffers never cross the bridge.
  artifactBuildExportHtml: (content: string, mode: string, title: string) => Promise<string>
  artifactRenderPdfToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<void>
  /** False when the mode has no PNG representation (buildPngHtml declined). */
  artifactRenderPngToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<boolean>

  // window.close — closes the window owning the connection (ctx.windowId).
  // Same effect as the `window:close` IPC (which uses event.sender).
  windowClose: (windowId: number) => void

  /**
   * The task/tab browser REGISTRY — distinct from `browser` below, which is the
   * view-id-keyed WebContentsView manager.
   *
   * Exists so the REST browser routes can run on the hub, where the
   * `tasks.browser_tabs` row they read and write lives. They used to be
   * reverse-proxied to the desktop wholesale, purely because the old
   * `BrowserAccess` handed back a live `WebContents` — which in turn forced the
   * desktop to keep its own connection to the shared database. A handle can't
   * cross the bridge; `(taskId, tabId)` can.
   *
   * `capturePageToFile` writes the PNG on the host so a full-page image never
   * travels as a buffer, matching the `artifactRender*ToFile` slots.
   */
  browserTabs: {
    getResolvedTabId: (taskId: string, tabId?: string) => Promise<string | null>
    listTabs: (taskId: string) => Promise<Array<{ tabId: string; active?: boolean }>>
    hasTab: (taskId: string, tabId?: string) => Promise<boolean>
    /** Resolves once a tab registers; rejects on timeout. */
    waitForRegistration: (
      taskId: string,
      opts: { tabId?: string; timeoutMs?: number }
    ) => Promise<void>
    execJs: (taskId: string, tabId: string | null, code: string) => Promise<unknown>
    loadUrl: (taskId: string, tabId: string | null, url: string) => Promise<void>
    getUrl: (taskId: string, tabId: string | null) => Promise<string | null>
    /** False when the captured image was empty. */
    capturePageToFile: (
      taskId: string,
      tabId: string | null,
      destPath: string
    ) => Promise<boolean>
  }

  // Browser view manager — heavy electron coupling, expose as opaque object
  // and call methods directly from procedures. All return types are unknown
  // since the manager's public surface evolves; callers cast on the renderer.
  browser: {
    createView: (opts: unknown) => unknown
    destroyView: (viewId: string) => unknown
    destroyAllForTask: (taskId: string) => unknown
    setBounds: (viewId: string, bounds: unknown) => unknown
    setVisible: (viewId: string, visible: boolean) => unknown
    /** Agent lock: drop OS-origin input while keeping the view rendering. */
    setLocked: (viewId: string, locked: boolean) => unknown
    hideAll: () => unknown
    showAll: () => unknown
    setHandoffPolicy: (viewId: string, policy: unknown) => unknown
    navigate: (viewId: string, url: string) => unknown
    goBack: (viewId: string) => unknown
    goForward: (viewId: string) => unknown
    reload: (viewId: string, ignoreCache?: boolean) => unknown
    stop: (viewId: string) => unknown
    executeJs: (viewId: string, code: string) => unknown
    insertCss: (viewId: string, css: string) => unknown
    removeCss: (viewId: string, key: string) => unknown
    setZoom: (viewId: string, factor: number) => unknown
    focus: (viewId: string) => unknown
    findInPage: (viewId: string, text: string, options?: unknown) => unknown
    stopFindInPage: (
      viewId: string,
      action: 'clearSelection' | 'keepSelection' | 'activateSelection'
    ) => unknown
    setKeyboardPassthrough: (viewId: string, enabled: boolean) => unknown
    sendInputEvent: (viewId: string, input: unknown) => unknown
    openDevTools: (viewId: string, mode: 'bottom' | 'right' | 'undocked' | 'detach') => unknown
    closeDevTools: (viewId: string) => unknown
    isDevToolsOpen: (viewId: string) => unknown
    getUrl: (viewId: string) => unknown
    getBounds: (viewId: string) => unknown
    getZoomFactor: (viewId: string) => unknown
    getActualNativeBounds: (viewId: string) => unknown
    getViewVisible: (viewId: string) => unknown
    getViewsForTask: (taskId: string) => unknown
    getAllViewIds: () => unknown
    listViews: () => unknown
    getNativeChildViewCount: () => unknown
    isAllHidden: () => unknown
    isFocused: (viewId: string) => unknown
    isViewNativelyVisible: (viewId: string) => unknown
    getPartition: (viewId: string) => unknown
    getWebContentsId: (viewId: string) => unknown
    activateExtension: (extensionId: string) => unknown
    getExtensions: () => unknown
    loadExtension: () => unknown
    removeExtension: (extensionId: string) => unknown
    discoverBrowserExtensions: () => unknown
    importExtension: (extPath: string) => unknown
    reparentToCurrentWindow: (viewId: string) => unknown
    /** Event-shaped (`type: 'state-snapshot'`) nav state per live view — replayed
     * to each new `onEvent` subscriber so late subscribes can't miss load events. */
    getAllStateSnapshots: () => unknown[]
    events: EventEmitter & {
      on(event: 'event', listener: (e: unknown) => void): EventEmitter
      on(event: 'shortcut', listener: (payload: BrowserShortcutPayload) => void): EventEmitter
      on(event: 'focused', listener: (payload: { viewId: string }) => void): EventEmitter
      on(
        event: 'create-task-from-link',
        listener: (intent: BrowserCreateTaskFromLinkIntent) => void
      ): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }

  // Floating global agent panel — ops + the 3 streaming emitters the
  // floatingAgent subscriptions consume. Same instances back the
  // `floating-global-agent-panel:*` IPC handlers (coexistence until slice 5).
  floatingAgent: {
    setEnabled: (enabled: boolean) => unknown
    setSessionId: (sessionId: string | null) => unknown
    setPanelOpen: (isOpen: boolean) => unknown
    toggleCollapse: () => unknown
    resetSize: () => unknown
    detach: () => unknown
    reattach: () => unknown
    getState: () => FloatingAgentState
    getSession: () => unknown
    getConfig: () => unknown
    events: EventEmitter & {
      on(event: 'state', listener: (payload: FloatingAgentState) => void): EventEmitter
      on(event: 'session-changed', listener: () => void): EventEmitter
      on(event: 'collapse-changed', listener: (collapsed: boolean) => void): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }

  // Webview — CLI tab registry (P19i) + devtools (P19k) + shortcuts/emulation
  // (P19m). Same impls back the `webview:*` IPC handlers (coexistence/slice 5).
  webview: {
    registerBrowserTab: (taskId: string, tabId: string, webContentsId: number) => void
    unregisterBrowserTab: (taskId: string, tabId: string) => void
    setActiveBrowserTab: (taskId: string, tabId: string | null) => void
    closeDevTools: (webviewId: number) => unknown
    isDevToolsOpened: (webviewId: number) => unknown
    disableDeviceEmulation: (webviewId: number) => unknown
    registerShortcuts: (webviewId: number) => unknown
    setKeyboardPassthrough: (webviewId: number, enabled: boolean) => unknown
    setDesktopHandoffPolicy: (webviewId: number, policy: unknown) => unknown
    openDevToolsBottom: (webviewId: number, options?: { probe?: boolean }) => unknown
    openDevToolsDetached: (webviewId: number) => unknown
    enableDeviceEmulation: (
      webviewId: number,
      params: {
        screenSize: { width: number; height: number }
        viewSize: { width: number; height: number }
        deviceScaleFactor: number
        screenPosition: 'mobile' | 'desktop'
        userAgent?: string
      }
    ) => unknown
    events: EventEmitter & {
      on(
        event: 'shortcut',
        listener: (payload: { webviewId: number; key: string; shift: boolean }) => void
      ): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }

  // Task windows + panel ownership. Window-scoped ops take the caller's window
  // id (tRPC: ctx.windowId; IPC: event.sender.id). Same impls back the
  // `task-window:*` / `panels:*` IPC handlers (coexistence until slice 5).
  taskWindows: {
    open: (taskId: string) => unknown
    close: (taskId: string) => unknown
    list: () => string[]
    setPrimaryActive: (taskId: string | null, callerWindowId: number | null) => unknown
    getPrimaryActive: () => string | null
    claimPanel: (taskId: string, panelId: string, ownerWindowId: number) => unknown
    releasePanel: (taskId: string, panelId: string, callerWindowId: number) => unknown
    releaseAllForTask: (taskId: string, callerWindowId: number) => unknown
    getOwnership: (taskId: string) => Array<{ panelId: string; ownerWindowId: number }>
    getWindowId: (callerWindowId: number) => number | null
    claimAndCloseOther: (taskId: string, panelId: string, ownerWindowId: number) => unknown
    claimSession: (sessionId: string, callerWindowId: number) => unknown
    events: EventEmitter & {
      on(event: 'list-changed', listener: (taskIds: string[]) => void): EventEmitter
      on(event: 'primary-active-changed', listener: (taskId: string | null) => void): EventEmitter
      on(
        event: 'ownership-changed',
        listener: (payload: {
          taskId: string
          ownership: Array<{ panelId: string; ownerWindowId: number }>
        }) => void
      ): EventEmitter
      on(
        event: 'panels-released-on-close',
        listener: (payload: {
          closedWindowId: number
          released: Array<{ taskId: string; panelId: string }>
        }) => void
      ): EventEmitter
      on(
        event: 'panels-close-request',
        listener: (targetWindowId: number, payload: { taskId: string; panelId: string }) => void
      ): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }
}

let appDeps: AppDeps | null = null

export function setAppDeps(deps: AppDeps): void {
  appDeps = deps
}

export function getAppDeps(): AppDeps {
  if (!appDeps) throw new Error('appDeps not initialized — call setAppDeps() in main host first')
  return appDeps
}

// Processes deps — the long-running child-process manager. Lifecycle ops plus the
// live `processEvents` TypedEmitter the 4 streaming subscriptions wrap. Lives in
// apps/app/main (electron + child_process), injected via setProcessesDeps(); the
// same emitter also drives the legacy `win.webContents.send` IPC (dual-emit,
// coexistence until slice 5).
export type ProcessesDeps = {
  create: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  spawn: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  update: (
    processId: string,
    updates: Partial<
      Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>
    >
  ) => boolean
  stop: (processId: string) => boolean | Promise<boolean>
  kill: (processId: string) => boolean | Promise<boolean>
  restart: (processId: string) => boolean | Promise<boolean>
  listForTask: (taskId: string | null, projectId: string | null) => ProcessInfo[]
  listAll: () => ProcessInfo[]
  killTask: (taskId: string) => void
  events: TypedEmitter<ProcessEventMap>
}

let processesDeps: ProcessesDeps | null = null

export function setProcessesDeps(deps: ProcessesDeps): void {
  processesDeps = deps
}

export function getProcessesDeps(): ProcessesDeps {
  if (!processesDeps)
    throw new Error('processesDeps not initialized — call setProcessesDeps() in main host first')
  return processesDeps
}

// Runners / runner deps — the hub/runner-split surface the `runnersRouter` needs
// that transport cannot own itself: the live runner gateway (runner-WS connection
// status) plus the two values `mintJoinToken` bakes into a join token (the runner
// WS URL a runner dials + the hub TLS cert fingerprint it pins). All three are
// exposed as GETTERS, not snapshots: the gateway is built asynchronously (auth
// migrations) and the URL/fingerprint are only known after the server binds its
// port + loads its identity, so the registry must read the live refs each call.
//
// Populated once composeServer + the server host wire it (always, barring init failure); when
// the runner init failed it is not set and `getRunnersDeps()` throws — the router's
// runner-dependent procedures fail cleanly and nothing calls them (the UI is
// wave 3). The pure runner-binding mutations (setTaskRunner / … / revokeRunner)
// go straight through `ctx.db` and never touch this registry, so they work
// regardless. `getRunnersDepsOrNull()` lets `list` degrade gracefully (store rows
// with no live status) instead of throwing when the gateway isn't wired.

/** Structural slice of the runner gateway the runners router reads — connection
 *  status only. Kept structural (not the full `HubRunnerGateway`) so transport
 *  stays decoupled from `@slayzone/runner-transport`.
 *
 *  NOTE: structural mirrors of a real interface drift silently (that class of bug
 *  cost four wire-contract fixes in the runner handlers). Keep this a strict
 *  SUBSET of `HubRunnerGateway`'s member names/shapes so the real gateway is
 *  always assignable to it. */
export type RunnerGateway = {
  /** Socket-open runners. Says nothing about liveness. */
  listRunners: () => ReadonlyArray<{
    runnerId: string
    connectedAt: number
    lastSeenAt: number
  }>
  /** Runners that can actually take work now (open + inside the heartbeat window).
   *  This is what a dispatch decision should read; `listRunners` is for display. */
  listUsableRunners: () => ReadonlyArray<{
    runnerId: string
    connectedAt: number
    lastSeenAt: number
  }>
}

export type RunnersDeps = {
  /** Live runner gateway, or null until the async runner init resolves. */
  getGateway: () => RunnerGateway | null
  /** ws(s)://host:port/runners URL a join token embeds for the runner to dial.
   *  Null until the runner listener's port is bound. */
  getHubUrl: () => string | null
  /** Hub TLS leaf-cert sha256 (lowercase hex) a join token pins. Null until the
   *  hub identity has been loaded. */
  getCertFingerprint: () => string | null
}

let runnersDeps: RunnersDeps | null = null

export function setRunnersDeps(deps: RunnersDeps): void {
  runnersDeps = deps
}

export function getRunnersDeps(): RunnersDeps {
  if (!runnersDeps)
    throw new Error(
      'runnersDeps not initialized — composeServer/server host have not wired it yet'
    )
  return runnersDeps
}

/** Non-throwing read for the `list` procedure, which must still return store
 *  rows (with no live connection status) when the gateway isn't wired. */
export function getRunnersDepsOrNull(): RunnersDeps | null {
  return runnersDeps
}

/**
 * Multi-hub federation: the intrinsic identity facts a hub reports to a
 * connecting client via `hub.describe`. Both getters degrade to a safe default
 * (no identity loaded / no auth) so the `hub.describe` query works with
 * multi-hub OFF — the co-located local sidecar has no cert + no auth. Wired by
 * the server composition only when a hub identity is loaded (multi_hub/runners) or
 * auth is enforced (Phase 6). Deliberately separate from `RunnersDeps` (the
 * runner-facing `/runners` axis) — this is the client-facing `/trpc` axis.
 */
export type HubDescribeDeps = {
  /** The hub's own TLS leaf-cert sha256 (lowercase hex), or null when no hub
   *  identity is loaded (plain local mode). The client uses this to reconcile a
   *  pinned remote hub; it is ignored for the local sentinel hub. */
  getFingerprint: () => string | null
  /** Whether this hub enforces bearer auth on `/trpc` connections (Phase 6).
   *  Always false today — local is trusted loopback. */
  getAuthRequired: () => boolean
}

let hubDescribeDeps: HubDescribeDeps | null = null

export function setHubDescribeDeps(deps: HubDescribeDeps): void {
  hubDescribeDeps = deps
}

/** Non-throwing read — `hub.describe` returns sane defaults when unwired. */
export function getHubDescribeDepsOrNull(): HubDescribeDeps | null {
  return hubDescribeDeps
}

/**
 * Multi-hub auth gate. Returns whether THIS hub enforces bearer auth on tRPC
 * procedures. Default `false` (trusted loopback / non-authed remote) → the auth
 * middleware is inert, byte-identical to the pre-auth server. The hub sets a
 * real predicate (`() => hubAuthRequired`) at boot when it runs in remote mode
 * (`SLAYZONE_MODE=remote`).
 */
let authGate: () => boolean = () => false

export function setAuthGate(fn: () => boolean): void {
  authGate = fn
}

export function getAuthGate(): boolean {
  return authGate()
}
