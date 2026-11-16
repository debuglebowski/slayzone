/**
 * A REMOTE hub's web panels (review 6 F1). Its operator or an agent on it picks a
 * panel's URL (`POST /api/panels`), so its pages are untrusted: they get the hub's own
 * web-panel partition under the untrusted session policy — no permission without a
 * prompt, no way to this machine's addresses, no app protocols — never the desktop's
 * shared, trusted `persist:web-panels` (which stays as it is for the local hub).
 *
 * The view is created the way `WebPanelView` creates one; the page is served into the
 * session by a fixture at a public IP literal (no network needed).
 */
import { test, expect, resetApp } from '../fixtures/electron'
import { getTestUrl } from '../fixtures/test-server'

/** `browserPartitionForHub('hub:https://a.example.com', false)`: the user's OWN tabs. */
const REMOTE_USER_TABS = 'persist:browser-tabs-hub-3f2d202f-a-example-com'
/** `webPanelPartitionForHub('hub:https://a.example.com', false)`. */
const REMOTE_WEB_PANELS = 'persist:web-panels-hub-3f2d202f-a-example-com'
const LOCAL_WEB_PANELS = 'persist:web-panels'
const PUBLIC_PAGE = 'https://93.184.216.34/'

const QUERY = `Promise.all(
  ['camera', 'microphone', 'clipboard-read', 'geolocation', 'notifications'].map((name) =>
    navigator.permissions.query({ name }).then((s) => name + ':' + s.state, () => name + ':error')
  )
)`
const PROBE = `Promise.all([
  navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => 'gum:granted', (e) => 'gum:' + e.name),
  ${QUERY}
]).then(([gum, states]) => [gum, ...states])`

test.describe('Web panels of a remote hub are untrusted', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  async function openPanelPage(
    mainWindow: import('@playwright/test').Page,
    electronApp: import('@playwright/test').ElectronApplication,
    partition: string
  ): Promise<{ viewId: string; wcId: number }> {
    const viewId = (await mainWindow.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { browserHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
          }
        ).api.browserHost.invoke('view.create', [
          {
            taskId: 'web-panel-partition-e2e',
            tabId: `wp-${p}`,
            partition: p,
            url: 'about:blank',
            kind: 'web-panel',
            bounds: { x: 0, y: 0, width: 10, height: 10 }
          }
        ]),
      partition
    )) as string
    expect(viewId).toBeTruthy()
    const wcId = (await mainWindow.evaluate(
      (id) =>
        (
          window as unknown as {
            api: { browserHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
          }
        ).api.browserHost.invoke('view.getWebContentsId', [id]),
      viewId
    )) as number
    await electronApp.evaluate(
      async ({ session, webContents }, { p, id, url }) => {
        const s = session.fromPartition(p)
        if (!s.protocol.isProtocolHandled('https')) {
          s.protocol.handle(
            'https',
            () =>
              new Response('<!doctype html><title>panel</title>', {
                headers: { 'content-type': 'text/html' }
              })
          )
        }
        await webContents.fromId(id)!.loadURL(url)
      },
      { p: partition, id: wcId, url: PUBLIC_PAGE }
    )
    return { viewId, wcId }
  }

  const run = (
    electronApp: import('@playwright/test').ElectronApplication,
    wcId: number,
    code: string
  ): Promise<unknown> =>
    electronApp.evaluate(
      ({ webContents }, { id, c }) => webContents.fromId(id)!.executeJavaScript(c),
      { id: wcId, c: code }
    )

  test('no permission without a prompt; no way to this machine', async ({
    mainWindow,
    electronApp
  }) => {
    const { wcId } = await openPanelPage(mainWindow, electronApp, REMOTE_WEB_PANELS)
    const results = (await run(electronApp, wcId, PROBE)) as string[]
    expect(results[0]).not.toBe('gum:granted')
    for (const r of results.slice(1)) expect(r).toMatch(/:(denied|error)$/)
    const hub = (await electronApp.evaluate(
      () => (globalThis as Record<string, unknown>).__serverPort
    )) as number
    expect(
      await run(
        electronApp,
        wcId,
        `fetch('http://127.0.0.1:${hub}/health').then(() => 'reached', () => 'blocked')`
      )
    ).toBe('blocked')
    expect(
      await run(
        electronApp,
        wcId,
        `fetch('slz-file:///etc/hosts').then(() => 'reached', () => 'blocked')`
      )
    ).toBe('blocked')
  })

  test('the local hub’s web panels keep their session as before', async ({
    mainWindow,
    electronApp
  }) => {
    const { wcId } = await openPanelPage(mainWindow, electronApp, LOCAL_WEB_PANELS)
    // Only the permission STATE: no capture is started in the user's own session.
    const states = (await run(electronApp, wcId, QUERY)) as string[]
    expect(states).toContain('camera:granted')
  })
})

test.describe('The user’s own tab on a remote hub reaches this machine on the user’s act only', () => {
  const invoke = (mainWindow: import('@playwright/test').Page, m: string, a: unknown[]) =>
    mainWindow.evaluate(
      ({ m, a }) =>
        (
          window as unknown as {
            api: { browserHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
          }
        ).api.browserHost.invoke(m, a),
      { m, a }
    )

  test('a load nobody asked for is blocked; the user typing the address opens it', async ({
    mainWindow,
    electronApp
  }) => {
    const local = await getTestUrl('/')
    const viewId = (await invoke(mainWindow, 'view.create', [
      {
        taskId: 'remote-user-tab-e2e',
        tabId: 'remote-user-tab',
        partition: REMOTE_USER_TABS,
        url: 'about:blank',
        kind: 'browser-tab',
        bounds: { x: 0, y: 0, width: 10, height: 10 }
      }
    ])) as string
    const wcId = (await invoke(mainWindow, 'view.getWebContentsId', [viewId])) as number

    // Not the user: a page or the hub loading a local address.
    const quiet = await electronApp.evaluate(
      ({ webContents }, { id, url }) =>
        webContents
          .fromId(id)!
          .loadURL(url)
          .then(
            () => 'loaded',
            () => 'blocked'
          ),
      { id: wcId, url: local }
    )
    expect(quiet).toBe('blocked')

    // The user types it in the address bar.
    await invoke(mainWindow, 'view.navigate', [viewId, local])
    await expect
      .poll(() =>
        electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), wcId)
      )
      .toBe(local)
    await invoke(mainWindow, 'view.destroy', [viewId])
  })
})
