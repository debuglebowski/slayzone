/**
 * Integration PULL-sync must be started by the hub.
 *
 * THE BUG THIS PINS (silent since the slice-9 cutover): v0.35.0's Electron host started
 * `startSyncPoller` + `startDiscoveryPoller` at boot (`index.ts: linearSyncPoller =
 * startSyncPoller(db, notifyTasksChanged)`). The refactor moved push-on-edit into the hub
 * (`wireIntegrationPush`) and left a comment saying the pollers moved too — but nothing
 * ever called them. Linear/GitHub/Jira stopped pulling for every user who upgrades.
 *
 * The start functions are injected so this observes them without a provider; production
 * passes the real ones. The last test is a source guard: the failure mode was a call that
 * disappeared in a move, so the test fails if the hub's composition root stops making it.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/integrations-pollers.test.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SlayzoneDb } from '@slayzone/platform'
import { test, expect } from '../../../shared/test-utils/ipc-harness.js'
import { startIntegrationPollers } from './integrations-pollers.js'

const db = { marker: 'db' } as unknown as SlayzoneDb
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Started = { sync: unknown[]; discovery: unknown[]; ticks: { sync: number; discovery: number } }

/** Fake pollers that really tick, so `stop()` is observable as "ticking stops". */
function fakes(intervalMs = 5): {
  started: Started
  fns: Parameters<typeof startIntegrationPollers>[0]['fns']
} {
  const started: Started = { sync: [], discovery: [], ticks: { sync: 0, discovery: 0 } }
  return {
    started,
    fns: {
      startSyncPoller: (...a: unknown[]) => {
        started.sync = a
        return setInterval(() => started.ticks.sync++, intervalMs)
      },
      startDiscoveryPoller: (...a: unknown[]) => {
        started.discovery = a
        return setInterval(() => started.ticks.discovery++, intervalMs)
      }
    } as never
  }
}

test('starts the sync poller AND the discovery poller against the hub db', async () => {
  const { started, fns } = fakes()
  const handle = startIntegrationPollers({ db, notifyTasksChanged: () => {}, fns })
  expect(started.sync[0]).toBe(db)
  expect(started.discovery[0]).toBe(db)
  handle.stop()
})

test('a poller that found changes pings the UI through notifyTasksChanged', async () => {
  const { started, fns } = fakes()
  let notified = 0
  const handle = startIntegrationPollers({
    db,
    notifyTasksChanged: () => {
      notified++
    },
    fns
  })
  ;(started.sync[1] as () => void)()
  ;(started.discovery[1] as () => void)()
  expect(notified).toBe(2)
  handle.stop()
})

test('stop() halts both pollers', async () => {
  const { started, fns } = fakes()
  const handle = startIntegrationPollers({ db, notifyTasksChanged: () => {}, fns })
  await sleep(40)
  expect(started.ticks.sync > 0 && started.ticks.discovery > 0).toBe(true)
  handle.stop()
  const frozen = { ...started.ticks }
  await sleep(40)
  expect(started.ticks.sync).toBe(frozen.sync)
  expect(started.ticks.discovery).toBe(frozen.discovery)
})

test('the pollers never keep the hub process alive on their own', async () => {
  const timers: NodeJS.Timeout[] = []
  const handle = startIntegrationPollers({
    db,
    notifyTasksChanged: () => {},
    fns: {
      startSyncPoller: () => timers[timers.push(setInterval(() => {}, 60_000)) - 1],
      startDiscoveryPoller: () => timers[timers.push(setInterval(() => {}, 60_000)) - 1]
    } as never
  })
  expect(timers.length).toBe(2)
  expect(timers.every((t) => t.hasRef() === false)).toBe(true)
  handle.stop()
})

test('a poller that throws at start does not stop the other, or boot', async () => {
  const { started, fns } = fakes()
  const handle = startIntegrationPollers({
    db,
    notifyTasksChanged: () => {},
    fns: {
      ...fns,
      startSyncPoller: () => {
        throw new Error('boom')
      }
    } as never
  })
  expect(started.discovery[0]).toBe(db)
  handle.stop()
})

test('SLAYZONE_HUB_ENABLE_INTEGRATIONS=0: no poller exists, so no provider call is attempted', () => {
  const prev = process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS
  process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS = '0'
  try {
    const { started, fns } = fakes()
    const handle = startIntegrationPollers({ db, notifyTasksChanged: () => {}, fns })
    expect(started.sync.length).toBe(0)
    expect(started.discovery.length).toBe(0)
    handle.stop()
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS
    else process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS = prev
  }
})

test('the hub composition root calls startIntegrationPollers', () => {
  const src = readFileSync(fileURLToPath(new URL('./composition.ts', import.meta.url)), 'utf8')
  expect(/startIntegrationPollers\(/.test(src)).toBe(true)
})
