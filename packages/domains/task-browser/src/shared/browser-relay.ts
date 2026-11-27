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

/**
 * `cancel`: the hub gave up on a request (its deadline or the client's silence) — the
 * client stops working on it and reporting progress.
 */
export type BrowserRelayFrame =
  | { type: 'hello'; hostId: string }
  | ({ type: 'request' } & BrowserRelayRequest)
  | { type: 'cancel'; requestId: string }

/**
 * The longest each relayed op may take, progress or not. `execJs` matches the REST
 * route's 10 s script limit plus margin; a page load gets minutes (slow sites are
 * normal); the reads are quick.
 */
export const BROWSER_RELAY_OP_DEADLINE_MS: Record<BrowserRelayOp['op'], number> = {
  execJs: 15_000,
  loadUrl: 5 * 60_000,
  getUrl: 15_000,
  capturePng: 60_000
}

/** The client's answer. `capturePng` answers `{ pngBase64 }` (null = empty capture). */
export type BrowserRelayReply =
  | { hostId: string; requestId: string; ok: true; result: unknown }
  | { hostId: string; requestId: string; ok: false; error: string }

export interface BrowserRelayTabsState {
  hostId: string
  tabIds: string[]
  activeTabId: string | null
  /**
   * The ISOLATED tabs among `tabIds`: those an untrusted caller (an agent elsewhere,
   * a remote hub) may use. Each lives in its own empty cookie jar under the untrusted
   * session policy, never the user's own (`browserPartitionForTab`). Absent (an older
   * client) = none.
   */
  isolatedTabIds?: string[]
  /**
   * The task's PRIMARY browser panel (its first instance) rather than another
   * browser panel instance on the same client. With no host-level use yet, a request
   * without a tab id goes to the primary. Absent (an older client: one panel) = true.
   */
  primary?: boolean
}

/** Which tabs a query may see: every tab (a trusted local caller) or the isolated ones. */
export type BrowserRelayScope = 'any' | 'isolated'
