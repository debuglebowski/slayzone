import { ipcMain, type WebContents } from 'electron'
import { isAppWindowWebContents } from './task-windows'
import type { EventEmitter } from 'node:events'
import { recipientsFor } from './browser-host-routing'
import {
  BROWSER_HOST_METHODS,
  type BrowserHostEvent,
  type BrowserHostEvents,
  type BrowserHostMethod,
  type BrowserHostMethods
} from '@slayzone/task-browser/shared'

/**
 * The client-local browser host over Electron IPC: the browser panel in THIS app's
 * renderers drives the web views in THIS process directly — never through the hub.
 *
 * Two channels, mirrored by the preload's `window.api.browserHost`:
 *   `browser-host:invoke` (method, args) → one `BrowserHostMethods` call.
 *   `browser-host:event`  (event, payload) ← pushed to every subscribed renderer;
 *                         a renderer subscribes once with `browser-host:subscribe`.
 *                         Each new `event` listener replays `view.stateSnapshots`
 *                         first, so a panel mounting after a view loaded cannot miss
 *                         its load (events and invoke replies share one ordered pipe).
 *
 * Only app renderers may use it: never a web view of the panel, nor an extension
 * page (they are not app windows' own web contents).
 */

/** Each method, given the calling renderer (for window-relative ops). */
export type BrowserHostImpl = {
  [K in BrowserHostMethod]: (
    sender: WebContents,
    ...args: Parameters<BrowserHostMethods[K]>
  ) => ReturnType<BrowserHostMethods[K]> | Promise<ReturnType<BrowserHostMethods[K]>>
}

export interface BrowserHostIpcDeps {
  impl: BrowserHostImpl
  /** The view manager's emitter: `event`, `shortcut`, `focused`, `engaged`, `create-task-from-link`. */
  viewEvents: Pick<EventEmitter, 'on'>
  /** The DOM `<webview>` shortcut emitter (`shortcut`). */
  webviewEvents: Pick<EventEmitter, 'on'>
}

const ALLOWED = new Set<string>(BROWSER_HOST_METHODS)
const VIEW_EVENTS = ['event', 'shortcut', 'focused', 'engaged', 'create-task-from-link'] as const

/** One of the app's own windows' renderer (task-windows registry) — not a panel web
 *  view, a popup a page opened, nor an extension page. */
export function isAppRenderer(sender: WebContents): boolean {
  if (sender.isDestroyed() || !isAppWindowWebContents(sender)) return false
  return !sender.getURL().startsWith('chrome-extension:')
}

export function registerBrowserHostIpc(deps: BrowserHostIpcDeps): void {
  const subscribers = new Set<WebContents>()

  const send = <E extends BrowserHostEvent>(event: E, payload: BrowserHostEvents[E]): void => {
    for (const wc of subscribers) if (wc.isDestroyed()) subscribers.delete(wc)
    for (const wc of recipientsFor(event, payload, [...subscribers])) {
      wc.send('browser-host:event', event, payload)
    }
  }

  for (const event of VIEW_EVENTS) {
    deps.viewEvents.on(event, (payload: unknown) =>
      send(event, payload as BrowserHostEvents[typeof event])
    )
  }
  deps.webviewEvents.on('shortcut', (payload: unknown) =>
    send('webview-shortcut', payload as BrowserHostEvents['webview-shortcut'])
  )

  ipcMain.on('browser-host:subscribe', (e) => {
    const wc = e.sender
    if (!isAppRenderer(wc) || subscribers.has(wc)) return
    subscribers.add(wc)
    wc.once('destroyed', () => subscribers.delete(wc))
  })

  ipcMain.handle('browser-host:invoke', (e, method: unknown, args: unknown) => {
    if (!isAppRenderer(e.sender)) throw new Error('browser host: not an app renderer')
    if (typeof method !== 'string' || !ALLOWED.has(method)) {
      throw new Error(`browser host: unknown method ${String(method)}`)
    }
    const fn = deps.impl[method as BrowserHostMethod] as (
      sender: WebContents,
      ...a: unknown[]
    ) => unknown
    return fn(e.sender, ...(Array.isArray(args) ? args : []))
  })
}
