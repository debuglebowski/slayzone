/**
 * `app.browserRelay` over its wire: engagement reaches idle-close by task (no mounted
 * panel needed) and decides which client `slay browser` reaches; serve binds hosts to
 * their client.
 */
import { expect, test } from 'vitest'
import type { BrowserRelayFrame } from '../shared'
import { BrowserRelay } from './browser-relay'
import { appBrowserRelayRouter, setBrowserRelayRouterDeps } from './relay-router'

const relay = new BrowserRelay()
const engaged: string[] = []
setBrowserRelayRouterDeps({ relay, onEngaged: (taskId) => engaged.push(taskId) })
const caller = appBrowserRelayRouter.createCaller({ principal: null } as never)

async function serve(taskId: string, clientKey: string) {
  const frames: BrowserRelayFrame[] = []
  const obs = await caller.serve({ taskId, clientKey })
  const sub = obs.subscribe({ next: (f: BrowserRelayFrame) => frames.push(f) })
  const hello = frames[0] as Extract<BrowserRelayFrame, { type: 'hello' }>
  return { hostId: hello.hostId, frames, stop: () => sub.unsubscribe() }
}

test('engaged touches idle-close for the task, with no panel serving it', async () => {
  await caller.engaged({ taskId: 'web-panel-only-task', clientKey: 'desk-a' })
  expect(engaged).toEqual(['web-panel-only-task'])
})

test('engaged makes that client the one slay browser reaches', async () => {
  const a = await serve('t1', 'desk-a')
  const b = await serve('t1', 'desk-b')
  await caller.sync({ hostId: a.hostId, tabIds: ['x'], activeTabId: 'x' })
  await caller.sync({ hostId: b.hostId, tabIds: ['x'], activeTabId: 'x' })
  await caller.engaged({ taskId: 't1', clientKey: 'desk-b' })
  relay.run(null, 't1', null, { op: 'getUrl' }, 'elsewhere').catch(() => {
    /* settled by the stop() below */
  })
  expect(b.frames.filter((f) => f.type === 'request')).toHaveLength(1)
  expect(a.frames.filter((f) => f.type === 'request')).toHaveLength(0)
  a.stop()
  b.stop()
})
