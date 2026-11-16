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
/** A public address (no DNS), served by a fixture handler in the isolated session. */
const PUBLIC_PAGE = 'https://93.184.216.34/'
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

    // A public web page for it, without a network: the isolated session answers https
    // to a public IP literal with a fixture (test setup only). The load itself goes the
    // real untrusted way — `slay browser navigate`, the session policy, the resolver.
    await electronApp.evaluate(({ session }) => {
      session.fromPartition('browser-tabs-isolated').protocol.handle('https', (req) =>
        req.url.endsWith('/download')
          ? new Response('x', {
              headers: {
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename=x.bin'
              }
            })
          : new Response('<!doctype html><title>public</title><body>public</body>', {
              headers: { 'content-type': 'text/html' }
            })
      )
    })
    const nav = await api(
      'POST',
      '/api/browser/navigate',
      { tabId: isoTab, url: PUBLIC_PAGE, panel: 'hidden' },
      'elsewhere'
    )
    expect(nav.status, JSON.stringify(nav.body)).toBe(200)

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
    expect(where.body.result).toBe(PUBLIC_PAGE)

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

    // No sensitive permission without a prompt (review 5 HIGH): camera/mic, MIDI SysEx,
    // clipboard read, and the permission state the page can query, all denied.
    const perms = await api<{ result?: unknown }>(
      'POST',
      '/api/browser/eval',
      {
        tabId: isoTab,
        code: `Promise.all([
          navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => 'granted', (e) => e.name),
          navigator.requestMIDIAccess({ sysex: true }).then(() => 'granted', (e) => e.name),
          ...['camera', 'microphone', 'clipboard-read', 'geolocation', 'midi', 'notifications'].map((name) =>
            navigator.permissions.query({ name }).then((s) => name + ':' + s.state, () => name + ':error')
          )
        ])`
      },
      'elsewhere'
    )
    expect(perms.status, JSON.stringify(perms.body)).toBe(200)
    const [media, midi, ...states] = perms.body.result as string[]
    expect(media).not.toBe('granted')
    expect(midi).not.toBe('granted')
    for (const s of states) expect(s).toMatch(/:(denied|error)$/)

    // Its page cannot open an address-bar-less window, nor start a download
    // (review 5 LOW): a popup becomes another isolated tab; a download is cancelled.
    const windowsBefore = await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )
    const popup = await api(
      'POST',
      '/api/browser/eval',
      {
        tabId: isoTab,
        code: `(() => {
          window.open('https://example.com/popup', 'pop', 'width=300,height=300')
          return 1
        })()`
      },
      'elsewhere'
    )
    expect(popup.status, JSON.stringify(popup.body)).toBe(200)
    await expect(mainWindow.getByTestId('browser-tab-isolated-badge')).toHaveCount(2)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(windowsBefore)
    // A download from an untrusted page is cancelled by its session (no Save dialog);
    // the user's own browser downloads as before. (Offline, no page here can produce a
    // real download — the policy allows public hosts only — so the session's own
    // handlers are asked directly.)
    const downloads = await electronApp.evaluate(({ session }) => {
      const cancels = (partition: string): boolean => {
        let prevented = false
        session
          .fromPartition(partition)
          .emit(
            'will-download',
            { preventDefault: () => (prevented = true) },
            { getFilename: () => 'x.bin', getURL: () => 'https://93.184.216.34/x.bin' },
            null
          )
        return prevented
      }
      return { isolated: cancels('browser-tabs-isolated'), own: cancels('persist:browser-tabs') }
    })
    expect(downloads).toEqual({ isolated: true, own: false })
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
    await expect(mainWindow.getByTestId('browser-tab-isolated-badge')).toHaveCount(3)
    await expect
      .poll(async () => {
        const parts: string[] = []
        for (const v of await getViewsForTask(mainWindow, taskId)) {
          parts.push((await testInvoke(mainWindow, 'browser:get-partition', v)) as string)
        }
        return parts.filter((p) => p === ISOLATED).length
      })
      .toBe(3)
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
