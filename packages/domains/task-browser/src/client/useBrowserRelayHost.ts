import { createContext, useContext, useMemo, useRef } from 'react'
import { useHubId, useHubRegistryStore, useSubscription } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import {
  BROWSER_RELAY_MAX_RESULT_BYTES,
  type BrowserRelayFrame,
  type BrowserRelayRequest
} from '../shared'
import { BROWSER_CLIENT_KEY, getBrowserHost, type BrowserHostClient } from './browser-host'
import { useTRPC, useTRPCClient } from './trpc'

/**
 * This panel as the hub's "browser host" for its task: the client that owns the
 * task's live tabs, so `slay browser` (hub REST) can reach them.
 *
 * Opens `app.browserRelay.serve` while mounted. The hub greets with a host id, then
 * pushes requests; each runs on THIS device's browser host and is answered with
 * `app.browserRelay.reply`. The live tabs are reported with `sync` — in full, on
 * every change and on every (re)connect (a reconnect is a new host id).
 */
export interface BrowserRelayHostHandle {
  /** A tab's view registered on this device's host. */
  tabLive: (tabId: string) => void
  tabGone: (tabId: string) => void
  setActiveTab: (tabId: string | null) => void
  /** The user worked in this panel's chrome (tab bar, address bar, …): this client
   *  becomes the one `slay browser` reaches for the task. Throttled. */
  noteUse: () => void
}

const USE_THROTTLE_MS = 5000

export const BrowserRelayHostContext = createContext<BrowserRelayHostHandle | null>(null)

/** The enclosing panel's relay host, or null outside a panel. */
export function useBrowserRelayHostHandle(): BrowserRelayHostHandle | null {
  return useContext(BrowserRelayHostContext)
}

/** `taskId` undefined (a panel with no task) → no host: nothing to relay to. */
export function useBrowserRelayHost(taskId: string | undefined): BrowserRelayHostHandle {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const hasHost = getBrowserHost() !== null
  // Whether this panel's hub is this device's OWN local hub: only then does a
  // request's `hub-machine` origin mean anything (see runRelayRequest).
  const hubId = useHubId()
  const hubIsLocal = useHubRegistryStore((s) => {
    const id = hubId ?? s.defaultHubId
    return s.hubs.some((h) => h.id === id && h.kind === 'local')
  })
  const hostIdRef = useRef<string | null>(null)
  const lastUseRef = useRef(0)
  const tabsRef = useRef(new Set<string>())
  const activeRef = useRef<string | null>(null)

  const sync = useStableCallback(() => {
    const hostId = hostIdRef.current
    if (!hostId) return
    trpcClient.app.browserRelay.sync
      .mutate({ hostId, tabIds: [...tabsRef.current], activeTabId: activeRef.current })
      .catch((err: unknown) => console.warn('[browser-relay] sync failed:', err))
  })

  const answer = useStableCallback((req: BrowserRelayRequest) => {
    const hostId = hostIdRef.current
    const host = getBrowserHost()
    if (!hostId) return
    const settle = (reply: { ok: true; result: unknown } | { ok: false; error: string }) =>
      trpcClient.app.browserRelay.reply
        .mutate({ hostId, requestId: req.requestId, ...reply })
        .catch((err: unknown) => console.warn('[browser-relay] reply failed:', err))
    if (!host) {
      void settle({ ok: false, error: 'This client has no browser host.' })
      return
    }
    if (!taskId) {
      void settle({ ok: false, error: 'That task is not open here.' })
      return
    }
    runRelayRequest(host, req, {
      taskId,
      liveTabIds: tabsRef.current,
      activeTabId: activeRef.current,
      hubIsLocal
    }).then(
      (result) => settle({ ok: true, result }),
      (err: unknown) =>
        settle({ ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  })

  const onFrame = useStableCallback((frame: BrowserRelayFrame) => {
    if (frame.type === 'hello') {
      hostIdRef.current = frame.hostId
      sync()
      return
    }
    answer(frame)
  })

  useSubscription(
    trpc.app.browserRelay.serve.subscriptionOptions(
      { taskId: taskId ?? '', clientKey: BROWSER_CLIENT_KEY },
      { enabled: hasHost && !!taskId, onData: onFrame }
    )
  )

  // Input in the task's web views reaches the hub through the app-level
  // `useBrowserEngagementForwarder` (panel open or not). Interaction with the panel's
  // own chrome never reaches a web view, so it is reported here.
  const noteUse = useStableCallback(() => {
    if (!taskId || !hasHost) return
    const now = Date.now()
    if (now - lastUseRef.current < USE_THROTTLE_MS) return
    lastUseRef.current = now
    trpcClient.app.browserRelay.engaged
      .mutate({ taskId, clientKey: BROWSER_CLIENT_KEY })
      .catch(() => {
        /* best effort: ownership follows the next interaction */
      })
  })

  const tabLive = useStableCallback((tabId: string) => {
    tabsRef.current.add(tabId)
    sync()
  })
  const tabGone = useStableCallback((tabId: string) => {
    if (!tabsRef.current.delete(tabId)) return
    sync()
  })
  const setActiveTab = useStableCallback((tabId: string | null) => {
    activeRef.current = tabId
    sync()
  })

  return useMemo(
    () => ({ tabLive, tabGone, setActiveTab, noteUse }),
    [tabLive, tabGone, setActiveTab, noteUse]
  )
}

/** What the panel serving the request knows; nothing here comes from the hub. */
export interface RelayPanelContext {
  /** The task this panel serves. */
  taskId: string
  /** Tabs this panel has live on this device. */
  liveTabIds: ReadonlySet<string>
  activeTabId: string | null
  /** The hub this panel talks to is this device's own local hub. */
  hubIsLocal: boolean
}

const MAX_ID = 200
const MAX_CODE_BYTES = 1024 * 1024
const MAX_URL = 8192
/** Pages a remote caller may read or drive. Anything else is this device's own. */
const WEB_SCHEMES = new Set(['http:', 'https:'])

class RelayRefusal extends Error {}

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

/**
 * Run one relayed `slay browser` request against this device's tab registry.
 *
 * The CLIENT decides what a hub may do here — it never trusts the hub with its own
 * disk. Every input is validated; only this panel's task and its live tabs are
 * reachable; navigation is http/https/about:blank; and a tab showing anything else
 * (a local file, an extension or devtools page) is not read or captured. The one
 * exception keeps main's behaviour for a LOCAL agent: a request from this device's
 * own machine (`origin: hub-machine`) through this device's own local hub may also
 * navigate to and read `file:` pages. Any other hub's claim to be local is ignored.
 */
export async function runRelayRequest(
  host: BrowserHostClient,
  req: BrowserRelayRequest,
  panel: RelayPanelContext
): Promise<unknown> {
  const r = req as Partial<Record<string, unknown>>
  if (!isId(r.requestId) || !isId(r.taskId)) throw new RelayRefusal('Malformed browser request.')
  if (r.tabId !== null && !isId(r.tabId)) throw new RelayRefusal('Malformed browser request.')
  if (r.origin !== 'hub-machine' && r.origin !== 'elsewhere') {
    throw new RelayRefusal('Malformed browser request.')
  }
  const trustedLocal = panel.hubIsLocal && r.origin === 'hub-machine'

  if (r.taskId !== panel.taskId) {
    throw new RelayRefusal('That task is not open here.')
  }
  const tabId = (r.tabId as string | null) ?? panel.activeTabId
  if (!tabId || !panel.liveTabIds.has(tabId)) {
    throw new RelayRefusal('That browser tab is not open here.')
  }
  const taskId = panel.taskId

  /** Reads and drives only web pages, unless the caller is a trusted local agent. */
  const requireWebPage = async (): Promise<void> => {
    if (trustedLocal) return
    const current = await host.call('tabs.getUrl', taskId, tabId)
    if (!isRemoteReadable(current)) {
      throw new RelayRefusal('This tab shows a local page; it can only be read from this computer.')
    }
  }

  let result: unknown
  switch (r.op) {
    case 'execJs': {
      if (typeof r.code !== 'string' || byteLength(r.code) > MAX_CODE_BYTES) {
        throw new RelayRefusal('Malformed browser request.')
      }
      await requireWebPage()
      result = await host.call('tabs.execJs', taskId, tabId, r.code)
      break
    }
    case 'loadUrl': {
      if (typeof r.url !== 'string' || r.url.length > MAX_URL) {
        throw new RelayRefusal('Malformed browser request.')
      }
      const url = parseUrl(r.url)
      if (!url) throw new RelayRefusal('Malformed browser request.')
      if (!hubMayNavigateTo(r.url, { fileAllowed: trustedLocal })) {
        throw new RelayRefusal(`Navigation to ${url.protocol} is not allowed from here.`)
      }
      await host.call('tabs.loadUrl', taskId, tabId, r.url)
      result = null
      break
    }
    case 'getUrl': {
      const current = await host.call('tabs.getUrl', taskId, tabId)
      if (!trustedLocal && !isRemoteReadable(current)) {
        throw new RelayRefusal(
          'This tab shows a local page; it can only be read from this computer.'
        )
      }
      result = current
      break
    }
    case 'capturePng': {
      await requireWebPage()
      const bytes = await host.call('tabs.capturePng', taskId, tabId)
      result = { pngBase64: bytes ? bytesToBase64(bytes) : null }
      break
    }
    default:
      throw new RelayRefusal('Malformed browser request.')
  }

  const size = result === undefined ? 0 : byteLength(JSON.stringify(result) ?? '')
  if (size > BROWSER_RELAY_MAX_RESULT_BYTES) {
    throw new RelayRefusal(
      `Browser result too large (${(size / 1048576).toFixed(1)} MiB; the limit is ${BROWSER_RELAY_MAX_RESULT_BYTES / 1048576} MiB).`
    )
  }
  return result
}

/**
 * Whether a URL the HUB supplied (a relayed navigate, `slay browser new`, an
 * auto-open) may be loaded in this device's browser: http, https and about:blank —
 * plus `file:` only when `fileAllowed` (a local agent through this device's own hub,
 * as on main). Never javascript:, data:, slz-file:, chrome:, devtools:, extensions.
 */
export function hubMayNavigateTo(raw: string, opts: { fileAllowed: boolean }): boolean {
  if (raw === 'about:blank') return true
  const url = parseUrl(raw)
  if (!url) return false
  return WEB_SCHEMES.has(url.protocol) || (opts.fileAllowed && url.protocol === 'file:')
}

/** A page a remote caller may read: a web page, or a blank/empty tab. */
function isRemoteReadable(current: string | null): boolean {
  if (!current || current === 'about:blank') return true
  const url = parseUrl(current)
  return !!url && WEB_SCHEMES.has(url.protocol)
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
