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
let principal: string | null = null
let capable = true
let hasTab = false
const loaded: Array<{ caller: unknown; taskId: string; tabId: string | null; url: string }> = []
let loadError: Error | null = null
const browser: BrowserAccess = {
  callerOf: () => ({ origin, principal }),
  isDesktopLocalHub: true,
  hasCapableClient: () => capable,
  getResolvedBrowserTabId: async (_c, _t, tabId) => tabId ?? 'tab-a',
  listBrowserTabs: async () => [],
  hasBrowserTab: async () => hasTab,
  waitForBrowserRegistration: async () => {},
  execJs: async () => 'ran',
  loadUrl: async (caller, taskId, tabId, url) => {
    loaded.push({ caller, taskId, tabId, url })
    if (loadError) throw loadError
  },
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
  principal = null
  capable = true
  hasTab = false
  opened.length = 0
  created.length = 0
  loaded.length = 0
  loadError = null
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
      {
        taskId: 't1',
        url: 'file:///tmp/fixture.html',
        tabId: undefined,
        origin: 'hub-machine',
        principal: null
      }
    ])
  })
})

test('open-panel and new-tab events carry the caller’s origin', async () => {
  reset()
  await h.request('POST', '/api/browser/navigate', { taskId: 't1', url: 'https://a.test/' })
  expect(opened.at(-1)).toMatchObject({ origin: 'elsewhere' })
  await h.request('POST', '/api/browser/tabs', { taskId: 't1', url: 'https://a.test/' })
  expect(created.at(-1)).toMatchObject({ origin: 'elsewhere' })
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

test('open-panel and new-tab events name the requesting user, so only their clients act', async () => {
  reset()
  principal = 'bob'
  await h.request('POST', '/api/browser/navigate', { taskId: 't1', url: 'https://a.test/' })
  expect(opened.at(-1)).toMatchObject({ principal: 'bob' })
  await h.request('POST', '/api/browser/tabs', { taskId: 't1', url: 'https://a.test/' })
  expect(opened.at(-1)).toMatchObject({ principal: 'bob' })
  expect(created.at(-1)).toMatchObject({ principal: 'bob' })
})

describe("an untrusted caller's URL reaches the desktop only through the DNS-checked load (review 4)", () => {
  test('new tab: created blank, then loaded through the relay; a refusal is reported', async () => {
    reset()
    const res = await h.request<{ ok?: boolean; tabId?: string }>('POST', '/api/browser/tabs', {
      taskId: 't1',
      url: 'http://10.0.0.1.nip.io/'
    })
    expect(res.status).toBe(200)
    expect(created.at(-1)).toMatchObject({ url: undefined })
    expect(loaded).toEqual([
      {
        caller: { origin: 'elsewhere', principal: null },
        taskId: 't1',
        tabId: res.body.tabId,
        url: 'http://10.0.0.1.nip.io/'
      }
    ])
    loadError = new Error('That address is on this computer or its private network')
    const refused = await h.request<{ error?: string }>('POST', '/api/browser/tabs', {
      taskId: 't1',
      url: 'http://10.0.0.1.nip.io/'
    })
    expect(refused.status).toBe(500)
    expect(refused.body.error).toMatch(/private network/)
  })
  test('navigate that opens the panel: opened without the URL, then loaded through the relay', async () => {
    reset()
    const res = await h.request('POST', '/api/browser/navigate', {
      taskId: 't1',
      url: 'http://10.0.0.1.nip.io/'
    })
    expect(res.status).toBe(200)
    expect(opened.at(-1)).toMatchObject({ url: undefined })
    expect(loaded.map((l) => l.url)).toEqual(['http://10.0.0.1.nip.io/'])
  })
  test("the desktop's own local agent keeps the direct open (no second load)", async () => {
    reset()
    origin = 'hub-machine'
    await h.request('POST', '/api/browser/tabs', { taskId: 't1', url: 'http://localhost:3000/' })
    expect(created.at(-1)).toMatchObject({ url: 'http://localhost:3000/' })
    await h.request('POST', '/api/browser/navigate', {
      taskId: 't1',
      url: 'http://localhost:3000/'
    })
    expect(opened.at(-1)).toMatchObject({ url: 'http://localhost:3000/' })
    expect(loaded).toEqual([])
  })
})
