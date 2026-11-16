/**
 * The REST browser routes tell `slay browser` the truth:
 *  - a target the desktop will refuse from this caller (a local file, or this
 *    computer's / its private network's address, from a caller elsewhere) is refused
 *    HERE with a clear message, instead of answering ok while the panel opens blank;
 *  - the open-panel / new-tab events carry the caller's origin, so the desktop applies
 *    the same rule to the URL it loads;
 *  - with no desktop app connected for the task's owner, the error says a desktop app
 *    is needed instead of "is the panel open?" / a 10 s timeout.
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import { TypedEmitter } from '@slayzone/platform/events'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { BrowserAccess, RestApiDeps } from '../types.js'
import type { MenuEventMap } from '../../../app-deps.js'
import { registerBrowserNavigateRoute } from './navigate.js'
import { registerBrowserNewTabRoute } from './new-tab.js'
import { registerBrowserEvalRoute } from './eval.js'

let origin: 'hub-machine' | 'elsewhere' = 'elsewhere'
let capable = true
let hasTab = false
const browser: BrowserAccess = {
  originOf: () => origin,
  isDesktopLocalHub: true,
  hasCapableClient: () => capable,
  getResolvedBrowserTabId: async (_t, tabId) => tabId ?? 'tab-a',
  listBrowserTabs: async () => [],
  hasBrowserTab: async () => hasTab,
  waitForBrowserRegistration: async () => {},
  execJs: async () => 'ran',
  loadUrl: async () => {},
  getUrl: async () => 'https://a.test/',
  capturePng: async () => null
}
const menu = new TypedEmitter<MenuEventMap>()
const opened: unknown[] = []
const created: unknown[] = []
menu.on('browser-ensure-panel-open', (p) => opened.push(p))
menu.on('browser-create-tab', (p) => created.push(p))
const db = {
  prepare: () => ({ get: async () => ({ 1: 1, browser_tabs: null }), run: async () => {} })
}

const app = express()
app.use(express.json())
const deps = { browser, menu, db, notifyRenderer: () => {} } as unknown as RestApiDeps
registerBrowserNavigateRoute(app, deps)
registerBrowserNewTabRoute(app, deps)
registerBrowserEvalRoute(app, deps)
const h = await mountRestApp(app)
afterAll(() => h.close())

const reset = () => {
  origin = 'elsewhere'
  capable = true
  hasTab = false
  opened.length = 0
  created.length = 0
}

describe('targets the desktop refuses are refused with a clear message', () => {
  for (const url of [
    'file:///Users/u/.ssh/id_ed25519',
    'http://127.0.0.1:51100/health',
    'http://localhost:3000/',
    'http://192.168.1.1/'
  ]) {
    test(`navigate ${url} from elsewhere → 403, nothing opened`, async () => {
      reset()
      const res = await h.request<{ error?: string }>('POST', '/api/browser/navigate', {
        taskId: 't1',
        url
      })
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/this computer|local file/)
      expect(opened).toEqual([])
    })
    test(`new tab ${url} from elsewhere → 403, nothing created`, async () => {
      reset()
      const res = await h.request<{ error?: string }>('POST', '/api/browser/tabs', {
        taskId: 't1',
        url
      })
      expect(res.status).toBe(403)
      expect(created).toEqual([])
    })
  }

  test('a local agent on the desktop’s own hub keeps file: and localhost (main parity)', async () => {
    reset()
    origin = 'hub-machine'
    const res = await h.request('POST', '/api/browser/navigate', {
      taskId: 't1',
      url: 'file:///tmp/fixture.html'
    })
    expect(res.status).toBe(200)
    expect(opened).toEqual([
      { taskId: 't1', url: 'file:///tmp/fixture.html', tabId: undefined, origin: 'hub-machine' }
    ])
  })
})

test('open-panel and new-tab events carry the caller’s origin', async () => {
  reset()
  await h.request('POST', '/api/browser/navigate', { taskId: 't1', url: 'https://a.test/' })
  expect(opened.at(-1)).toMatchObject({ url: 'https://a.test/', origin: 'elsewhere' })
  await h.request('POST', '/api/browser/tabs', { taskId: 't1', url: 'https://a.test/' })
  expect(created.at(-1)).toMatchObject({ url: 'https://a.test/', origin: 'elsewhere' })
})

test('no desktop app connected for the owner → a clear error, not "is the panel open?"', async () => {
  reset()
  capable = false
  const res = await h.request<{ error?: string }>('POST', '/api/browser/eval', {
    taskId: 't1',
    code: '1'
  })
  expect(res.status).toBe(503)
  expect(res.body.error).toMatch(/desktop app/)
  const nav = await h.request<{ error?: string }>('POST', '/api/browser/navigate', {
    taskId: 't1',
    url: 'https://a.test/'
  })
  expect(nav.status).toBe(503)
  expect(opened).toEqual([])
})
