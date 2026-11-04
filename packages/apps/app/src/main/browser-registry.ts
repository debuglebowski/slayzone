import { webContents } from 'electron'

/**
 * This client's (taskId, tabId) → live tab registry.
 *
 * The renderer's browser panel registers each tab it shows (with the tab's
 * webContents id) through the client-local browser host (`tabs.*`). `slay browser`
 * reaches these tabs through the HUB: the hub's relay knows which client owns a
 * task's tabs and sends that client a request, which its panel answers by running
 * the operation here. Whether a panel is open at all is the hub's question
 * (`BrowserRelay.hasTab`) — this registry only maps a tab to its live web contents.
 */
interface TaskEntry {
  activeTabId: string | null
  tabs: Map<string, number> // tabId → webContentsId
}

const registry = new Map<string, TaskEntry>()

function getOrCreateEntry(taskId: string): TaskEntry {
  let entry = registry.get(taskId)
  if (!entry) {
    entry = { activeTabId: null, tabs: new Map() }
    registry.set(taskId, entry)
  }
  return entry
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
}

export function clearBrowserRegistry(): void {
  registry.clear()
}

/**
 * Operations on a registered tab, keyed by `(taskId, tabId)` — what the hub relays
 * for `slay browser`. Each resolves the tab at call time, so a tab destroyed between
 * the request and its run fails loudly here instead of throwing from inside Electron.
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

/** PNG bytes of the visible page; null when the image came back empty. */
export async function browserCapturePng(
  taskId: string,
  tabId: string | null
): Promise<Uint8Array | null> {
  const image = await requireWc(taskId, tabId).capturePage()
  if (image.isEmpty()) return null
  return new Uint8Array(image.toPNG())
}
