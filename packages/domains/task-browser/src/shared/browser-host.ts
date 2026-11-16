/**
 * The CLIENT-LOCAL browser host: the process on THIS device that owns the real web
 * views (Electron main on desktop, the fork's native host in the Chromium shell).
 *
 * The browser panel drives it directly — never through the hub. The hub only stores
 * the tab list (`tasks.browser_tabs`) and relays `slay browser` to the client that
 * owns a task's panel (`./browser-relay.ts`).
 *
 * The wire is deliberately generic — `invoke(method, args)` + `on(event, cb)` — so the
 * preload stays a two-function bridge and this map is the ONE typed contract both
 * sides check against: the Electron dispatcher implements `BrowserHostMethods`, the
 * renderer's typed client (`../client/browser-host.ts`) calls it.
 *
 * Type-only and dependency-free beyond sibling shared types: part of the
 * `@slayzone/task-browser/shared` subpath, safe to import from renderer bundles.
 */
import type { DesktopHandoffPolicy } from '@slayzone/task-contracts'
import type { BrowserCreateTaskFromLinkIntent, BrowserShortcutPayload } from './browser-view-events'

export type BrowserViewKind = 'browser-tab' | 'web-panel'

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CreateBrowserViewOptions {
  taskId: string
  tabId: string
  partition?: string
  url: string
  bounds: BrowserViewBounds
  kind?: BrowserViewKind
  desktopHandoffPolicy?: DesktopHandoffPolicy | null
}

export interface BrowserViewSummary {
  viewId: string
  taskId: string
  tabId: string
  kind: BrowserViewKind
  visible: boolean
  nativelyAttached: boolean
  currentWindowId: number | null
  url: string
  partition: string
}

export interface BrowserExtensionInfo {
  id: string
  name: string
  version?: string
  icon?: string
  manifestVersion?: number
}

export interface DiscoveredBrowserExtensions {
  name: string
  extensions: {
    id: string
    name: string
    version: string
    path: string
    alreadyImported: boolean
    manifestVersion?: number
  }[]
}

export interface DeviceEmulationParams {
  screenSize: { width: number; height: number }
  viewSize: { width: number; height: number }
  deviceScaleFactor: number
  screenPosition: 'mobile' | 'desktop'
  userAgent?: string
}

export type DevToolsMode = 'bottom' | 'right' | 'undocked' | 'detach'
export type StopFindAction = 'clearSelection' | 'keepSelection' | 'activateSelection'

/** One live web-view event (`did-navigate`, `dom-ready`, `state-snapshot`, …). */
export interface BrowserViewEvent {
  viewId: string
  type: string
  [key: string]: unknown
}

/**
 * Every operation the client-local host answers. Keys are the wire method names.
 *
 * `view.*`    one WebContentsView (task browser tab or web panel), by view id.
 * `webview.*` a DOM `<webview>` (multi-device emulation slots), by webContents id.
 * `tabs.*`    the (taskId, tabId) → live tab registry. The `slay browser` relay runs
 *             its operations against THIS registry, on the client that owns the tab.
 */
export interface BrowserHostMethods {
  'view.create': (opts: CreateBrowserViewOptions) => string | null
  'view.destroy': (viewId: string) => void
  'view.destroyAllForTask': (taskId: string) => void
  'view.reparentToCurrentWindow': (viewId: string) => { ok: boolean }
  'view.setBounds': (viewId: string, bounds: BrowserViewBounds) => void
  'view.setVisible': (viewId: string, visible: boolean) => void
  /** Agent lock: drop OS-origin input while keeping the view rendering. */
  'view.setLocked': (viewId: string, locked: boolean) => void
  'view.hideAll': () => void
  'view.showAll': () => void
  'view.setHandoffPolicy': (viewId: string, policy: DesktopHandoffPolicy | null) => void
  'view.navigate': (viewId: string, url: string) => void
  'view.goBack': (viewId: string) => void
  'view.goForward': (viewId: string) => void
  'view.reload': (viewId: string, ignoreCache?: boolean) => void
  'view.stop': (viewId: string) => void
  'view.executeJs': (viewId: string, code: string) => unknown
  'view.insertCss': (viewId: string, css: string) => string
  'view.removeCss': (viewId: string, key: string) => void
  'view.setForcedTheme': (viewId: string, theme: 'light' | 'dark' | null) => void
  'view.setZoom': (viewId: string, factor: number) => void
  'view.focus': (viewId: string) => void
  'view.findInPage': (
    viewId: string,
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
  ) => number | null
  'view.stopFindInPage': (viewId: string, action: StopFindAction) => void
  'view.setKeyboardPassthrough': (viewId: string, enabled: boolean) => void
  'view.sendInputEvent': (
    viewId: string,
    input: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }
  ) => void
  'view.openDevTools': (viewId: string, mode: DevToolsMode) => void
  'view.closeDevTools': (viewId: string) => void
  'view.isDevToolsOpen': (viewId: string) => boolean
  'view.getWebContentsId': (viewId: string) => number | null
  'view.list': () => BrowserViewSummary[]
  /** Capture the view to a PNG in this device's temp dir (the panel's camera button). */
  'view.captureToTempFile': (viewId: string) => { success: boolean; path?: string }
  /** One `state-snapshot` event per live view — what a new `event` listener replays
   *  first, so a listener attaching after a view loaded cannot miss its load. */
  'view.stateSnapshots': () => BrowserViewEvent[]

  'extensions.list': () => BrowserExtensionInfo[]
  'extensions.load': () => { id: string; name: string } | { error: string } | null
  'extensions.remove': (extensionId: string) => void
  'extensions.discover': () => DiscoveredBrowserExtensions[]
  'extensions.import': (path: string) => { id: string; name: string } | { error: string }
  'extensions.activate': (extensionId: string) => boolean

  'webview.registerShortcuts': (webContentsId: number) => void
  'webview.setKeyboardPassthrough': (webContentsId: number, enabled: boolean) => void
  'webview.setDesktopHandoffPolicy': (
    webContentsId: number,
    policy: DesktopHandoffPolicy | null
  ) => boolean
  /** `true`/`false`, or with `probe` a diagnostic report of each docking attempt. */
  'webview.openDevToolsBottom': (
    webContentsId: number,
    options?: { probe?: boolean }
  ) => boolean | { ok: boolean; [key: string]: unknown }
  'webview.openDevToolsDetached': (webContentsId: number) => boolean
  'webview.closeDevTools': (webContentsId: number) => boolean
  'webview.isDevToolsOpened': (webContentsId: number) => boolean
  'webview.enableDeviceEmulation': (webContentsId: number, params: DeviceEmulationParams) => boolean
  'webview.disableDeviceEmulation': (webContentsId: number) => boolean

  'tabs.register': (taskId: string, tabId: string, webContentsId: number) => void
  'tabs.unregister': (taskId: string, tabId: string) => void
  'tabs.setActive': (taskId: string, tabId: string | null) => void
  /** Runs in the tab's main frame. `tabId` null = the task's active tab. */
  'tabs.execJs': (taskId: string, tabId: string | null, code: string) => unknown
  'tabs.loadUrl': (taskId: string, tabId: string | null, url: string) => void
  'tabs.getUrl': (taskId: string, tabId: string | null) => string | null
  /** PNG bytes of the visible page; null when the capture came back empty. */
  'tabs.capturePng': (taskId: string, tabId: string | null) => Uint8Array | null
}

export type BrowserHostMethod = keyof BrowserHostMethods

/** Events the host pushes to the renderer. */
export interface BrowserHostEvents {
  /** Nav/load events per view. A new listener first gets one `state-snapshot` per
   *  live view (`view.stateSnapshots`), so it cannot miss did-navigate/dom-ready. */
  event: BrowserViewEvent
  shortcut: BrowserShortcutPayload
  focused: { viewId: string }
  'create-task-from-link': BrowserCreateTaskFromLinkIntent
  /** Genuine user input in a task's view (throttled) — the hub's idle-close clock. */
  engaged: { taskId: string }
  /** A shortcut pressed inside a DOM `<webview>` (multi-device slot). */
  'webview-shortcut': { webviewId: number; key: string; shift: boolean }
}

export type BrowserHostEvent = keyof BrowserHostEvents

/** Every method name, for the host-side dispatcher's allowlist. */
export const BROWSER_HOST_METHODS = [
  'view.create',
  'view.destroy',
  'view.destroyAllForTask',
  'view.reparentToCurrentWindow',
  'view.setBounds',
  'view.setVisible',
  'view.setLocked',
  'view.hideAll',
  'view.showAll',
  'view.setHandoffPolicy',
  'view.navigate',
  'view.goBack',
  'view.goForward',
  'view.reload',
  'view.stop',
  'view.executeJs',
  'view.insertCss',
  'view.removeCss',
  'view.setForcedTheme',
  'view.setZoom',
  'view.focus',
  'view.findInPage',
  'view.stopFindInPage',
  'view.setKeyboardPassthrough',
  'view.sendInputEvent',
  'view.openDevTools',
  'view.closeDevTools',
  'view.isDevToolsOpen',
  'view.getWebContentsId',
  'view.list',
  'view.captureToTempFile',
  'view.stateSnapshots',
  'extensions.list',
  'extensions.load',
  'extensions.remove',
  'extensions.discover',
  'extensions.import',
  'extensions.activate',
  'webview.registerShortcuts',
  'webview.setKeyboardPassthrough',
  'webview.setDesktopHandoffPolicy',
  'webview.openDevToolsBottom',
  'webview.openDevToolsDetached',
  'webview.closeDevTools',
  'webview.isDevToolsOpened',
  'webview.enableDeviceEmulation',
  'webview.disableDeviceEmulation',
  'tabs.register',
  'tabs.unregister',
  'tabs.setActive',
  'tabs.execJs',
  'tabs.loadUrl',
  'tabs.getUrl',
  'tabs.capturePng'
] as const satisfies readonly BrowserHostMethod[]

// Compile-time completeness: every BrowserHostMethods key is in the allowlist.
type _MissingMethods = Exclude<BrowserHostMethod, (typeof BROWSER_HOST_METHODS)[number]>
const _allMethodsListed: _MissingMethods extends never ? true : _MissingMethods = true
void _allMethodsListed
