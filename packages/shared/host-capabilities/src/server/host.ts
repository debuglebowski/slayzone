// The host capabilities the `app.*` routers of this package wrap: main-process
// (Electron) ops a server cannot perform itself. They are members of api's `AppDeps`,
// which is built from these types, so there is one contract; the side-car's capability
// bridge forwards them to the Electron host by member name. This package never imports
// `@slayzone/api`: api wires `setHostCapabilitiesDeps` at load
// (`api/src/domain-router-deps.ts`) to read its `AppDeps` registry live on every call.

import type { EventEmitter } from 'node:events'
import type { CliInstallResult } from '@slayzone/platform'
import type { TypedEmitter } from '@slayzone/platform/events'

export type ClipboardHost = {
  clipboardWriteFilePaths: (paths: string[]) => Promise<void>
  clipboardReadFilePaths: () => Promise<string[]>
  clipboardHasFiles: () => Promise<boolean>
}

export type ScreenshotHost = {
  screenshotCaptureView: (viewId: string) => Promise<{ success: boolean; path?: string }>
}

export type FilesHost = {
  filesPathExists: (filePath: string) => Promise<boolean>
  filesSaveTempImage: (
    base64: string,
    mimeType: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
}

export type ShellHost = {
  shellOpenExternal: (
    url: string,
    options?: {
      blockDesktopHandoff?: boolean
      desktopHandoff?: { protocol?: string; hostScope?: string }
    }
  ) => void
  shellOpenPath: (absPath: string) => Promise<string>
}

/** App metadata (read-only) plus the app-level actions the `app.meta` router exposes. */
export type MetaHost = {
  appGetVersion: () => string
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
}

export type WindowHost = {
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
  // window.close — closes the window owning the connection (ctx.windowId).
  // Same effect as the `window:close` IPC (which uses event.sender).
  windowClose: (windowId: number) => void
}

export type ShortcutsHost = {
  // shortcuts — rebuild the native app menu from the persisted custom-shortcut
  // overrides after the renderer writes them (was the `shortcuts:changed` IPC).
  // No-op on a headless host (no native menu).
  appRebuildMenuForShortcuts: () => void
}

export type DialogHost = {
  // dialog (native file picker — same electron dialog API backs the
  // `dialog:showOpenDialog` IPC handler; coexistence until slice 5)
  dialogShowOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>
}

export type AuthHost = {
  authGithubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) => Promise<unknown>
}

// Task windows + panel ownership. Window-scoped ops take the caller's window
// id (tRPC: ctx.windowId; IPC: event.sender.id). Same impls back the
// `task-window:*` / `panels:*` IPC handlers (coexistence until slice 5).
export type TaskWindowsHost = {
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

/** Every host capability this package's routers read: a strict subset of api's `AppDeps`. */
export type HostCapabilities = ClipboardHost &
  ScreenshotHost &
  FilesHost &
  ShellHost &
  MetaHost &
  WindowHost &
  ShortcutsHost &
  DialogHost &
  AuthHost & { taskWindows: TaskWindowsHost }

export type HostCapabilitiesDeps = {
  /** The host's capabilities, read on every call (the registry may be set late). */
  getHost: () => HostCapabilities
}

let deps: HostCapabilitiesDeps | null = null

export function setHostCapabilitiesDeps(next: HostCapabilitiesDeps): void {
  deps = next
}

/** The host, through the wired seam. Throws (like an unset `AppDeps`) when unwired. */
export function getHost(): HostCapabilities {
  if (!deps)
    throw new Error(
      'host capabilities not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps.getHost()
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
