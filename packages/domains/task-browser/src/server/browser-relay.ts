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
 * OWNERSHIP when several clients show one task: the host that synced most recently
 * (the one last used). An explicit tab id goes to the most recent host that HAS
 * that tab.
 *
 * Each host is bound to the principal that opened it (`principalKey`, the user id on
 * a hub with login, null without): a sync or reply naming a host of another
 * principal is refused, so one user cannot answer — or hijack — another's requests.
 *
 * Pure: no tRPC, no DB, no timers beyond request/wait timeouts. `./relay-router.ts`
 * puts it on the wire; the hub composes one instance.
 */
import { randomUUID } from 'node:crypto'
import type {
  BrowserRelayFrame,
  BrowserRelayOp,
  BrowserRelayReply,
  BrowserRelayTabsState
} from '../shared'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000

interface Host {
  hostId: string
  taskId: string
  principalKey: string | null
  send: (frame: BrowserRelayFrame) => void
  tabIds: Set<string>
  activeTabId: string | null
  /** Monotonic use counter — bigger = used more recently. */
  usedAt: number
  pending: Set<string>
}

interface PendingRequest {
  hostId: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Waiter {
  tabId?: string
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserRelayOptions {
  /** How long a client may take to answer one request. */
  requestTimeoutMs?: number
}

export interface BrowserRelayTabInfo {
  tabId: string
  active: boolean
}

export class BrowserRelay {
  private readonly hosts = new Map<string, Host>()
  private readonly requests = new Map<string, PendingRequest>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly requestTimeoutMs: number
  private useClock = 0

  constructor(opts: BrowserRelayOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** A client's panel for `taskId` came online. Greets it with its host id. */
  attachHost(input: {
    taskId: string
    principalKey: string | null
    send: (frame: BrowserRelayFrame) => void
  }): { hostId: string; detach: () => void } {
    const hostId = randomUUID()
    const host: Host = {
      hostId,
      taskId: input.taskId,
      principalKey: input.principalKey,
      send: input.send,
      tabIds: new Set(),
      activeTabId: null,
      usedAt: ++this.useClock,
      pending: new Set()
    }
    this.hosts.set(hostId, host)
    input.send({ type: 'hello', hostId })
    return { hostId, detach: () => this.detach(hostId) }
  }

  /** Replace a host's live tabs. Counts as "used now" for ownership. */
  sync(principalKey: string | null, state: BrowserRelayTabsState): void {
    const host = this.requireHost(principalKey, state.hostId)
    host.tabIds = new Set(state.tabIds)
    host.activeTabId = state.activeTabId
    host.usedAt = ++this.useClock
    this.settleWaiters(host.taskId)
  }

  /** The client's answer to one request. Unknown request ids (late, timed out) are ignored. */
  reply(principalKey: string | null, reply: BrowserRelayReply): void {
    const host = this.requireHost(principalKey, reply.hostId)
    const pending = this.requests.get(reply.requestId)
    if (!pending || pending.hostId !== host.hostId) return
    this.requests.delete(reply.requestId)
    host.pending.delete(reply.requestId)
    clearTimeout(pending.timer)
    if (reply.ok) pending.resolve(reply.result)
    else pending.reject(new Error(reply.error))
  }

  /** The task a host serves — for host-scoped calls (engagement). */
  taskOf(principalKey: string | null, hostId: string): string {
    return this.requireHost(principalKey, hostId).taskId
  }

  /** Explicit tab when given, else the owner's active tab. */
  getResolvedTabId(taskId: string, tabId?: string): string | null {
    if (tabId) return tabId
    return this.ownerForActive(taskId)?.activeTabId ?? null
  }

  /** The owner's tabs (the most recently used host that has any). */
  listTabs(taskId: string): BrowserRelayTabInfo[] {
    const owner = this.hostsFor(taskId).find((h) => h.tabIds.size > 0)
    if (!owner) return []
    return [...owner.tabIds].map((id) => ({ tabId: id, active: owner.activeTabId === id }))
  }

  /** True when a live tab is registered — the "is the panel open?" probe. */
  hasTab(taskId: string, tabId?: string): boolean {
    return this.resolveHost(taskId, tabId) !== null
  }

  waitForRegistration(
    taskId: string,
    opts: { tabId?: string; timeoutMs?: number } = {}
  ): Promise<void> {
    if (this.hasTab(taskId, opts.tabId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        tabId: opts.tabId,
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
  run(taskId: string, tabId: string | null, op: BrowserRelayOp): Promise<unknown> {
    const host = this.resolveHost(taskId, tabId ?? undefined)
    if (!host) {
      return Promise.reject(
        new Error(
          `Browser tab not available (task ${taskId}${tabId ? `, tab ${tabId}` : ''}) — it may have closed.`
        )
      )
    }
    const targetTabId = tabId ?? host.activeTabId
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId)
        host.pending.delete(requestId)
        reject(new Error('The client showing this browser tab did not answer in time.'))
      }, this.requestTimeoutMs)
      this.requests.set(requestId, { hostId: host.hostId, resolve, reject, timer })
      host.pending.add(requestId)
      try {
        host.send({ type: 'request', requestId, taskId, tabId: targetTabId, ...op })
      } catch (err) {
        clearTimeout(timer)
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

  /** Hosts serving `taskId`, most recently used first. */
  private hostsFor(taskId: string): Host[] {
    return [...this.hosts.values()]
      .filter((h) => h.taskId === taskId)
      .sort((a, b) => b.usedAt - a.usedAt)
  }

  private ownerForActive(taskId: string): Host | null {
    return (
      this.hostsFor(taskId).find((h) => h.activeTabId !== null && h.tabIds.has(h.activeTabId)) ??
      null
    )
  }

  private resolveHost(taskId: string, tabId: string | undefined): Host | null {
    if (!tabId) return this.ownerForActive(taskId)
    return this.hostsFor(taskId).find((h) => h.tabIds.has(tabId)) ?? null
  }

  private settleWaiters(taskId: string): void {
    const list = this.waiters.get(taskId)
    if (!list) return
    const remaining: Waiter[] = []
    for (const w of list) {
      if (this.hasTab(taskId, w.tabId)) {
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
