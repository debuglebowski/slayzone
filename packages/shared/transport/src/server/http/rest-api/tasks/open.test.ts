/**
 * REST: POST /api/open-task/:id contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/open.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { BrowserWindow } from '../../../../../../test-utils/mock-electron.js'
import { registerOpenTaskRoute } from './open.js'

const h = await createTestHarness()

// Capture broadcasts via mock BrowserWindow → fake window with send spy.
const sent: Array<{ channel: string; args: unknown[] }> = []
let showCalled = 0
let focusCalled = 0
let restoreCalled = 0
let minimized = false

const fakeWin = {
  webContents: {
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args })
    }
  },
  isMinimized: () => minimized,
  restore: () => {
    restoreCalled++
  },
  show: () => {
    showCalled++
  },
  focus: () => {
    focusCalled++
  }
}

// Patch static methods on mock BrowserWindow.
;(BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = () => [fakeWin]

function reset(): void {
  sent.length = 0
  showCalled = 0
  focusCalled = 0
  restoreCalled = 0
  minimized = false
}

const app = express()
app.use(express.json())
registerOpenTaskRoute(app, { db: h.db, notifyRenderer: () => {} } as never)
const rest = await mountRestApp(app)

await describe('POST /api/open-task/:id', () => {
  test('foreground (no flag): broadcasts (id, false) + shows/focuses window', async () => {
    reset()
    const res = await rest.request<{ ok: boolean }>('POST', '/api/open-task/abc-123')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev).toBeTruthy()
    expect(ev!.args[0]).toBe('abc-123')
    expect(ev!.args[1]).toBe(false)
    expect(showCalled).toBe(1)
    expect(focusCalled).toBe(1)
  })

  test('foreground: restores window when minimized', async () => {
    reset()
    minimized = true
    await rest.request<{ ok: boolean }>('POST', '/api/open-task/abc-123')
    expect(restoreCalled).toBe(1)
    expect(showCalled).toBe(1)
    expect(focusCalled).toBe(1)
  })

  test('background=1: broadcasts (id, true) + does NOT show/focus', async () => {
    reset()
    const res = await rest.request<{ ok: boolean }>('POST', '/api/open-task/xyz-789?background=1')
    expect(res.status).toBe(200)
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev).toBeTruthy()
    expect(ev!.args[0]).toBe('xyz-789')
    expect(ev!.args[1]).toBe(true)
    expect(showCalled).toBe(0)
    expect(focusCalled).toBe(0)
    expect(restoreCalled).toBe(0)
  })

  test('background=true (string): also treated as background', async () => {
    reset()
    await rest.request<{ ok: boolean }>('POST', '/api/open-task/xyz-789?background=true')
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev!.args[1]).toBe(true)
    expect(focusCalled).toBe(0)
  })

  test('background=0: treated as foreground', async () => {
    reset()
    await rest.request<{ ok: boolean }>('POST', '/api/open-task/abc-123?background=0')
    const ev = sent.find((s) => s.channel === 'app:open-task')
    expect(ev!.args[1]).toBe(false)
    expect(focusCalled).toBe(1)
  })
})

await rest.close()
h.cleanup()
