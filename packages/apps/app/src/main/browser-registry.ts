import { webContents } from 'electron'

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

export function getBrowserWebContents(taskId: string, tabId?: string): Electron.WebContents | null {
  return resolveWc(taskId, tabId)
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

export function waitForBrowserRegistration(
  taskId: string,
  opts: { tabId?: string; timeoutMs?: number } = {},
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
