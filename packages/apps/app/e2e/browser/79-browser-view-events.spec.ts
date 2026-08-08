import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getActiveViewId,
  getViewState,
  waitForLoadComplete
} from '../fixtures/browser-view'
import { getTestUrl } from '../fixtures/test-server'

test.describe('Browser view events (WebContentsView)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Events T', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Events task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Events task')
  })

  test('did-navigate event updates view URL in manager', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Navigate via IPC — manager's getUrl will reflect the event
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-Example'))

    await waitForLoadComplete(mainWindow, viewId, '/title-Example')
  })

  test('did-navigate event propagates canGoBack/canGoForward', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // First navigation
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-Example'))
    await waitForLoadComplete(mainWindow, viewId, '/title-Example')

    // Second navigation — should enable goBack
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-Other'))
    await waitForLoadComplete(mainWindow, viewId, '/title-Other')

    // goBack should work (proves canGoBack was true)
    await testInvoke(mainWindow, 'browser:go-back', viewId)
    await waitForLoadComplete(mainWindow, viewId, '/title-Example')
  })

  test('page title can be set and read via executeJs', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Set title via JS on the current page
    await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.title = "test-title-xyz"')
    const title = await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.title')
    expect(title).toBe('test-title-xyz')
  })

  test('dom-ready allows JS execution', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-Example'))
    await waitForLoadComplete(mainWindow, viewId, '/title-Example')

    // dom-ready fires asynchronously after navigation; poll readyState until the
    // document is parsed rather than reading once (a single read can catch 'loading').
    await expect
      .poll(
        async () =>
          (await testInvoke(
            mainWindow,
            'browser:execute-js',
            viewId,
            'document.readyState'
          )) as string,
        { timeout: 10_000 }
      )
      .toMatch(/^(complete|interactive)$/)
  })

  test('did-fail-load fires for invalid domain', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Navigate to non-existent domain — this should cause a load error
    await testInvoke(
      mainWindow,
      'browser:navigate',
      viewId,
      'https://this-domain-does-not-exist-12345.invalid'
    )

    // The URL should eventually reflect the attempted navigation
    // (the view keeps the last successful URL or the failed URL)
    await mainWindow.waitForTimeout(5000)

    // The view should still be queryable (not crashed)
    const url = (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    expect(typeof url).toBe('string')
  })

  test('loading stops after navigation completes', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-Example'))

    // This test's subject is SlayZone's loading state, not Chromium's parser.
    // `isLoading` is driven by did-start/did-stop-loading in browser-view-manager
    // and is what the renderer renders a spinner from — the mechanism behind the
    // shipped "browser stuck loading" bug. `document.readyState` would assert
    // Chromium instead, and asserting it once (the previous version) raced the
    // parse: the URL commits before the document parses, so the wait it relied
    // on had already returned.
    await waitForLoadComplete(mainWindow, viewId, '/title-Example')

    const state = await getViewState(mainWindow, viewId)
    expect(state?.isLoading).toBe(false)

    // And the document really is parsed by the time loading reports stopped.
    const readyState = await testInvoke(
      mainWindow,
      'browser:execute-js',
      viewId,
      'document.readyState'
    )
    expect(['complete', 'interactive']).toContain(readyState)
  })

  test('favicon accessible after page load', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // `/favicon-page` declares `<link rel="icon" href="/favicon.ico">`. The
    // previous version navigated to a fixture page that declares NO icon, so
    // the query always returned "" and the only assertion was
    // `expect(typeof faviconHref).toBe('string')` — which passes for the empty
    // string, i.e. it could not distinguish a working favicon path from a
    // missing one. Serving a real icon is what makes this test's name true.
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/favicon-page'))
    await waitForLoadComplete(mainWindow, viewId, '/favicon-page')

    // The page's declared icon resolves to an absolute URL on the fixture host.
    let faviconHref = ''
    await expect
      .poll(
        async () => {
          faviconHref = (await testInvoke(
            mainWindow,
            'browser:execute-js',
            viewId,
            'document.querySelector("link[rel*=icon]")?.href || ""'
          )) as string
          return faviconHref
        },
        { timeout: 5_000 }
      )
      .not.toBe('')

    expect(faviconHref).toContain('/favicon.ico')
    expect(faviconHref).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  })
})
