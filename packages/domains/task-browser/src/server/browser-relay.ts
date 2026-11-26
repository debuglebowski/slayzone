/**
 * The hub's half of the browser panel: WHO owns each task's live tabs, and a
 * request/reply channel to that owner.
 *
 * The web views themselves live on the client (Electron main on desktop). The hub
 * keeps two things only: the stored tab list (`tasks.browser_tabs`, task ops) and
 * this registry. `slay browser` reaches the hub over REST; the routes ask this relay
 * to run each operation on the client that owns the tab, and wait for its reply.
 *
 * A HOST is one open browser panel on one client, for one task: it attaches when the
 * panel subscribes to `app.browserRelay.serve`, and is gone when that subscription
 * ends (panel closed, socket dropped). Its tabs are reported with `sync` — full
 * state each time, so a reconnect just re-sends it.
 *
 * OWNERSHIP when several clients show one task: the client the user USED last for
 * that task (`noteUse`: input in its views or panel), never the one that merely
 * mounted, synced or reconnected. Use is kept per (principal, client, task), so a
 * reconnect — a new host for the same client — keeps its client's standing. With no
 * use yet, the host that came online first owns it. An explicit tab id goes to the
 * best-ranked host that HAS that tab.
 *
 * Each host is bound to the principal that opened it (`principalKey`, the user id on
 * a hub with login, null without): a sync or reply naming a host of another
 * principal is refused, so one user cannot answer — or hijack — another's requests.
 *
 * Pure: no tRPC, no DB, no timers beyond request/wait timeouts. `./relay-router.ts`
 * puts it on the wire; the hub composes one instance.
 */
import { randomUUID } from 'node:crypto'
import {
  BROWSER_RELAY_MAX_RESULT_BYTES,
  BROWSER_RELAY_OP_DEADLINE_MS,
  type BrowserRelayFrame,
  type BrowserRelayOp,
  type BrowserRelayReply,
  type BrowserRelayScope,
  type BrowserRelayTabsState,
  type BrowserRequestOrigin
} from '../shared'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000
/** Use records kept (oldest dropped first): one per (principal, client, task). */
const MAX_USE_RECORDS = 10_000

interface Host {
  hostId: string
  taskId: string
  principalKey: string | null
  /** The client device it runs on (stable across that client's reconnects). */
  clientKey: string
  send: (frame: BrowserRelayFrame) => void
  tabIds: Set<string>
  /** The isolated tabs among `tabIds` (see `BrowserRelayTabsState`). */
  isolatedTabIds: Set<string>
  activeTabId: string | null
  /** The task's primary browser panel (see `BrowserRelayTabsState.primary`). */
  primary: boolean
  /** Use clock of the last time this panel's own chrome was used (0: never). */
  usedSeq: number
  /** When it came online — the tie-break among hosts nobody used. */
  attachedSeq: number
  pending: Set<string>
}

interface PendingRequest {
  hostId: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Re-arm the silence timer (the client reported progress). */
  rearm: () => void
}

interface Waiter {
  principalKey: string | null
  tabId?: string
  scope: BrowserRelayScope
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserRelayOptions {
  /** How long a client may take to answer one request. */
  requestTimeoutMs?: number
  /** Largest reply result accepted (JSON bytes). */
  maxResultBytes?: number
}

export interface BrowserRelayTabInfo {
  tabId: string
  active: boolean
  isolated: boolean
}

export class BrowserRelay {
  private readonly hosts = new Map<string, Host>()
  private readonly requests = new Map<string, PendingRequest>()
  private readonly waiters = new Map<string, Waiter[]>()
  /** `lastUseKey(principal, client, task)` → use clock. Survives host detach. */
  private readonly lastUse = new Map<string, number>()
  /** Connected browser-capable clients per principal. */
  private readonly clients = new Map<string, number>()
  private readonly requestTimeoutMs: number
  private readonly maxResultBytes: number
  private useClock = 0
  private attachClock = 0

  constructor(opts: BrowserRelayOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxResultBytes = opts.maxResultBytes ?? BROWSER_RELAY_MAX_RESULT_BYTES
  }

  /** A client's panel for `taskId` came online. Greets it with its host id. */
  attachHost(input: {
    taskId: string
    principalKey: string | null
    clientKey: string
    send: (frame: BrowserRelayFrame) => void
  }): { hostId: string; detach: () => void } {
    const hostId = randomUUID()
    const host: Host = {
      hostId,
      taskId: input.taskId,
      principalKey: input.principalKey,
      clientKey: input.clientKey,
      send: input.send,
      tabIds: new Set(),
      isolatedTabIds: new Set(),
      activeTabId: null,
      primary: true,
      usedSeq: 0,
      attachedSeq: ++this.attachClock,
      pending: new Set()
    }
    this.hosts.set(hostId, host)
    input.send({ type: 'hello', hostId })
    return { hostId, detach: () => this.detach(hostId) }
  }

  /** Replace a host's live tabs. NOT use: mounting or reconnecting takes nothing over. */
  sync(principalKey: string | null, state: BrowserRelayTabsState): void {
    const host = this.requireHost(principalKey, state.hostId)
    host.tabIds = new Set(state.tabIds)
    host.isolatedTabIds = new Set((state.isolatedTabIds ?? []).filter((t) => host.tabIds.has(t)))
    host.activeTabId = state.activeTabId
    host.primary = state.primary !== false
    this.settleWaiters(host.taskId)
  }

  /**
   * The user used task `taskId`'s browser on client `clientKey` (input, focus);
   * `hostId`: in that panel's own chrome, so among the task's browser panels on the
   * client, that one is reached first.
   */
  noteUse(principalKey: string | null, clientKey: string, taskId: string, hostId?: string): void {
    const key = lastUseKey(principalKey, clientKey, taskId)
    this.lastUse.delete(key)
    this.lastUse.set(key, ++this.useClock)
    const host = hostId ? this.hosts.get(hostId) : undefined
    if (host && host.principalKey === principalKey && host.taskId === taskId)
      host.usedSeq = this.useClock
    if (this.lastUse.size > MAX_USE_RECORDS) {
      const oldest = this.lastUse.keys().next().value
      if (oldest !== undefined) this.lastUse.delete(oldest)
    }
  }

  /** The client is still working on a request: its silence timer starts over. */
  progress(principalKey: string | null, input: { hostId: string; requestId: string }): void {
    const host = this.requireHost(principalKey, input.hostId)
    const pending = this.requests.get(input.requestId)
    if (pending && pending.hostId === host.hostId) pending.rearm()
  }

  /**
   * A desktop app (a client that can host the browser panel) is connected for
   * `principalKey`, panel open or not. Returns the detach.
   */
  attachClient(principalKey: string | null): () => void {
    const key = principalKey ?? ''
    this.clients.set(key, (this.clients.get(key) ?? 0) + 1)
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      const n = (this.clients.get(key) ?? 1) - 1
      if (n > 0) this.clients.set(key, n)
      else this.clients.delete(key)
    }
  }

  hasClient(principalKey: string | null): boolean {
    return (this.clients.get(principalKey ?? '') ?? 0) > 0
  }

  /** The client's answer to one request. Unknown request ids (late, timed out) are ignored. */
  reply(principalKey: string | null, reply: BrowserRelayReply): void {
    const host = this.requireHost(principalKey, reply.hostId)
    const pending = this.requests.get(reply.requestId)
    if (!pending || pending.hostId !== host.hostId) return
    this.requests.delete(reply.requestId)
    host.pending.delete(reply.requestId)
    clearTimeout(pending.timer)
    if (!reply.ok) {
      pending.reject(new Error(reply.error))
      return
    }
    const size = jsonBytes(reply.result)
    if (size > this.maxResultBytes) {
      const err = new Error(
        `Browser result too large (${mib(size)} MiB; the limit is ${mib(this.maxResultBytes)} MiB).`
      )
      pending.reject(err)
      throw err
    }
    pending.resolve(reply.result)
  }

  // Every query below is for ONE requester (`principalKey`: the user the request acts
  // for, null on a hub without login) and only ever sees that principal's hosts: once
  // a task can be shared, one user's `slay browser` must never run in another user's
  // desktop browser.
  //
  // `scope: 'isolated'` (an untrusted caller) sees ONLY isolated tabs: with no tab id
  // it resolves to the owner's active tab if isolated, else its newest isolated tab —
  // never to one of the user's own tabs.

  /** Explicit tab when given, else the owner's active tab (in scope). */
  getResolvedTabId(
    principalKey: string | null,
    taskId: string,
    tabId?: string,
    scope: BrowserRelayScope = 'any'
  ): string | null {
    if (tabId) return tabId
    const host = this.resolveHost(principalKey, taskId, undefined, scope)
    return host ? defaultTabOf(host, scope) : null
  }

  /**
   * The owner's tabs: the most recently used host that has any, plus the tabs of the
   * task's other browser panels on the same client (tab ids are unique per task, so
   * `--tab` reaches each). `active` is the owner's active tab.
   */
  listTabs(principalKey: string | null, taskId: string): BrowserRelayTabInfo[] {
    const hosts = this.hostsFor(principalKey, taskId)
    const owner = hosts.find((h) => h.tabIds.size > 0)
    if (!owner) return []
    const out: BrowserRelayTabInfo[] = []
    const seen = new Set<string>()
    for (const host of hosts) {
      if (host.clientKey !== owner.clientKey) continue
      for (const id of host.tabIds) {
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          tabId: id,
          active: host === owner && owner.activeTabId === id,
          isolated: host.isolatedTabIds.has(id)
        })
      }
    }
    return out
  }

  /** True when a live tab (in scope) is registered — the "is the panel open?" probe. */
  hasTab(
    principalKey: string | null,
    taskId: string,
    tabId?: string,
    scope: BrowserRelayScope = 'any'
  ): boolean {
    return this.resolveHost(principalKey, taskId, tabId, scope) !== null
  }

  /** A live tab of the requester's that is NOT isolated: the user's own browser. */
  isUsersOwnTab(principalKey: string | null, taskId: string, tabId: string): boolean {
    return this.hostsFor(principalKey, taskId).some(
      (h) => h.tabIds.has(tabId) && !h.isolatedTabIds.has(tabId)
    )
  }

  waitForRegistration(
    principalKey: string | null,
    taskId: string,
    opts: { tabId?: string; timeoutMs?: number; scope?: BrowserRelayScope } = {}
  ): Promise<void> {
    const scope = opts.scope ?? 'any'
    if (this.hasTab(principalKey, taskId, opts.tabId, scope)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        principalKey,
        tabId: opts.tabId,
        scope,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.dropWaiter(taskId, waiter)
          reject(new Error('Browser panel did not open within timeout. Is the task tab active?'))
        }, opts.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS)
      }
      const list = this.waiters.get(taskId) ?? []
      list.push(waiter)
      this.waiters.set(taskId, list)
    })
  }

  /** Run one operation on the client that owns the tab; resolves with its reply. */
  run(
    principalKey: string | null,
    taskId: string,
    tabId: string | null,
    op: BrowserRelayOp,
    origin: BrowserRequestOrigin,
    scope: BrowserRelayScope = 'any'
  ): Promise<unknown> {
    const host = this.resolveHost(principalKey, taskId, tabId ?? undefined, scope)
    if (!host) {
      return Promise.reject(
        new Error(
          `Browser tab not available (task ${taskId}${tabId ? `, tab ${tabId}` : ''}) — it may have closed.`
        )
      )
    }
    const targetTabId = tabId ?? defaultTabOf(host, scope)
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      // Two limits: SILENCE (re-armed by each progress report — a slow page load is
      // work, not silence) and an absolute DEADLINE per op that progress cannot extend
      // (an abandoned `new Promise(() => {})` eval must end). Either one tells the host
      // to stop.
      const giveUp = (message: string): void => {
        clearTimeout(pending.timer)
        clearTimeout(deadline)
        if (!this.requests.has(requestId)) return
        this.requests.delete(requestId)
        host.pending.delete(requestId)
        try {
          host.send({ type: 'cancel', requestId })
        } catch {
          /* the host is gone; nothing to stop */
        }
        reject(new Error(message))
      }
      const expire = (): void =>
        giveUp('The client showing this browser tab did not answer in time.')
      const deadline = setTimeout(
        () =>
          giveUp(
            `The browser operation did not finish within ${Math.round(BROWSER_RELAY_OP_DEADLINE_MS[op.op] / 1000)} s.`
          ),
        BROWSER_RELAY_OP_DEADLINE_MS[op.op]
      )
      const pending: PendingRequest = {
        hostId: host.hostId,
        resolve: (v) => {
          clearTimeout(deadline)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(deadline)
          reject(e)
        },
        timer: setTimeout(expire, this.requestTimeoutMs),
        rearm: () => {
          clearTimeout(pending.timer)
          pending.timer = setTimeout(expire, this.requestTimeoutMs)
        }
      }
      this.requests.set(requestId, pending)
      host.pending.add(requestId)
      try {
        host.send({ type: 'request', requestId, taskId, tabId: targetTabId, origin, ...op })
      } catch (err) {
        clearTimeout(pending.timer)
        clearTimeout(deadline)
        this.requests.delete(requestId)
        host.pending.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private detach(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (!host) return
    this.hosts.delete(hostId)
    for (const requestId of host.pending) {
      const pending = this.requests.get(requestId)
      if (!pending) continue
      this.requests.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(new Error('The browser panel closed before it answered.'))
    }
    host.pending.clear()
  }

  private requireHost(principalKey: string | null, hostId: string): Host {
    const host = this.hosts.get(hostId)
    if (!host || host.principalKey !== principalKey) throw new Error('Unknown browser host')
    return host
  }

  /**
   * `principalKey`'s hosts serving `taskId`: most recently used client first; on one
   * client (several browser panels of the task) the panel used last, else the
   * primary panel; then first online.
   */
  private hostsFor(principalKey: string | null, taskId: string): Host[] {
    const used = (h: Host): number =>
      this.lastUse.get(lastUseKey(h.principalKey, h.clientKey, h.taskId)) ?? 0
    return [...this.hosts.values()]
      .filter((h) => h.taskId === taskId && h.principalKey === principalKey)
      .sort(
        (a, b) =>
          used(b) - used(a) ||
          b.usedSeq - a.usedSeq ||
          Number(b.primary) - Number(a.primary) ||
          a.attachedSeq - b.attachedSeq
      )
  }

  private ownerForActive(principalKey: string | null, taskId: string): Host | null {
    return (
      this.hostsFor(principalKey, taskId).find(
        (h) => h.activeTabId !== null && h.tabIds.has(h.activeTabId)
      ) ?? null
    )
  }

  private resolveHost(
    principalKey: string | null,
    taskId: string,
    tabId: string | undefined,
    scope: BrowserRelayScope = 'any'
  ): Host | null {
    if (scope === 'isolated') {
      return (
        this.hostsFor(principalKey, taskId).find((h) =>
          tabId ? h.isolatedTabIds.has(tabId) : h.isolatedTabIds.size > 0
        ) ?? null
      )
    }
    if (!tabId) return this.ownerForActive(principalKey, taskId)
    return this.hostsFor(principalKey, taskId).find((h) => h.tabIds.has(tabId)) ?? null
  }

  private settleWaiters(taskId: string): void {
    const list = this.waiters.get(taskId)
    if (!list) return
    const remaining: Waiter[] = []
    for (const w of list) {
      if (this.hasTab(w.principalKey, taskId, w.tabId, w.scope)) {
        clearTimeout(w.timer)
        w.resolve()
      } else {
        remaining.push(w)
      }
    }
    if (remaining.length) this.waiters.set(taskId, remaining)
    else this.waiters.delete(taskId)
  }

  private dropWaiter(taskId: string, waiter: Waiter): void {
    const list = this.waiters.get(taskId)
    if (!list) return
    const next = list.filter((w) => w !== waiter)
    if (next.length) this.waiters.set(taskId, next)
    else this.waiters.delete(taskId)
  }
}

/** The tab a request with no tab id runs on: the active tab, or for an isolated scope
 *  the active tab if isolated, else the newest isolated one. */
function defaultTabOf(host: Host, scope: BrowserRelayScope): string | null {
  if (scope === 'any') return host.activeTabId
  if (host.activeTabId !== null && host.isolatedTabIds.has(host.activeTabId)) {
    return host.activeTabId
  }
  return [...host.isolatedTabIds].at(-1) ?? null
}

const lastUseKey = (principalKey: string | null, clientKey: string, taskId: string): string =>
  `${principalKey ?? ''}\u0000${clientKey}\u0000${taskId}`

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)
