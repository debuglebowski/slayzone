import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH,
  cliRoot,
  cliEnv
} from '../fixtures/electron'
import { getViewsForTask, waitForLoadComplete } from '../fixtures/browser-view'
import { getMainSessionId, waitForPtySession } from '../fixtures/terminal'
import {
  dragTo,
  layoutOf,
  openTaskWithLayout,
  panel,
  settled,
  shapeOf,
  storedLayout,
  tab
} from '../fixtures/task-layout'

// Panels survive moves between groups (docs/plans/panel-model.md step 7). Each panel
// renders once, keyed by instance id, and moving its tab only moves its DOM: the
// terminal keeps its element and session (no reconnect), the browser keeps its
// WebContentsView and page (no reload — a value set in the page is still there).

/** Agent + Settings tabs on the left; Browser + Editor tabs on the right. */
const START = layoutOf([
  { id: 'terminal', slots: [{ id: 's-agent', tabs: ['terminal', 'settings'] }] },
  { id: 'browser', slots: [{ id: 's-browser', tabs: ['browser', 'editor'] }] }
])

test.describe('Layout: panels survive moves', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let hub = ''
  let fixtureUrl = ''

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    hub = cliEnv(await cliRoot(electronApp)).SLAYZONE_HUB_ADDRESS!
    expect(hub).toBeTruthy()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-moves-'))
    const file = path.join(dir, 'moves-fixture.html')
    fs.writeFileSync(file, '<!doctype html><html><body><h1>moves</h1></body></html>')
    fixtureUrl = `file://${file}`
    const p = await seed(mainWindow).createProject({
      name: 'Moves',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  async function evalInTab(taskId: string, tabId: string, code: string): Promise<unknown> {
    const res = await fetch(`http://${hub}/api/browser/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, tabId, code })
    })
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string }
    expect(res.status, body.error).toBe(200)
    return body.result
  }

  test('a browser page and a terminal session survive a merge and a split', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, 'Moves 1', START, ['terminal'], {
      agentId: 'terminal',
      update: {
        browserTabs: {
          tabs: [{ id: 'tab-moves', url: fixtureUrl, title: 'Moves' }],
          activeTabId: 'tab-moves'
        }
      }
    })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(page, sessionId)
    await expect
      .poll(async () => (await getViewsForTask(page, taskId)).length, { timeout: 15_000 })
      .toBe(1)
    const [viewId] = await getViewsForTask(page, taskId)
    await waitForLoadComplete(page, viewId, 'moves-fixture')
    await evalInTab(taskId, 'tab-moves', 'window.__szMarker = 42')

    // Remember the DOM a remount would replace.
    await page.evaluate((sid) => {
      const root = document.querySelector('#task-panels:not([hidden])')
      const w = window as unknown as Record<string, unknown>
      const visible = (sel: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(sel)).find((el) =>
          el.closest('#task-panels')?.checkVisibility()
        ) ?? null
      w.__szBefore = {
        terminal: visible('[data-panel-id="terminal"]'),
        session: visible(`[data-session-id="${sid}"]`),
        browser: visible('[data-panel-id="browser"]')
      }
      return !!root
    }, sessionId)

    // 1. Merge the browser into the agent's group.
    await dragTo(page, tab(page, 'browser'), panel(page, 'terminal'), 0.5, 0.5)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal', 'settings', 'browser']], [['editor']]])
    await settled(page)
    // 2. Split the agent off to the right of the editor.
    await tab(page, 'terminal').click()
    await dragTo(page, tab(page, 'terminal'), panel(page, 'editor'), 0.92, 0.5)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['settings', 'browser']], [['editor']], [['terminal']]])
    await settled(page)
    await tab(page, 'browser').click()
    await expect(panel(page, 'browser')).toBeVisible()

    // Same elements: nothing remounted.
    const same = await page.evaluate((sid) => {
      const before = (window as unknown as Record<string, Record<string, Element | null>>)
        .__szBefore
      const visible = (sel: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(sel)).find((el) =>
          el.closest('#task-panels')?.checkVisibility()
        ) ?? null
      return {
        terminal: !!before.terminal && before.terminal === visible('[data-panel-id="terminal"]'),
        session: !!before.session && before.session === visible(`[data-session-id="${sid}"]`),
        browser: !!before.browser && before.browser === visible('[data-panel-id="browser"]')
      }
    }, sessionId)
    expect(same).toEqual({ terminal: true, session: true, browser: true })
    // The terminal's session is the one it had; the browser kept its view and page.
    expect(
      await page.evaluate(
        (id) => window.getTrpcVanillaClient().pty.exists.query({ sessionId: id }),
        sessionId
      )
    ).toBe(true)
    expect(await getViewsForTask(page, taskId)).toEqual([viewId])
    expect(await evalInTab(taskId, 'tab-moves', 'window.__szMarker')).toBe(42)
  })
})
