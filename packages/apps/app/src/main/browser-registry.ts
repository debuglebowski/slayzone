import { webContents } from 'electron'
import type { RelayedTabOpts } from '@slayzone/task-browser/shared'
import { untrustedOpRefusal, type PanelNetworkPolicy } from './browser-panel-policy'

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

let policy: PanelNetworkPolicy | null = null
/** Whether a web contents lives in an untrusted session: an isolated tab's partition,
 *  or a remote hub's. Never the user's own browser. */
let isUntrustedSession: (wc: Electron.WebContents) => boolean = () => false

/** The session-level policy untrusted relayed ops run under (set once at boot). */
export function setBrowserNetworkPolicy(
  next: PanelNetworkPolicy,
  untrustedSession: (wc: Electron.WebContents) => boolean
): void {
  policy = next
  isUntrustedSession = untrustedSession
}

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

/**
 * An untrusted caller (anyone but this device's own local agent) acts ONLY on a tab in
 * an untrusted session — an isolated tab, or a remote hub's — never in the user's own
 * browser. Decided by the session the tab's web contents lives in, so no history,
 * popup or worker can change it.
 */
function refuseUnlessIsolated(wc: Electron.WebContents, opts: RelayedTabOpts | undefined): void {
  const refusal = untrustedOpRefusal(!!opts?.untrusted, isUntrustedSession(wc))
  if (refusal) throw new Error(refusal)
}

function refuseTooLarge(bytes: number, opts: RelayedTabOpts | undefined): void {
  const max = opts?.maxResultBytes
  if (max !== undefined && bytes > max) {
    throw new Error(
      `Browser result too large (${(bytes / 1048576).toFixed(1)} MiB; the limit is ${(max / 1048576).toFixed(0)} MiB).`
    )
  }
}

export async function browserExecJs(
  taskId: string,
  tabId: string | null,
  code: string,
  opts?: RelayedTabOpts
): Promise<unknown> {
  const wc = requireWc(taskId, tabId)
  const frame = wc.mainFrame
  if (!frame) throw new Error('No main frame')
  refuseUnlessIsolated(wc, opts)
  const result = await frame.executeJavaScript(code)
  // Measured here, where the value is produced — before it is copied to the renderer
  // and serialized for the hub. Stops counting at the limit.
  if (opts?.maxResultBytes !== undefined) {
    refuseTooLarge(jsonSizeUpTo(result, opts.maxResultBytes + 1), opts)
  }
  return result
}

export async function browserLoadUrl(
  taskId: string,
  tabId: string | null,
  url: string,
  opts?: RelayedTabOpts
): Promise<void> {
  const wc = requireWc(taskId, tabId)
  refuseUnlessIsolated(wc, opts)
  if (opts?.untrusted) {
    if (!policy) throw new Error('The browser is not ready.')
    // Says why up front; the session policy refuses the same, and every request after.
    await policy.checkTarget(url, wc.id)
  }
  await wc.loadURL(url)
}

export async function browserGetUrl(
  taskId: string,
  tabId: string | null,
  opts?: RelayedTabOpts
): Promise<string | null> {
  const wc = resolveWc(taskId, tabId ?? undefined)
  if (!wc) return null
  refuseUnlessIsolated(wc, opts)
  return wc.getURL()
}

/** PNG bytes of the visible page; null when the image came back empty. */
export async function browserCapturePng(
  taskId: string,
  tabId: string | null,
  opts?: RelayedTabOpts
): Promise<Uint8Array | null> {
  const wc = requireWc(taskId, tabId)
  refuseUnlessIsolated(wc, opts)
  const image = await wc.capturePage()
  if (image.isEmpty()) return null
  const png = image.toPNG()
  // The relay carries it base64-encoded: 4 bytes per 3.
  refuseTooLarge(Math.ceil(png.length / 3) * 4, opts)
  return new Uint8Array(png)
}

/**
 * The JSON size of `value`, counting only up to `limit` (then returns `limit`): a huge
 * result is refused without ever building its serialization.
 */
export function jsonSizeUpTo(value: unknown, limit: number): number {
  let size = 0
  const seen = new Set<object>()
  const walk = (v: unknown): void => {
    if (size >= limit) return
    if (v === null || v === undefined) {
      size += 4
    } else if (typeof v === 'string') {
      size += v.length + 2
    } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      size += String(v).length
    } else if (typeof v === 'object') {
      if (seen.has(v)) return
      seen.add(v)
      if (ArrayBuffer.isView(v)) {
        size += (v as ArrayBufferView).byteLength * 4
        return
      }
      size += 2
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        size += k.length + 4
        walk(child)
        if (size >= limit) return
      }
    }
  }
  walk(value)
  return Math.min(size, limit)
}
