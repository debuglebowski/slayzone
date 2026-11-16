/**
 * Hub ⇄ client frames for relaying `slay browser` to the client that owns a task's
 * browser panel.
 *
 * A client's browser panel opens `app.browserRelay.serve({ taskId, clientKey })`. The hub answers
 * with a `hello` carrying a fresh `hostId`, then pushes one `request` per operation it
 * needs run against a live tab. The client runs it on its own browser host and answers
 * with `app.browserRelay.reply`. Which tabs a host has is reported with
 * `app.browserRelay.sync` (full state, idempotent — survives reconnects).
 *
 * Type-only: part of the `@slayzone/task-browser/shared` subpath.
 */

export type BrowserRelayOp =
  | { op: 'execJs'; code: string }
  | { op: 'loadUrl'; url: string }
  | { op: 'getUrl' }
  | { op: 'capturePng' }

/**
 * Where the `slay browser` caller runs, as the HUB sees it. `hub-machine`: on the
 * hub's own machine (loopback, or through the hub's own co-located computer).
 * `elsewhere`: anything else. A client only acts on `hub-machine` when that hub is
 * its OWN local hub — the claim of any other hub is worth nothing to it.
 */
export type BrowserRequestOrigin = 'hub-machine' | 'elsewhere'

export type BrowserRelayRequest = BrowserRelayOp & {
  requestId: string
  taskId: string
  /** null = the task's active tab on that client. */
  tabId: string | null
  origin: BrowserRequestOrigin
}

/** Largest result a relayed operation may return (well under the socket's frame cap). */
export const BROWSER_RELAY_MAX_RESULT_BYTES = 32 * 1024 * 1024

export type BrowserRelayFrame =
  | { type: 'hello'; hostId: string }
  | ({ type: 'request' } & BrowserRelayRequest)

/** The client's answer. `capturePng` answers `{ pngBase64 }` (null = empty capture). */
export type BrowserRelayReply =
  | { hostId: string; requestId: string; ok: true; result: unknown }
  | { hostId: string; requestId: string; ok: false; error: string }

export interface BrowserRelayTabsState {
  hostId: string
  tabIds: string[]
  activeTabId: string | null
}
