/**
 * An agent on another computer (a `slay browser` caller the hub sees as `elsewhere`)
 * gets its OWN isolated browser and never touches the user's (review 4 part B):
 *  - every op naming one of the user's own tabs is refused, saying why;
 *  - with no tab named it never lands on the user's active tab;
 *  - its tabs browse in the in-memory isolated partition: none of the user's cookies,
 *    no way to this machine's addresses; a tab its page opens stays isolated;
 *  - the user sees which tabs are isolated;
 *  - the user's own local agent keeps every tab, as on main.
 *
 * An `elsewhere` caller is a request that came through a proxy (`X-Forwarded-For`):
 * the hub only calls a direct loopback request `hub-machine`.
 */
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH,
  cliRoot,
  cliEnv
} from '../fixtures/electron'
import {
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask,
  testInvoke
} from '../fixtures/browser-view'

import fs from 'fs'
import os from 'os'
import path from 'path'

const ISOLATED = 'browser-tabs-isolated'
const OWN = 'persist:browser-tabs'

test.describe('Browser: an agent elsewhere gets an isolated browser', () => {
  let taskId = ''
  let hub = ''

  async function api<T>(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | null,
    from: 'elsewhere' | 'local'
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (from === 'elsewhere') headers['x-forwarded-for'] = '203.0.113.9'
    const res = await fetch(`http://${hub}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify({ taskId, ...body }) : undefined
    })
    return { status: res.status, body: (await res.json()) as T }
  }

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    hub = cliEnv(await cliRoot(electronApp)).SLAYZONE_HUB_ADDRESS!
    expect(hub).toBeTruthy()
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Isolated', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Isolated browser task',
      status: 'todo'
    })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Isolated browser task')
    await ensureBrowserPanelVisible(mainWindow)
    await expect
      .poll(async () => (await getViewsForTask(mainWindow, taskId)).length, { timeout: 10_000 })
      .toBe(1)
    // The user is signed in somewhere, in their own browser.
    await electronApp.evaluate(async ({ session }) => {
      await session
        .fromPartition('persist:browser-tabs')
        .cookies.set({ url: 'https://bank.test/', name: 'sid', value: 'users-secret' })
    })
  })

  async function ownTabId(): Promise<string> {
    const r = await api<{ tabs: Array<{ id: string; isolated: boolean }> }>(
      'GET',
      `/api/browser/tabs?taskId=${taskId}`,
      null,
      'local'
    )
    const own = r.body.tabs.find((t) => !t.isolated)
    expect(own).toBeTruthy()
    return own!.id
  }

  test('every op on the user’s own tab is refused, saying why', async () => {
    const tabId = await ownTabId()
    const q = `taskId=${taskId}&tabId=${tabId}`
    const calls: Array<[string, 'GET' | 'POST', Record<string, unknown> | null]> = [
      ['/api/browser/eval', 'POST', { tabId, code: 'document.cookie' }],
      ['/api/browser/navigate', 'POST', { tabId, url: 'https://example.com/' }],
      ['/api/browser/click', 'POST', { tabId, selector: 'a' }],
      ['/api/browser/type', 'POST', { tabId, selector: 'input', text: 'x' }],
      ['/api/browser/screenshot', 'POST', { tabId, accept: 'png-bytes' }],
      [`/api/browser/content?${q}`, 'GET', null],
      [`/api/browser/url?${q}`, 'GET', null]
    ]
    for (const [path, method, body] of calls) {
      const r = await api<{ error?: string }>(method, path, body, 'elsewhere')
      expect(r.status, path).toBe(403)
      expect(r.body.error, path).toMatch(/user's own browser.*isolated tabs/)
    }
  })

  test('naming no tab never lands on the user’s active tab', async () => {
    const r = await api<{ error?: string }>(
      'POST',
      '/api/browser/eval',
      { code: 'document.cookie', panel: 'hidden' },
      'elsewhere'
    )
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/isolated/)
  })

  test('its new tab is isolated: own partition, no user cookies, no way to this machine', async ({
    electronApp,
    mainWindow
  }) => {
    const created = await api<{ ok?: boolean; tabId?: string }>(
      'POST',
      '/api/browser/tabs',
      {},
      'elsewhere'
    )
    expect(created.status).toBe(200)
    const isoTab = created.body.tabId!

    // The user sees it as isolated.
    await expect(mainWindow.getByTestId('browser-tab-isolated-badge')).toHaveCount(1)

    // It lives in the isolated partition; the user's tab in their own.
    const partitions = async (): Promise<string[]> => {
      const out: string[] = []
      for (const v of await getViewsForTask(mainWindow, taskId)) {
        out.push((await testInvoke(mainWindow, 'browser:get-partition', v)) as string)
      }
      return out.sort()
    }
    await expect.poll(partitions).toEqual([ISOLATED, OWN].sort())
    const cookies = await electronApp.evaluate(async ({ session }) => ({
      isolated: (await session.fromPartition('browser-tabs-isolated').cookies.get({})).length,
      own: (await session.fromPartition('persist:browser-tabs').cookies.get({ name: 'sid' })).length
    }))
    expect(cookies).toEqual({ isolated: 0, own: 1 })

    // A view that never navigated has no document to run script in: give it one
    // (test setup — this suite has no public web server to send it to).
    await electronApp.evaluate(async ({ session, webContents }) => {
      const iso = session.fromPartition('browser-tabs-isolated')
      for (const wc of webContents.getAllWebContents()) {
        if (wc.session === iso) await wc.loadURL('about:blank')
      }
    })

    // The caller only sees its isolated tab, and with no tab named reaches it.
    const listed = await api<{ tabs: Array<{ id: string }> }>(
      'GET',
      `/api/browser/tabs?taskId=${taskId}`,
      null,
      'elsewhere'
    )
    expect(listed.body.tabs.map((t) => t.id)).toEqual([isoTab])
    const where = await api<{ result?: unknown }>(
      'POST',
      '/api/browser/eval',
      { code: 'location.href' },
      'elsewhere'
    )
    expect(where.status, JSON.stringify(where.body)).toBe(200)
    expect(where.body.result).toBe('about:blank')

    // This machine's addresses are out of reach from its page (the hub included).
    const reach = await api<{ result?: unknown }>(
      'POST',
      '/api/browser/eval',
      {
        tabId: isoTab,
        code: `fetch('http://${hub}/health').then(() => 'reached', () => 'blocked')`
      },
      'elsewhere'
    )
    expect(reach.body.result).toBe('blocked')
  })

  test('a tab its page opens stays isolated', async ({ mainWindow }) => {
    let isoView = ''
    for (const v of await getViewsForTask(mainWindow, taskId)) {
      if ((await testInvoke(mainWindow, 'browser:get-partition', v)) === ISOLATED) isoView = v
    }
    expect(isoView).toBeTruthy()
    const handled = await testInvoke(
      mainWindow,
      'browser:test-run-link-context-menu-action',
      isoView,
      { linkURL: 'https://example.com/opened', linkText: 'opened' },
      'open-link-in-new-tab'
    )
    expect(handled).toBe(true)
    await expect(mainWindow.getByTestId('browser-tab-isolated-badge')).toHaveCount(2)
    await expect
      .poll(async () => {
        const parts: string[] = []
        for (const v of await getViewsForTask(mainWindow, taskId)) {
          parts.push((await testInvoke(mainWindow, 'browser:get-partition', v)) as string)
        }
        return parts.filter((p) => p === ISOLATED).length
      })
      .toBe(2)
  })

  test('the user’s own local agent keeps every tab, as on main', async () => {
    const tabId = await ownTabId()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-isolated-'))
    const file = path.join(dir, 'own.html')
    fs.writeFileSync(file, '<!doctype html><h1>own</h1>')
    const nav = await api(
      'POST',
      '/api/browser/navigate',
      { tabId, url: `file://${file}`, panel: 'hidden' },
      'local'
    )
    expect(nav.status, JSON.stringify(nav.body)).toBe(200)
    const r = await api<{ ok?: boolean }>(
      'POST',
      '/api/browser/eval',
      { tabId, code: '1 + 1' },
      'local'
    )
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, result: 2 })
  })
})
