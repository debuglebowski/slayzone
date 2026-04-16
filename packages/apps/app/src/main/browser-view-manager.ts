import { clipboard, Menu, shell, WebContentsView, session, type BrowserWindow } from 'electron'
import { join } from 'path'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import type { BrowserCreateTaskFromLinkIntent } from '@slayzone/types'
import type { DesktopHandoffPolicy } from '@slayzone/task/shared'
import { WEBVIEW_DESKTOP_HANDOFF_SCRIPT } from '../shared/webview-desktop-handoff-script'
import {
  buildBrowserLinkContextMenuItems,
  normalizeBrowserLinkContextMenuInput,
  type BrowserLinkContextMenuAction,
} from './browser-link-context-menu'
import {
  BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY,
  BROWSER_CREATE_TASK_FROM_LINK_INSTALLED_KEY,
  buildBrowserCreateTaskFromLinkCaptureScript,
} from '../shared/browser-link-task-capture-script'

/** Cmd+key combos that always pass through to the webpage (clipboard, undo, scroll). */
const BROWSER_DEFAULT_PASSTHROUGH = new Set([
  'c', 'v', 'x', 'a', 'z',    // clipboard + undo
  'arrowup', 'arrowdown',       // scroll to top/bottom
])

// Ensure the modified-link capture listener exists on every document swap.
const MODIFIED_LINK_CAPTURE_SCRIPT = buildBrowserCreateTaskFromLinkCaptureScript(
  BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY,
  BROWSER_CREATE_TASK_FROM_LINK_INSTALLED_KEY
)

export type ViewKind = 'browser-tab' | 'web-panel'

export interface CreateViewOpts {
  taskId: string
  tabId: string
  partition?: string
  url: string
  bounds: ViewBounds
  kind?: ViewKind
  desktopHandoffPolicy?: DesktopHandoffPolicy | null
}

export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ViewEntry {
  view: WebContentsView
  taskId: string
  tabId: string
  partition: string
  bounds: ViewBounds
  visible: boolean
  lastBounds: ViewBounds | null
  lastUsed: number
  isMultiDevice: boolean
  keyboardPassthrough: boolean
  kind: ViewKind
  desktopHandoffPolicy: DesktopHandoffPolicy | null
}

interface BrowserViewEvent {
  viewId: string
  type: string
  [key: string]: unknown
}

interface BrowserCreateTaskFromLinkPayload {
  url: string
  linkText?: string
  source: BrowserCreateTaskFromLinkIntent['source']
}

interface MouseDownInputLike {
  type: 'mouseDown'
  button?: string
  x?: number
  y?: number
  alt?: boolean
  shift?: boolean
  meta?: boolean
  control?: boolean
}

function getModifiedClickPoint(input: Electron.Input): { x: number; y: number } | null {
  if (input.type !== 'mouseDown') return null
  const mouseInput = input as Electron.Input & MouseDownInputLike
  if (mouseInput.button !== 'left') return null
  if (!mouseInput.alt || !mouseInput.shift || mouseInput.meta || mouseInput.control) return null

  const x = typeof mouseInput.x === 'number' ? mouseInput.x : NaN
  const y = typeof mouseInput.y === 'number' ? mouseInput.y : NaN
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null

  return { x, y }
}

const MAX_SINGLE_DEVICE_VIEWS_PER_TASK = 6

let viewCounter = 0

export class BrowserViewManager {
  private views = new Map<string, ViewEntry>()
  private mainWindow: BrowserWindow | null = null
  private allHidden = false
  private chromeExtensions: ElectronChromeExtensions | null = null
  private lastCreateTaskFromLinkSignature = ''
  private lastCreateTaskFromLinkAt = 0
  private onHandoffPolicyChange: ((wcId: number, policy: DesktopHandoffPolicy | null) => void) | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  setChromeExtensions(ext: ElectronChromeExtensions) {
    this.chromeExtensions = ext
  }

  setHandoffPolicyChangeCallback(cb: (wcId: number, policy: DesktopHandoffPolicy | null) => void) {
    this.onHandoffPolicyChange = cb
  }

  setHandoffPolicy(viewId: string, policy: DesktopHandoffPolicy | null): void {
    const entry = this.views.get(viewId)
    if (!entry) return
    entry.desktopHandoffPolicy = policy
    if (!entry.view.webContents.isDestroyed()) {
      this.onHandoffPolicyChange?.(entry.view.webContents.id, policy)
    }
  }

  createView(opts: CreateViewOpts): string | null {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) {
      console.warn('[browser-view-manager] createView: mainWindow not ready')
      return null
    }

    const viewId = `bv-${++viewCounter}`
    const partition = opts.partition || 'persist:browser-tabs'
    const kind: ViewKind = opts.kind ?? 'browser-tab'

    // LRU eviction: enforce cap for single-device views (skip web-panel kind)
    if (kind !== 'web-panel') {
      this.evictIfNeeded(opts.taskId)
    }

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: session.fromPartition(partition),
        preload: join(__dirname, '../preload/browser-chrome-preload.js'),
      },
    })

    const initialPolicy = opts.desktopHandoffPolicy ?? null
    const entry: ViewEntry = {
      view,
      taskId: opts.taskId,
      tabId: opts.tabId,
      partition,
      bounds: opts.bounds,
      visible: true,
      lastBounds: null,
      lastUsed: Date.now(),
      isMultiDevice: false,
      keyboardPassthrough: false,
      kind,
      desktopHandoffPolicy: initialPolicy,
    }

    this.views.set(viewId, entry)

    // Always add to window first so the view is properly initialized
    win.contentView.addChildView(view)
    view.setBounds(this.normalizeViewBounds(opts.bounds))

    if (this.allHidden) {
      // Dialog overlay is active — hide immediately, will restore via showAll
      entry.lastBounds = opts.bounds
      this.removeFromWindow(entry)
    }

    this.attachEventListeners(viewId, view)
    this.applySpoofing(view.webContents, entry)

    // Register tab with Chrome extension system (browser tabs only)
    if (kind !== 'web-panel' && this.chromeExtensions && win) {
      this.chromeExtensions.addTab(view.webContents, win)
      this.chromeExtensions.selectTab(view.webContents)
    }

    // Mirror initial handoff policy so main-process hardening listeners see it immediately
    if (initialPolicy) {
      this.onHandoffPolicyChange?.(view.webContents.id, initialPolicy)
    }

    if (opts.url && opts.url !== 'about:blank') {
      view.webContents.loadURL(opts.url.replace(/^file:\/\//, 'slz-file://'))
    }

    return viewId
  }

  destroyView(viewId: string): void {
    const entry = this.views.get(viewId)
    if (!entry) return

    // Unregister from Chrome extension system before destroying (browser tabs only)
    if (entry.kind !== 'web-panel' && this.chromeExtensions && !entry.view.webContents.isDestroyed()) {
      this.chromeExtensions.removeTab(entry.view.webContents)
    }

    // Clear handoff policy mirror
    if (!entry.view.webContents.isDestroyed()) {
      this.onHandoffPolicyChange?.(entry.view.webContents.id, null)
    }

    this.views.delete(viewId)
    this.removeFromWindow(entry)

    // Restore focus to main renderer after removing native view
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.focus()
    }

    if (!entry.view.webContents.isDestroyed()) {
      // Bypass beforeunload handlers that could prevent closing
      entry.view.webContents.on('will-prevent-unload', (e) => e.preventDefault())
      entry.view.webContents.close()
      // Fallback: if close() didn't kill it within 1s, force-crash the renderer
      const wc = entry.view.webContents
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.forcefullyCrashRenderer()
      }, 1000)
    }
  }

  destroyAllForTask(taskId: string): void {
    for (const [viewId, entry] of this.views) {
      if (entry.taskId === taskId) {
        this.destroyView(viewId)
      }
    }
  }

  setBounds(viewId: string, bounds: ViewBounds): void {
    const entry = this.views.get(viewId)
    if (!entry) return

    entry.bounds = bounds
    if (entry.visible && !this.allHidden) {
      entry.view.setBounds(this.normalizeViewBounds(bounds))
    } else {
      entry.lastBounds = bounds
    }
  }

  setVisible(viewId: string, visible: boolean): void {
    const entry = this.views.get(viewId)
    if (!entry) return

    entry.visible = visible
    if (visible) {
      entry.lastUsed = Date.now()
      // Notify extension system of active tab change (browser tabs only)
      if (entry.kind !== 'web-panel' && this.chromeExtensions) {
        this.chromeExtensions.selectTab(entry.view.webContents)
      }
    }

    if (this.allHidden) {
      // Store bounds for restoration when overlay closes
      if (visible) entry.lastBounds = entry.bounds
      // Don't add to window while allHidden
      this.removeFromWindow(entry)
      return
    }

    if (visible) {
      this.addToWindow(entry)
      entry.view.setBounds(this.normalizeViewBounds(entry.bounds))
    } else {
      this.removeFromWindow(entry)
    }
  }

  hideAll(): void {
    if (this.allHidden) return
    this.allHidden = true

    let hidden = 0
    for (const entry of this.views.values()) {
      // Remove ALL views from window, not just visible ones — a view might have been
      // re-added by setVisible(true) between the dialog's render and this hideAll call
      if (!entry.lastBounds) entry.lastBounds = entry.bounds
      this.removeFromWindow(entry)
      hidden++
    }

    // Restore focus to renderer so dialogs can receive keyboard input
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.focus()
    }
  }

  showAll(): void {
    if (!this.allHidden) return
    this.allHidden = false

    for (const entry of this.views.values()) {
      if (entry.visible && entry.lastBounds) {
        this.addToWindow(entry)
        entry.view.setBounds(this.normalizeViewBounds(entry.lastBounds))
        entry.lastBounds = null
      }
    }
  }

  navigate(viewId: string, url: string): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.loadURL(url.replace(/^file:\/\//, 'slz-file://'))
  }

  goBack(viewId: string): void {
    this.getWebContents(viewId)?.navigationHistory.goBack()
  }

  goForward(viewId: string): void {
    this.getWebContents(viewId)?.navigationHistory.goForward()
  }

  reload(viewId: string, ignoreCache?: boolean): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    if (ignoreCache) {
      wc.reloadIgnoringCache()
    } else {
      wc.reload()
    }
  }

  stop(viewId: string): void {
    this.getWebContents(viewId)?.stop()
  }

  async executeJs(viewId: string, code: string): Promise<unknown> {
    const wc = this.getWebContents(viewId)
    if (!wc || !wc.mainFrame) return undefined
    return wc.mainFrame.executeJavaScript(code, true)
  }

  async insertCss(viewId: string, css: string): Promise<string> {
    const wc = this.getWebContents(viewId)
    if (!wc) return ''
    return wc.insertCSS(css)
  }

  async removeCss(viewId: string, key: string): Promise<void> {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    await wc.removeInsertedCSS(key)
  }

  setZoom(viewId: string, factor: number): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.setZoomFactor(factor)
  }

  focus(viewId: string): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.focus()
  }

  findInPage(viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number | null {
    const wc = this.getWebContents(viewId)
    if (!wc) return null
    return wc.findInPage(text, options)
  }

  stopFindInPage(viewId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.stopFindInPage(action)
  }

  setKeyboardPassthrough(viewId: string, enabled: boolean): void {
    const entry = this.views.get(viewId)
    if (entry) entry.keyboardPassthrough = enabled
  }

  sendInputEvent(viewId: string, input: Electron.KeyboardInputEvent): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.sendInputEvent(input)
  }

  openDevTools(viewId: string, mode: 'bottom' | 'right' | 'undocked' | 'detach'): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.openDevTools({ mode })
  }

  closeDevTools(viewId: string): void {
    const wc = this.getWebContents(viewId)
    if (!wc) return
    wc.closeDevTools()
  }

  isDevToolsOpen(viewId: string): boolean {
    const wc = this.getWebContents(viewId)
    return wc?.isDevToolsOpened() ?? false
  }

  // --- Test-only methods (registered when PLAYWRIGHT) ---

  getUrl(viewId: string): string {
    const wc = this.getWebContents(viewId)
    return wc?.getURL() ?? ''
  }

  getBounds(viewId: string): ViewBounds | null {
    const entry = this.views.get(viewId)
    return entry?.bounds ?? null
  }

  getAllViewIds(): string[] {
    return [...this.views.keys()]
  }

  getViewsForTask(taskId: string): string[] {
    const ids: string[] = []
    for (const [viewId, entry] of this.views) {
      if (entry.taskId === taskId) ids.push(viewId)
    }
    return ids
  }

  isFocused(viewId: string): boolean {
    const wc = this.getWebContents(viewId)
    return wc?.isFocused() ?? false
  }

  /** Reset all state — destroy all views and clear allHidden flag. */
  reset(): void {
    for (const viewId of [...this.views.keys()]) {
      this.destroyView(viewId)
    }
    this.allHidden = false
  }

  /** Returns the webContents of the most recently used visible view. */
  getActiveWebContents(): Electron.WebContents | null {
    let best: ViewEntry | null = null
    for (const entry of this.views.values()) {
      if (!entry.visible || entry.view.webContents.isDestroyed()) continue
      if (!best || entry.lastUsed > best.lastUsed) best = entry
    }
    return best?.view.webContents ?? null
  }

  /** Returns the ACTUAL native view bounds (what Electron is rendering), not the bookkeeping bounds. */
  getActualNativeBounds(viewId: string): ViewBounds | null {
    const entry = this.views.get(viewId)
    if (!entry) return null
    return entry.view.getBounds()
  }

  isAllHidden(): boolean {
    return this.allHidden
  }

  getViewVisible(viewId: string): boolean {
    return this.views.get(viewId)?.visible ?? false
  }

  /** Returns the number of WebContentsView children on the main window — the REAL native state. */
  getNativeChildViewCount(): number {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return 0
    return this.mainWindow.contentView.children.length
  }

  isViewNativelyVisible(viewId: string): boolean {
    const entry = this.views.get(viewId)
    if (!entry) return false
    // entry.visible = logical state (tab active). allHidden = dialog overlay.
    // The native view is shown only when both conditions allow it.
    return entry.visible && !this.allHidden
  }

  getPartition(viewId: string): string | null {
    return this.views.get(viewId)?.partition ?? null
  }

  getWebContentsId(viewId: string): number | null {
    const wc = this.getWebContents(viewId)
    return wc?.id ?? null
  }

  getKind(viewId: string): ViewKind | null {
    return this.views.get(viewId)?.kind ?? null
  }

  getZoomFactor(viewId: string): number | null {
    const wc = this.getWebContents(viewId)
    return wc?.zoomFactor ?? null
  }

  async dispatchMouseClick(
    viewId: string,
    point: { x: number; y: number },
    modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = []
  ): Promise<boolean> {
    const wc = this.getWebContents(viewId)
    if (!wc) return false

    wc.focus()
    const modifierMask = modifiers.reduce((mask, modifier) => {
      switch (modifier) {
        case 'alt':
          return mask | 1
        case 'control':
          return mask | 2
        case 'meta':
          return mask | 4
        case 'shift':
          return mask | 8
      }
    }, 0)

    const attachedHere = !wc.debugger.isAttached()
    try {
      if (attachedHere) wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        modifiers: modifierMask,
      })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
        modifiers: modifierMask,
      })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
        modifiers: modifierMask,
      })
      return true
    } finally {
      if (attachedHere && wc.debugger.isAttached()) wc.debugger.detach()
    }
  }

  emitCreateTaskFromLinkForWebContents(webContentsId: number, payload: BrowserCreateTaskFromLinkPayload): boolean {
    for (const [viewId, entry] of this.views) {
      if (entry.view.webContents.id !== webContentsId) continue
      return this.emitCreateTaskFromLinkForView(viewId, payload)
    }

    return false
  }

  emitCreateTaskFromLinkForView(viewId: string, payload: BrowserCreateTaskFromLinkPayload): boolean {
    const entry = this.views.get(viewId)
    if (!entry || !this.mainWindow || this.mainWindow.isDestroyed()) return false

    const signature = `${viewId}::${payload.url}::${payload.linkText ?? ''}`
    const now = Date.now()
    if (signature === this.lastCreateTaskFromLinkSignature && now - this.lastCreateTaskFromLinkAt < 300) {
      return false
    }
    this.lastCreateTaskFromLinkSignature = signature
    this.lastCreateTaskFromLinkAt = now

    const intent: BrowserCreateTaskFromLinkIntent = {
      viewId,
      taskId: entry.taskId,
      url: payload.url,
      linkText: payload.linkText,
      source: payload.source,
    }

    this.mainWindow.webContents.send('browser:create-task-from-link', intent)
    return true
  }

  runLinkContextMenuAction(
    viewId: string,
    input: { linkURL: string; linkText: string },
    action: BrowserLinkContextMenuAction
  ): boolean {
    const entry = this.views.get(viewId)
    if (!entry) return false

    const normalizedInput = normalizeBrowserLinkContextMenuInput(input)
    const items = buildBrowserLinkContextMenuItems(normalizedInput)
    if (!items.some((item) => item.action === action)) return false

    switch (action) {
      case 'create-task-from-link':
        return this.emitCreateTaskFromLinkForView(viewId, {
          url: normalizedInput.linkURL,
          linkText: normalizedInput.linkText || undefined,
          source: 'link-context-menu',
        })
      case 'open-link-in-new-tab':
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false
        this.mainWindow.webContents.send('browser:event', {
          viewId,
          type: 'new-tab-request',
          url: normalizedInput.linkURL,
          background: false,
          taskId: entry.taskId,
        })
        return true
      case 'copy-link':
        clipboard.writeText(normalizedInput.linkURL)
        return true
      case 'open-link-externally':
        void shell.openExternal(normalizedInput.linkURL)
        return true
    }
  }

  private async emitCreateTaskFromLinkAtPoint(
    viewId: string,
    point: { x: number; y: number }
  ): Promise<void> {
    const wc = this.getWebContents(viewId)
    if (!wc || !wc.mainFrame) return

    const payload = await wc.mainFrame.executeJavaScript(`
      (() => {
        const element = document.elementFromPoint(${point.x}, ${point.y})
        if (!element || typeof element.closest !== 'function') return null
        const anchor = element.closest('a[href]')
        if (!anchor) return null

        const href = (typeof anchor.href === 'string' ? anchor.href : anchor.getAttribute('href') || '').trim()
        if (!/^https?:\\/\\//i.test(href)) return null

        const linkTextRaw =
          typeof anchor.innerText === 'string' && anchor.innerText.trim()
            ? anchor.innerText
            : anchor.textContent || anchor.getAttribute('aria-label') || ''
        const linkText = linkTextRaw.replace(/\\s+/g, ' ').trim()

        return {
          url: href,
          linkText: linkText || undefined,
        }
      })()
    `, true).catch(() => null)

    if (!payload || typeof payload !== 'object') return
    const url = 'url' in payload && typeof payload.url === 'string' ? payload.url : ''
    if (!/^https?:\/\//i.test(url)) return
    const linkText = 'linkText' in payload && typeof payload.linkText === 'string'
      ? payload.linkText
      : undefined

    this.emitCreateTaskFromLinkForView(viewId, {
      url,
      linkText,
      source: 'modified-link-click',
    })
  }

  // --- Internal ---

  private applySpoofing(wc: Electron.WebContents, entry: ViewEntry): void {
    // chrome.csi and chrome.loadTimes are Chrome-specific APIs that BotGuard checks.
    // The electron-chrome-extensions library provides real chrome.runtime but not these.
    const CSI_LOADTIMES_SCRIPT = `(function() {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.csi) {
        window.chrome.csi = function() { return { startE: Date.now(), onloadT: 0, pageT: performance.now(), tran: 15 }; };
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = function() { return {
          commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
          finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0,
          navigationType: 'Other', npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.16, startLoadTime: Date.now() / 1000 - 0.16,
          wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        }; };
      }
    })();`

    const inject = (url?: string) => {
      if (!wc.mainFrame) return
      // Inject chrome.csi/loadTimes on all pages (lightweight, no Object.defineProperty)
      wc.mainFrame.executeJavaScript(CSI_LOADTIMES_SCRIPT).catch(() => {})
      // Inject full desktop handoff hardening only when a policy is set (web panels with handoff)
      if (!entry.desktopHandoffPolicy) return
      try {
        if (url && new URL(url).hostname.endsWith('.google.com')) return
      } catch { /* invalid URL — inject */ }
      wc.mainFrame.executeJavaScript(WEBVIEW_DESKTOP_HANDOFF_SCRIPT).catch(() => {})
    }
    wc.on('did-navigate', (_event, url) => inject(url))
  }

  private getWebContents(viewId: string): Electron.WebContents | null {
    const entry = this.views.get(viewId)
    if (!entry || entry.view.webContents.isDestroyed()) return null
    return entry.view.webContents
  }

  private addToWindow(entry: ViewEntry): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    try {
      // addChildView is a no-op if already a child (just reorders to top)
      win.contentView.addChildView(entry.view)
    } catch { /* view may be destroyed */ }
  }

  private removeFromWindow(entry: ViewEntry): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    try {
      win.contentView.removeChildView(entry.view)
    } catch { /* view may already be removed */ }
  }

  private normalizeViewBounds(bounds: ViewBounds): Electron.Rectangle {
    return {
      x: Math.max(0, Math.floor(bounds.x)),
      y: Math.max(0, Math.floor(bounds.y)),
      width: Math.max(1, Math.floor(bounds.width)),
      height: Math.max(1, Math.floor(bounds.height)),
    }
  }

  private evictIfNeeded(taskId: string): void {
    const taskViews: { viewId: string; entry: ViewEntry }[] = []
    for (const [viewId, entry] of this.views) {
      if (entry.taskId === taskId && !entry.isMultiDevice && entry.kind !== 'web-panel') {
        taskViews.push({ viewId, entry })
      }
    }

    if (taskViews.length < MAX_SINGLE_DEVICE_VIEWS_PER_TASK) return

    // Find LRU invisible view
    let oldest: { viewId: string; entry: ViewEntry } | null = null
    for (const tv of taskViews) {
      if (tv.entry.visible) continue
      if (!oldest || tv.entry.lastUsed < oldest.entry.lastUsed) {
        oldest = tv
      }
    }

    if (oldest) {
      this.destroyView(oldest.viewId)
    }
  }

  private attachEventListeners(viewId: string, view: WebContentsView): void {
    const wc = view.webContents
    const entry = this.views.get(viewId)!
    const send = (event: BrowserViewEvent) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('browser:event', event)
      }
    }

    if (entry.kind === 'web-panel') {
      // Web panels: allow real popup windows (OAuth flows need BrowserWindow on
      // the same session so auth cookies propagate back). Route other popups
      // through renderer for handoff-aware routing.
      wc.setWindowOpenHandler((details) => {
        // Real popup windows (window.open with features) — always allow for OAuth.
        // The popup inherits the WCV's session, so cookies flow back.
        if (details.disposition === 'new-window' && /^https?:\/\//i.test(details.url)) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
        }
        // Link clicks and other dispositions — emit event for renderer routing
        if (/^https?:\/\//i.test(details.url)) {
          send({ viewId, type: 'web-panel:popup-request', url: details.url, disposition: details.disposition })
        }
        return { action: 'deny' }
      })
    } else {
      // Browser tabs: Cmd+Click → new-tab-request, window.open() with features → allow popup
      wc.setWindowOpenHandler((details) => {
        if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
          if (/^https?:\/\//i.test(details.url)) {
            send({
              viewId,
              type: 'new-tab-request',
              url: details.url,
              background: details.disposition === 'background-tab',
              taskId: entry.taskId,
            })
          }
          return { action: 'deny' }
        }
        if (details.disposition === 'new-window' && details.features && /^https?:\/\//i.test(details.url)) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
        }
        return { action: 'deny' }
      })
    }

    // Track child popup windows (OAuth) for cleanup when view is destroyed
    const childWindows = new Set<Electron.BrowserWindow>()
    wc.on('did-create-window', (childWindow) => {
      childWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      childWindows.add(childWindow)
      childWindow.on('closed', () => childWindows.delete(childWindow))
    })
    wc.once('destroyed', () => {
      for (const w of childWindows) {
        if (!w.isDestroyed()) w.close()
      }
      childWindows.clear()
    })

    // Intercept keyboard shortcuts before the page gets them.
    // When passthrough is OFF (default), Cmd/Ctrl shortcuts are forwarded to
    // the main renderer as synthetic KeyboardEvents so app shortcuts (Cmd+B, etc.) work.
    // Keys that the main process handles directly (Cmd+R, Cmd+,, etc.) are sent as
    // the same IPC the main process handler would emit.
    // Modified-link task creation intentionally has two paths:
    // 1. page-side capture via injected script/bridge for real browser behavior
    // 2. main-process fallback here for Electron input cases where page capture is flaky
    // Keep both unless the e2e coverage proves one path is redundant across platforms.
    wc.on('before-input-event', (e, input) => {
      const modifiedClickPoint = getModifiedClickPoint(input)
      if (modifiedClickPoint) {
        e.preventDefault()
        void this.emitCreateTaskFromLinkAtPoint(viewId, modifiedClickPoint)
        return
      }

      if (entry.keyboardPassthrough) return
      if (input.type !== 'keyDown') return
      if (!(input.control || input.meta)) return

      const key = input.key.toLowerCase()

      // Let native edit shortcuts (copy, paste, cut, select-all, undo, redo)
      // pass through to the webpage so clipboard/edit operations work.
      if (BROWSER_DEFAULT_PASSTHROUGH.has(key) && input.meta && !input.alt) return

      const win = this.mainWindow
      if (!win || win.isDestroyed()) return

      e.preventDefault()

      // Cmd+R: reload THIS browser view directly
      if (key === 'r' && input.meta && !input.shift && !input.alt) {
        wc.reload()
        return
      }
      // Cmd+Shift+R: reload the app (renderer)
      if (key === 'r' && input.meta && input.shift && !input.alt) {
        win.webContents.send('app:reload-app')
        return
      }
      if (key === ',' && input.meta && input.shift) {
        win.webContents.send('app:open-project-settings')
        return
      }
      if (key === ',' && input.meta) {
        win.webContents.send('app:open-settings')
        return
      }
      if (key === 's' && input.meta && input.shift) {
        win.webContents.send('app:screenshot-trigger')
        return
      }
      if (input.key === '§' && input.meta) {
        win.webContents.send('app:go-home')
        return
      }

      // All other Cmd/Ctrl shortcuts — forward to renderer as synthetic KeyboardEvent.
      // Web panels forward shortcuts too so app-level hotkeys (Cmd+B, etc.) still work,
      // but the renderer's shortcut handler must not create browser tabs from web-panel views.
      win.webContents.send('browser-view:shortcut', {
        viewId,
        key: input.key,
        shift: Boolean(input.shift),
        alt: Boolean(input.alt),
        meta: Boolean(input.meta),
        control: Boolean(input.control),
        kind: entry.kind,
      })
    })

    // Notify renderer when WebContentsView gains focus so it can
    // show the glow and update focus tracking (focusin never fires
    // in the renderer DOM when a separate web contents has focus).
    wc.on('focus', () => {
      const win = this.mainWindow
      if (!win || win.isDestroyed()) return
      win.webContents.send('browser-view:focused', { viewId })
    })

    wc.on('did-navigate', (_e, url) => {
      send({
        viewId,
        type: 'did-navigate',
        url: url.replace(/^slz-file:\/\//, 'file://'),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      })
    })

    wc.on('did-navigate-in-page', (_e, url) => {
      send({
        viewId,
        type: 'did-navigate',
        url: url.replace(/^slz-file:\/\//, 'file://'),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      })
    })

    wc.on('did-start-loading', () => {
      send({ viewId, type: 'did-start-loading' })
    })

    wc.on('did-stop-loading', () => {
      send({ viewId, type: 'did-stop-loading' })
    })

    wc.on('page-title-updated', (_e, title) => {
      send({ viewId, type: 'page-title-updated', title })
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      send({ viewId, type: 'page-favicon-updated', favicons })
    })

    wc.on('dom-ready', () => {
      send({ viewId, type: 'dom-ready' })
      // Reinstall the page-side capture listener on each new document. This stays
      // separate from the before-input-event fallback above on purpose.
      wc.mainFrame.executeJavaScript(MODIFIED_LINK_CAPTURE_SCRIPT).catch(() => {})
    })

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      // ERR_ABORTED (-3) fires on normal navigation cancellation — ignore
      if (errorCode === -3) return
      send({
        viewId,
        type: 'did-fail-load',
        errorCode,
        errorDescription,
        url: validatedURL,
      })
    })

    wc.on('render-process-gone', () => {
      send({ viewId, type: 'crashed' })
    })

    wc.on('found-in-page', (_e, result) => {
      send({
        viewId,
        type: 'found-in-page',
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      })
    })

    wc.on('context-menu', (event, params) => {
      const input = {
        linkURL: params.linkURL,
        linkText: params.linkText,
      }
      let items = buildBrowserLinkContextMenuItems(input)
      // Web panels have no tabs — filter out "Open in new tab"
      if (entry.kind === 'web-panel') {
        items = items.filter((item) => item.action !== 'open-link-in-new-tab')
      }
      if (items.length === 0) return

      event.preventDefault()

      const menu = Menu.buildFromTemplate(items.map((item) => ({
        label: item.label,
        click: () => { this.runLinkContextMenuAction(viewId, input, item.action) },
      })))

      menu.popup({ window: this.mainWindow ?? undefined })
    })

    wc.on('destroyed', () => {
      this.views.delete(viewId)
    })
  }
}
