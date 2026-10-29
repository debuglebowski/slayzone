// What the `app.browser` / `app.webview` routers need from their host: the Electron
// browser-view manager and the webview registry. Members of api's `AppDeps` (built
// from these types, so there is one contract; the side-car's capability bridge
// forwards them to the host by member name). api wires this seam at load to read its
// registry live on every call (`api/src/domain-router-deps.ts`). This domain never
// imports `@slayzone/api`.
import type { EventEmitter } from 'node:events'
import type { BrowserShortcutPayload, BrowserCreateTaskFromLinkIntent } from '../shared'

// Browser view manager — heavy electron coupling, expose as opaque object
// and call methods directly from procedures. All return types are unknown
// since the manager's public surface evolves; callers cast on the renderer.
export type BrowserViewHost = {
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
  setForcedTheme: (viewId: string, theme: 'light' | 'dark' | null) => unknown
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
  /** One view's `state-snapshot` (null once the view is gone). The desktop
   * bridge stamps it onto every relayed browser event, so the side-car's
   * replay cache moves in lockstep with the events it relays. */
  getStateSnapshot: (viewId: string) => unknown
  events: EventEmitter & {
    on(event: 'event', listener: (e: unknown) => void): EventEmitter
    on(event: 'shortcut', listener: (payload: BrowserShortcutPayload) => void): EventEmitter
    on(event: 'focused', listener: (payload: { viewId: string }) => void): EventEmitter
    /** Genuine user input in a task's browser view (focus / key / click / wheel,
     *  throttled) — feeds the idle-close "user engaged" clock in the hub. */
    on(event: 'engaged', listener: (payload: { taskId: string }) => void): EventEmitter
    on(
      event: 'create-task-from-link',
      listener: (intent: BrowserCreateTaskFromLinkIntent) => void
    ): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
}

// Webview — CLI tab registry (P19i) + devtools (P19k) + shortcuts/emulation
// (P19m). Same impls back the `webview:*` IPC handlers (coexistence/slice 5).
export type WebviewHost = {
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

export type TaskBrowserHost = { browser: BrowserViewHost; webview: WebviewHost }

export type TaskBrowserRouterDeps = {
  /** The host, read on every call (the registry may be set late). */
  getHost: () => TaskBrowserHost
}

let deps: TaskBrowserRouterDeps | null = null

export function setTaskBrowserRouterDeps(next: TaskBrowserRouterDeps): void {
  deps = next
}

export function getTaskBrowserHost(): TaskBrowserHost {
  if (!deps)
    throw new Error(
      'task-browser router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps.getHost()
}
