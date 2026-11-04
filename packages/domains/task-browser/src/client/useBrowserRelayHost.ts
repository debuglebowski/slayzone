import { createContext, useContext, useMemo, useRef } from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import type { BrowserRelayFrame, BrowserRelayRequest } from '../shared'
import { getBrowserHost, useBrowserHostEvent, type BrowserHostClient } from './browser-host'
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
}

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
  const hostIdRef = useRef<string | null>(null)
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
    runRelayRequest(host, req).then(
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
      { taskId: taskId ?? '' },
      { enabled: hasHost && !!taskId, onData: onFrame }
    )
  )

  // Genuine user input in this task's views keeps its agent session awake (idle-close).
  useBrowserHostEvent(
    'engaged',
    (payload) => {
      const hostId = hostIdRef.current
      if (!taskId || payload.taskId !== taskId || !hostId) return
      trpcClient.app.browserRelay.engaged.mutate({ hostId }).catch(() => {
        /* best effort: a missed touch only shortens the idle window once */
      })
    },
    hasHost
  )

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

  return useMemo(() => ({ tabLive, tabGone, setActiveTab }), [tabLive, tabGone, setActiveTab])
}

/** Run one relayed request against this device's tab registry. */
export async function runRelayRequest(
  host: BrowserHostClient,
  req: BrowserRelayRequest
): Promise<unknown> {
  switch (req.op) {
    case 'execJs':
      return host.call('tabs.execJs', req.taskId, req.tabId, req.code)
    case 'loadUrl':
      await host.call('tabs.loadUrl', req.taskId, req.tabId, req.url)
      return null
    case 'getUrl':
      return host.call('tabs.getUrl', req.taskId, req.tabId)
    case 'capturePng': {
      const bytes = await host.call('tabs.capturePng', req.taskId, req.tabId)
      return { pngBase64: bytes ? bytesToBase64(bytes) : null }
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
