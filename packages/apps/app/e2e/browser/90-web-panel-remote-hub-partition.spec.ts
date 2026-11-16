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

/**
 * Follow-ups N1–N3 to review 7, in a real remote-user-partition view. Each case reads
 * the main-frame outcome off the web contents itself: `did-fail-load` (the network
 * policy cancelled it) or `did-finish-load` (loaded).
 */
test.describe('The user’s own remote-hub tab: what counts as the user’s act', () => {
  type Invoke = (m: string, a: unknown[]) => Promise<unknown>
  const invokeIn =
    (mainWindow: import('@playwright/test').Page): Invoke =>
    (m, a) =>
      mainWindow.evaluate(
        ({ m, a }) =>
          (
            window as unknown as {
              api: { browserHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
            }
          ).api.browserHost.invoke(m, a),
        { m, a }
      )

  /** A public page (served into the session at a public IP literal): `?html=` is its body. */
  const publicPage = (html: string): string =>
    `https://93.184.216.34/page?html=${encodeURIComponent(html)}`

  async function openUserTab(
    mainWindow: import('@playwright/test').Page,
    electronApp: import('@playwright/test').ElectronApplication,
    name: string
  ): Promise<{ viewId: string; wcId: number }> {
    const invoke = invokeIn(mainWindow)
    const viewId = (await invoke('view.create', [
      {
        taskId: 'remote-user-tab-acts-e2e',
        tabId: `remote-user-${name}`,
        partition: REMOTE_USER_TABS,
        url: 'about:blank',
        kind: 'browser-tab',
        bounds: { x: 0, y: 0, width: 400, height: 300 }
      }
    ])) as string
    const wcId = (await invoke('view.getWebContentsId', [viewId])) as number
    await electronApp.evaluate(({ session }, p) => {
      const s = session.fromPartition(p)
      if (s.protocol.isProtocolHandled('https')) return
      s.protocol.handle('https', (request) => {
        const html = new URL(request.url).searchParams.get('html') ?? ''
        return new Response(`<!doctype html><title>public</title><body>${html}</body>`, {
          headers: { 'content-type': 'text/html' }
        })
      })
    }, REMOTE_USER_TABS)
    return { viewId, wcId }
  }

  /** Runs `trigger`, then reports how the tab's next main-frame load ended. A blocked
   *  load resolves only once its error page has finished too, so that page's own
   *  `did-finish-load` never leaks into the next outcome. */
  async function outcome(
    electronApp: import('@playwright/test').ElectronApplication,
    wcId: number,
    trigger: () => Promise<unknown>
  ): Promise<string> {
    await electronApp.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)!
      ;(globalThis as Record<string, unknown>).__navOutcome = new Promise<string>((resolve) => {
        let blocked: string | null = null
        let timer = setTimeout(() => finish('timeout'), 10_000)
        const fail = (
          _e: unknown,
          code: number,
          _d: string,
          _u: string,
          isMainFrame: boolean
        ): void => {
          if (!isMainFrame || code === -3 || blocked) return
          blocked = `blocked:${code}`
          clearTimeout(timer)
          timer = setTimeout(() => finish(blocked!), 3_000)
        }
        const ok = (): void => finish(blocked ?? `loaded:${wc.getURL()}`)
        const stopped = (): void => {
          if (blocked) finish(blocked)
        }
        function finish(r: string): void {
          clearTimeout(timer)
          wc.off('did-fail-load', fail)
          wc.off('did-finish-load', ok)
          wc.off('did-stop-loading', stopped)
          resolve(r)
        }
        wc.on('did-fail-load', fail)
        wc.on('did-finish-load', ok)
        wc.on('did-stop-loading', stopped)
      })
    }, wcId)
    await trigger()
    return (await electronApp.evaluate(
      () => (globalThis as Record<string, unknown>).__navOutcome
    )) as string
  }

  const loadFromMain = (
    electronApp: import('@playwright/test').ElectronApplication,
    wcId: number,
    url: string
  ) =>
    electronApp.evaluate(
      ({ webContents }, { id, url }) =>
        webContents
          .fromId(id)!
          .loadURL(url)
          .catch(() => undefined),
      { id: wcId, url }
    )
  const pageRuns = (
    electronApp: import('@playwright/test').ElectronApplication,
    wcId: number,
    code: string
  ) =>
    electronApp.evaluate(
      ({ webContents }, { id, c }) => {
        void webContents
          .fromId(id)!
          .executeJavaScript(c)
          .catch(() => undefined)
      },
      { id: wcId, c: code }
    )
  const click = (
    electronApp: import('@playwright/test').ElectronApplication,
    wcId: number,
    x: number,
    y: number
  ) =>
    electronApp.evaluate(
      ({ webContents }, { id, x, y }) => {
        const wc = webContents.fromId(id)!
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      },
      { id: wcId, x, y }
    )

  test('N1: a local page the user opened follows its own redirect, reloads, navigates and posts to itself', async ({
    mainWindow,
    electronApp
  }) => {
    const invoke = invokeIn(mainWindow)
    const base = (await getTestUrl('/')).replace(/\/$/, '')
    const { viewId, wcId } = await openUserTab(mainWindow, electronApp, 'n1')

    // Typed: `/redirect` answers 302 → `/title-after-redirect`.
    expect(
      await outcome(electronApp, wcId, () =>
        invoke('view.navigate', [viewId, `${base}/redirect?to=/title-after-redirect`])
      )
    ).toBe(`loaded:${base}/title-after-redirect`)
    // The page reloads itself (a dev server's full reload), no input.
    expect(
      await outcome(electronApp, wcId, () => pageRuns(electronApp, wcId, 'location.reload()'))
    ).toBe(`loaded:${base}/title-after-redirect`)
    // In-app navigation, later, no input.
    await new Promise((r) => setTimeout(r, 5_500))
    expect(
      await outcome(electronApp, wcId, () =>
        pageRuns(electronApp, wcId, `location.href = '/title-in-app'`)
      )
    ).toBe(`loaded:${base}/title-in-app`)
    // Its own form posts to itself.
    expect(
      await outcome(electronApp, wcId, () =>
        pageRuns(
          electronApp,
          wcId,
          `const f = document.createElement('form'); f.method = 'post'; f.action = '/title-posted'; document.body.append(f); f.submit()`
        )
      )
    ).toBe(`loaded:${base}/title-posted`)
    // But not to another local address by itself.
    const other = base.replace('127.0.0.1', 'localhost')
    expect(
      await outcome(electronApp, wcId, () =>
        pageRuns(electronApp, wcId, `location.href = '${other}/title-other'`)
      )
    ).toMatch(/^blocked:/)
    await invoke('view.destroy', [viewId])
  })

  test('N2: input on a public page lets it reach no local address; a click on the link does', async ({
    mainWindow,
    electronApp
  }) => {
    const invoke = invokeIn(mainWindow)
    const base = (await getTestUrl('/')).replace(/\/$/, '')
    const { viewId, wcId } = await openUserTab(mainWindow, electronApp, 'n2')
    const page = publicPage(
      `<a id="l" href="${base}/title-clicked" style="position:fixed;left:0;top:0;width:200px;height:100px;display:block">open</a>`
    )
    const freshPublicPage = async () =>
      expect(await outcome(electronApp, wcId, () => loadFromMain(electronApp, wcId, page))).toBe(
        `loaded:${page}`
      )

    // The user clicks the page (not a link); right after, the page POSTs to this machine.
    await freshPublicPage()
    await click(electronApp, wcId, 300, 250)
    expect(
      await outcome(electronApp, wcId, () =>
        pageRuns(
          electronApp,
          wcId,
          `const f = document.createElement('form'); f.method = 'post'; f.action = '${base}/title-csrf'; document.body.append(f); f.submit()`
        )
      )
    ).toMatch(/^blocked:/)
    // … or navigates there by GET.
    await freshPublicPage()
    await click(electronApp, wcId, 300, 250)
    expect(
      await outcome(electronApp, wcId, () =>
        pageRuns(electronApp, wcId, `location.href = '${base}/title-self'`)
      )
    ).toMatch(/^blocked:/)
    // The user clicks the local link itself: it opens.
    await freshPublicPage()
    expect(await outcome(electronApp, wcId, () => click(electronApp, wcId, 50, 50))).toBe(
      `loaded:${base}/title-clicked`
    )
    await invoke('view.destroy', [viewId])
  })

  test('N3: a reload the hub asks for opens no planted local URL; the user’s own reload does', async ({
    mainWindow,
    electronApp
  }) => {
    const invoke = invokeIn(mainWindow)
    const local = await getTestUrl('/title-planted')
    const first = await openUserTab(mainWindow, electronApp, 'n3')
    let viewId = first.viewId
    const wcId = first.wcId

    // Planted (not the user): blocked.
    expect(await outcome(electronApp, wcId, () => loadFromMain(electronApp, wcId, local))).toMatch(
      /^blocked:/
    )
    // The hub's `reload-browser` event reaches the renderer as an app-shortcut reload,
    // with no shortcut main itself saw: still blocked.
    expect(
      await outcome(electronApp, wcId, () => invoke('view.reload', [viewId, false, 'shortcut']))
    ).toMatch(/^blocked:/)
    // The user presses the reload shortcut in the tab (main sees it).
    const mod: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'
    expect(
      await outcome(electronApp, wcId, () =>
        electronApp.evaluate(
          ({ webContents }, { id, mod }) => {
            webContents
              .fromId(id)!
              .sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: [mod] })
          },
          { id: wcId, mod }
        )
      )
    ).toBe(`loaded:${local}`)
    await invoke('view.destroy', [viewId])

    // Planted in a fresh tab; the panel's own reload button.
    const fresh = await openUserTab(mainWindow, electronApp, 'n3b')
    expect(
      await outcome(electronApp, fresh.wcId, () => loadFromMain(electronApp, fresh.wcId, local))
    ).toMatch(/^blocked:/)
    expect(
      await outcome(electronApp, fresh.wcId, () =>
        invoke('view.reload', [fresh.viewId, false, 'panel'])
      )
    ).toBe(`loaded:${local}`)
    viewId = fresh.viewId
    await invoke('view.destroy', [viewId])
  })
})
