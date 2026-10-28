/**
 * Desktop bridge — browser nav-state replay cache (`getAllStateSnapshots`).
 *
 * `app.browser.onEvent` replays the bridge's cached snapshots SYNCHRONOUSLY to every
 * new subscriber, then streams live events. Each browser tab subscribes on its own,
 * so a tab that subscribes right after a relayed `dom-ready`/`did-stop-loading` must
 * be replayed THAT state: it missed the live event, and nothing re-syncs it later —
 * a stale "loading" snapshot strands the tab's loading overlay forever, even though
 * the page finished loading long ago.
 *
 * Real wire: the desktop's `capabilityBridgeRouter` over a loopback WebSocket, a fake
 * view registry behind it, the hub's `createHostBridge` on the other end.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, describe, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'

const { capabilityBridgeRouter, setAppDeps, setMenuEvents, setPowerResumeEvents } = await import(
  '@slayzone/transport/server'
)
const { TypedEmitter } = await import('@slayzone/platform/events')
const { createHostBridge } = await import('./host-bridge.js')

type Snap = {
  viewId: string
  type: 'state-snapshot'
  url: string
  isLoading: boolean
  domReady: boolean
  hasLoadedRealPage: boolean
}

// --- Fake desktop view registry: state flips first, then the event is emitted ---
const views = new Map<string, Snap>()
const browserEvents = new EventEmitter()
let getAllCalls = 0
const snapshotOf = (viewId: string): Snap | null => {
  const s = views.get(viewId)
  return s ? { ...s } : null
}
setAppDeps({
  browser: {
    events: browserEvents,
    getAllStateSnapshots: () => {
      getAllCalls++
      return [...views.keys()].map((id) => snapshotOf(id) as Snap)
    },
    getStateSnapshot: snapshotOf,
    destroyView: (viewId: string) => {
      views.delete(viewId)
    }
  },
  floatingAgent: { events: new EventEmitter() },
  webview: { events: new EventEmitter() },
  taskWindows: { events: new EventEmitter() }
} as never)
setMenuEvents(new TypedEmitter() as never)
setPowerResumeEvents(new TypedEmitter() as never)

const hostEmit = (viewId: string, type: string, patch: Partial<Snap>): void => {
  const cur = views.get(viewId)
  if (cur) views.set(viewId, { ...cur, ...patch })
  browserEvents.emit('event', { viewId, type })
}

// --- Desktop side of the bridge -----------------------------------------------
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>((r) => wss.once('listening', () => r()))
const wssHandler = applyWSSHandler({
  wss,
  router: capabilityBridgeRouter,
  createContext: () => ({})
})
const port = (wss.address() as AddressInfo).port

const until = async (cond: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

views.set('bv-1', {
  viewId: 'bv-1',
  type: 'state-snapshot',
  url: 'https://a.example/',
  isLoading: true,
  domReady: false,
  hasLoadedRealPage: false
})

const bridge = createHostBridge(`ws://127.0.0.1:${port}`, { getTrpcPort: () => 0 })
bridge.connect()
const hubBrowser = bridge.appDeps.browser
const cached = (viewId: string): Snap | undefined =>
  (hubBrowser.getAllStateSnapshots() as Snap[]).find((s) => s.viewId === viewId)

/**
 * One full hub→desktop round trip on the bridge socket. Requests ride that socket
 * in order and the desktop answers them in order, so once this resolves, every
 * request the hub had queued BEFORE it has reached the desktop and been answered —
 * the exact sync point for "nothing the hub already asked for is still in flight".
 */
const bridgeRoundTrip = async (): Promise<void> => {
  await hubBrowser.getStateSnapshot('bv-1')
}

describe('desktop bridge: browser replay cache', () => {
  test('primes from the desktop on connect', async () => {
    await until(() => cached('bv-1') !== undefined, 'the prime')
    await until(() => browserEvents.listenerCount('event') > 0, 'the events subscription')
    expect(cached('bv-1')?.isLoading).toBe(true)
  })

  test('a subscriber attaching right after a relayed event is replayed THAT state', async () => {
    // Exactly the router's onEvent replay: attach, read the cache synchronously.
    let atStop: Snap | undefined
    const onEvent = (e: unknown): void => {
      if ((e as { type: string }).type === 'did-stop-loading') atStop = cached('bv-1')
    }
    hubBrowser.events.on('event', onEvent)
    hostEmit('bv-1', 'dom-ready', { domReady: true, hasLoadedRealPage: true })
    hostEmit('bv-1', 'did-stop-loading', { isLoading: false })
    await until(() => atStop !== undefined, 'did-stop-loading on the hub')
    hubBrowser.events.off('event', onEvent)
    expect(atStop?.isLoading).toBe(false)
    expect(atStop?.domReady).toBe(true)
    expect(atStop?.hasLoadedRealPage).toBe(true)
  })

  test('relayed events carry their own state: no desktop round-trip per event', async () => {
    // The connect-time prime can still be in flight here: `connect()` and the
    // socket's first `onOpen` each ask for one, and the second is coalesced to run
    // after the first — which is all the first test waits for. Drain it, or it lands
    // inside the window below and reads as a per-event round trip.
    await bridgeRoundTrip()
    const before = getAllCalls
    let seen = 0
    const onEvent = (e: unknown): void => {
      if ((e as { type: string }).type === 'page-title-updated') seen++
    }
    hubBrowser.events.on('event', onEvent)
    for (let i = 0; i < 5; i++) hostEmit('bv-1', 'page-title-updated', {})
    await until(() => seen === 5, 'five relayed events')
    hubBrowser.events.off('event', onEvent)
    // A re-read an event triggered is queued before that event is re-emitted, so it
    // is ahead of this round trip: once this resolves, the desktop has seen it.
    await bridgeRoundTrip()
    expect(getAllCalls, 'desktop getAllStateSnapshots calls during the relay').toBe(before)
  })

  test('a destroyed view drops out of the replay', async () => {
    views.set('bv-2', {
      viewId: 'bv-2',
      type: 'state-snapshot',
      url: 'https://b.example/',
      isLoading: true,
      domReady: false,
      hasLoadedRealPage: false
    })
    hostEmit('bv-2', 'did-start-loading', {})
    await until(() => cached('bv-2') !== undefined, 'bv-2 cached')
    views.delete('bv-2')
    hostEmit('bv-2', 'crashed', {})
    await until(() => cached('bv-2') === undefined, 'bv-2 dropped')
    expect(cached('bv-1')?.isLoading).toBe(false)
  })

  test('destroyView drops the view from the replay at once', async () => {
    views.set('bv-3', { ...(views.get('bv-1') as Snap), viewId: 'bv-3' })
    hostEmit('bv-3', 'did-start-loading', {})
    await until(() => cached('bv-3') !== undefined, 'bv-3 cached')
    const destroyed = hubBrowser.destroyView('bv-3')
    expect(cached('bv-3')).toBe(undefined)
    await destroyed
  })

  test('after a reconnect the cache re-primes and live subscribers are healed', async () => {
    const healed: Snap[] = []
    const onEvent = (e: unknown): void => {
      if ((e as Snap).type === 'state-snapshot') healed.push(e as Snap)
    }
    hubBrowser.events.on('event', onEvent)
    // Navigates while the socket is down: the desktop's state moves, its event is lost.
    views.set('bv-1', {
      ...(views.get('bv-1') as Snap),
      isLoading: true,
      url: 'https://c.example/'
    })
    for (const c of wss.clients) c.terminate()
    await until(() => cached('bv-1')?.url === 'https://c.example/', 'the re-prime')
    await until(() => healed.some((s) => s.url === 'https://c.example/'), 'the heal')
    hubBrowser.events.off('event', onEvent)
    expect(cached('bv-1')?.isLoading).toBe(true)
  })
})

describe('desktop bridge: browser engagement', () => {
  // Browser-panel input only exists on the desktop; the agent it must keep warm
  // lives in the hub (idle-close.ts listens for exactly this event).
  test('a desktop `engaged` event reaches the hub with its taskId', async () => {
    const seen: unknown[] = []
    const onEngaged = (p: unknown): void => {
      seen.push(p)
    }
    hubBrowser.events.on('engaged', onEngaged)
    await until(() => browserEvents.listenerCount('engaged') > 0, 'the engaged relay')
    browserEvents.emit('engaged', { taskId: 'task-1' })
    await until(() => seen.length === 1, 'engaged on the hub')
    hubBrowser.events.off('engaged', onEngaged)
    expect(seen).toEqual([{ taskId: 'task-1' }])
  })
})

afterAll(() => {
  bridge.dispose()
  wssHandler.broadcastReconnectNotification()
  wss.close()
})
