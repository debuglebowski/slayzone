import { webContents } from 'electron'
import { writeFileSync } from 'node:fs'

interface TaskEntry {
  activeTabId: string | null
  tabs: Map<string, number> // tabId → webContentsId
}

const registry = new Map<string, TaskEntry>()

interface PendingRegistration {
  resolve: (wc: Electron.WebContents) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** If set, only resolve when this specific tab registers. Otherwise resolve when active tab is registered. */
  tabId?: string
}

// taskId → list of pending waiters (multiple CLI calls may wait concurrently)
const pendingRegistrations = new Map<string, PendingRegistration[]>()

function getOrCreateEntry(taskId: string): TaskEntry {
  let entry = registry.get(taskId)
  if (!entry) {
    entry = { activeTabId: null, tabs: new Map() }
    registry.set(taskId, entry)
  }
  return entry
}

function tryResolvePending(taskId: string): void {
  const waiters = pendingRegistrations.get(taskId)
  if (!waiters || waiters.length === 0) return
  const remaining: PendingRegistration[] = []
  for (const w of waiters) {
    const wc = resolveWc(taskId, w.tabId)
    if (wc) {
      clearTimeout(w.timer)
      w.resolve(wc)
    } else {
      remaining.push(w)
    }
  }
  if (remaining.length === 0) pendingRegistrations.delete(taskId)
  else pendingRegistrations.set(taskId, remaining)
}

function resolveWc(taskId: string, tabId: string | undefined): Electron.WebContents | null {
  const entry = registry.get(taskId)
  if (!entry) return null
  const targetTabId = tabId ?? entry.activeTabId
  if (!targetTabId) return null
  const wcId = entry.tabs.get(targetTabId)
  if (wcId == null) return null
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    entry.tabs.delete(targetTabId)
    if (entry.activeTabId === targetTabId) entry.activeTabId = null
    return null
  }
  return wc
}

export function registerBrowserTab(taskId: string, tabId: string, webContentsId: number): void {
  const entry = getOrCreateEntry(taskId)
  entry.tabs.set(tabId, webContentsId)
  const wc = webContents.fromId(webContentsId)
  if (wc) {
    wc.once('destroyed', () => {
      const e = registry.get(taskId)
      if (!e) return
      if (e.tabs.get(tabId) === webContentsId) {
        e.tabs.delete(tabId)
        if (e.activeTabId === tabId) e.activeTabId = null
      }
      if (e.tabs.size === 0 && e.activeTabId == null) registry.delete(taskId)
    })
  }
  tryResolvePending(taskId)
}

export function unregisterBrowserTab(taskId: string, tabId: string): void {
  const entry = registry.get(taskId)
  if (!entry) return
  entry.tabs.delete(tabId)
  if (entry.activeTabId === tabId) entry.activeTabId = null
  if (entry.tabs.size === 0 && entry.activeTabId == null) registry.delete(taskId)
}

export function setActiveBrowserTab(taskId: string, tabId: string | null): void {
  const entry = getOrCreateEntry(taskId)
  entry.activeTabId = tabId
  tryResolvePending(taskId)
}

export function clearBrowserRegistry(): void {
  registry.clear()
  for (const [, waiters] of pendingRegistrations) {
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('Browser registry cleared'))
    }
  }
  pendingRegistrations.clear()
}

// `getBrowserWebContents` used to be exported here. It is deliberately gone: handing
// a live `WebContents` to a caller is what forced the REST browser routes to run on
// the desktop instead of where their data lives. Use the `(taskId, tabId)`-keyed ops
// below; `hasBrowserTab` covers the "is there a tab?" probe it was mostly used for.

/** Returns the resolved tab id for a request — explicit when given, else the registry's active tab. */
export function getResolvedBrowserTabId(taskId: string, tabId?: string): string | null {
  if (tabId) return tabId
  return registry.get(taskId)?.activeTabId ?? null
}

export interface BrowserTabInfo {
  tabId: string
  active: boolean
}

export function listBrowserTabs(taskId: string): BrowserTabInfo[] {
  const entry = registry.get(taskId)
  if (!entry) return []
  const out: BrowserTabInfo[] = []
  for (const tabId of entry.tabs.keys()) {
    out.push({ tabId, active: entry.activeTabId === tabId })
  }
  return out
}

/**
 * Handle-free operations on a registered tab, keyed by `(taskId, tabId)`.
 *
 * These are what the REST browser routes call now. The routes run in the HUB —
 * where the `tasks.browser_tabs` row they read and write lives — and reach these
 * over the capability bridge. A `WebContents` cannot cross that bridge; an id
 * pair can, and every operation the routes actually needed turned out to be
 * expressible against one (four members of the old `BrowserWc`, five call sites).
 *
 * Each resolves the tab at call time rather than closing over a handle, so a tab
 * destroyed between resolution and use fails loudly here instead of throwing from
 * inside Electron.
 */
function requireWc(taskId: string, tabId: string | null): Electron.WebContents {
  const wc = resolveWc(taskId, tabId ?? undefined)
  if (!wc) {
    throw new Error(
      `Browser tab not available (task ${taskId}${tabId ? `, tab ${tabId}` : ''}) — it may have closed.`
    )
  }
  return wc
}

/** True when a live tab is registered — the "is the panel open?" probe. */
export function hasBrowserTab(taskId: string, tabId?: string): boolean {
  return resolveWc(taskId, tabId) !== null
}

export async function browserExecJs(
  taskId: string,
  tabId: string | null,
  code: string
): Promise<unknown> {
  const frame = requireWc(taskId, tabId).mainFrame
  if (!frame) throw new Error('No main frame')
  return frame.executeJavaScript(code)
}

export async function browserLoadUrl(
  taskId: string,
  tabId: string | null,
  url: string
): Promise<void> {
  await requireWc(taskId, tabId).loadURL(url)
}

export async function browserGetUrl(taskId: string, tabId: string | null): Promise<string | null> {
  return resolveWc(taskId, tabId ?? undefined)?.getURL() ?? null
}

/** Captures to `destPath`; false when the image came back empty. The PNG is
 *  written here so it never crosses the bridge as a buffer. */
export async function browserCapturePageToFile(
  taskId: string,
  tabId: string | null,
  destPath: string
): Promise<boolean> {
  const image = await requireWc(taskId, tabId).capturePage()
  if (image.isEmpty()) return false
  writeFileSync(destPath, image.toPNG())
  return true
}

/** Void-returning wrapper: callers past the bridge only need "a tab exists now". */
export async function awaitBrowserRegistration(
  taskId: string,
  opts: { tabId?: string; timeoutMs?: number } = {}
): Promise<void> {
  await waitForBrowserRegistration(taskId, opts)
}

export function waitForBrowserRegistration(
  taskId: string,
  opts: { tabId?: string; timeoutMs?: number } = {}
): Promise<Electron.WebContents> {
  const { tabId, timeoutMs = 10_000 } = opts
  const existing = resolveWc(taskId, tabId)
  if (existing) return Promise.resolve(existing)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = pendingRegistrations.get(taskId)
      if (list) {
        const idx = list.indexOf(waiter)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) pendingRegistrations.delete(taskId)
      }
      reject(new Error('Browser panel did not open within timeout. Is the task tab active?'))
    }, timeoutMs)

    const waiter: PendingRegistration = { resolve, reject, timer, tabId }
    const list = pendingRegistrations.get(taskId) ?? []
    list.push(waiter)
    pendingRegistrations.set(taskId, list)
  })
}
