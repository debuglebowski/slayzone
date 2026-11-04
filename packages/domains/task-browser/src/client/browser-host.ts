import { useEffect } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import type {
  BrowserHostEvent,
  BrowserHostEvents,
  BrowserHostMethod,
  BrowserHostMethods
} from '../shared'

/**
 * The typed client for THIS device's browser host — the process that owns the
 * browser panel's web views (`../shared/browser-host.ts`). The panel drives its
 * views here directly; nothing about a live view goes through the hub.
 *
 * Null where this device hosts no web views (the web shell): the panel shows that
 * it needs the desktop app instead of retrying a call that can never succeed.
 */
export interface BrowserHostClient {
  call<K extends BrowserHostMethod>(
    method: K,
    ...args: Parameters<BrowserHostMethods[K]>
  ): Promise<Awaited<ReturnType<BrowserHostMethods[K]>>>
  on<E extends BrowserHostEvent>(
    event: E,
    listener: (payload: BrowserHostEvents[E]) => void
  ): () => void
}

let cached: { raw: object; client: BrowserHostClient } | null = null

export function getBrowserHost(): BrowserHostClient | null {
  const raw = electronBootstrap.browserHost()
  if (!raw) return null
  if (cached?.raw === raw) return cached.client
  const client: BrowserHostClient = {
    call: (method, ...args) =>
      raw.invoke(method, args) as Promise<Awaited<ReturnType<BrowserHostMethods[typeof method]>>>,
    on: (event, listener) => {
      let active = true
      const off = raw.on((name, payload) => {
        if (active && name === event) listener(payload as BrowserHostEvents[typeof event])
      })
      // A new `event` listener first replays every live view's state: it may attach
      // after a view's did-navigate/dom-ready already fired (createView resolved, the
      // hook subscribed a tick later). Electron delivers sends and invoke replies to a
      // frame in order, so the snapshot is never older than an event already delivered.
      if (event === 'event') {
        raw.invoke('view.stateSnapshots', []).then(
          (snapshots) => {
            if (!active || !Array.isArray(snapshots)) return
            for (const s of snapshots) listener(s as BrowserHostEvents[typeof event])
          },
          () => {
            /* no replay: live events still flow */
          }
        )
      }
      return () => {
        active = false
        off()
      }
    }
  }
  cached = { raw, client }
  return client
}

/** Fire-and-forget host call: a failed UI-driven call is logged, never thrown. */
export function callBrowserHost<K extends BrowserHostMethod>(
  method: K,
  ...args: Parameters<BrowserHostMethods[K]>
): void {
  const host = getBrowserHost()
  if (!host) return
  host.call(method, ...args).catch((err: unknown) => {
    console.warn(`[browser-host] ${method} failed:`, err)
  })
}

/** Subscribe to one host event while mounted (and `enabled`). */
export function useBrowserHostEvent<E extends BrowserHostEvent>(
  event: E,
  handler: (payload: BrowserHostEvents[E]) => void,
  enabled = true
): void {
  const stable = useStableCallback(handler)
  useEffect(() => {
    if (!enabled) return
    const host = getBrowserHost()
    if (!host) return
    return host.on(event, stable)
  }, [event, enabled, stable])
}
