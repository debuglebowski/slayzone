/**
 * app.browser.onEvent subscription contract: on attach the server replays a
 * `state-snapshot` per live view BEFORE live events, so a renderer that
 * subscribes after createView's loadURL (the WS round-trip race) cannot strand
 * its loading overlay on missed did-navigate/dom-ready.
 */
import { EventEmitter } from 'node:events'
import { test, expect } from '../../../../test-utils/ipc-harness.js'
import { appLevelRouter } from './app.js'
import { setAppDeps, type AppDeps } from '../app-deps.js'

const browserEvents = new EventEmitter()
const snapshots = [
  { viewId: 'bv-1', type: 'state-snapshot', url: 'https://a.example/', hasLoadedRealPage: true },
  { viewId: 'bv-2', type: 'state-snapshot', url: 'about:blank', hasLoadedRealPage: false }
]

setAppDeps({
  browser: {
    events: browserEvents,
    getAllStateSnapshots: () => snapshots
  }
} as unknown as AppDeps)

const caller = appLevelRouter.createCaller({} as never)

test('browser.onEvent replays state snapshots on subscribe, then live events', async () => {
  const received: unknown[] = []
  const obs = await caller.browser.onEvent()
  const sub = obs.subscribe({ next: (e: unknown) => received.push(e) })

  // Snapshots replayed synchronously on attach, one per live view
  expect(received.length).toBe(2)
  expect((received[0] as { type: string }).type).toBe('state-snapshot')
  expect((received[0] as { viewId: string }).viewId).toBe('bv-1')
  expect((received[1] as { viewId: string }).viewId).toBe('bv-2')

  // Live events flow after the replay
  browserEvents.emit('event', { viewId: 'bv-1', type: 'did-navigate', url: 'https://b.example/' })
  expect(received.length).toBe(3)
  expect((received[2] as { type: string }).type).toBe('did-navigate')

  sub.unsubscribe()
  browserEvents.emit('event', { viewId: 'bv-1', type: 'dom-ready' })
  expect(received.length).toBe(3)
})

test('browser.onEvent with no live views replays nothing', async () => {
  snapshots.length = 0
  const received: unknown[] = []
  const obs = await caller.browser.onEvent()
  const sub = obs.subscribe({ next: (e: unknown) => received.push(e) })
  expect(received.length).toBe(0)
  sub.unsubscribe()
})
