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
import { getViewsForTask } from '../fixtures/browser-view'
import { layoutOf, openTaskWithLayout, panel } from '../fixtures/task-layout'

// Two browser panels on one task (docs/plans/panel-model.md step 7). Every tab lives
// in the task's one flat list (`browser_tabs`), each panel showing its own
// (`byPanel`), so `slay browser --tab` reaches a tab whichever panel shows it. With no
// tab named, `slay browser` reaches the primary panel until the other one is used;
// `slay browser new` opens in the browser panel focused last. These drive the same
// REST routes the CLI calls.

const SECOND = 'browser:bbbb2222'

/** A browser panel's address bar. */
const addressBar = (page: import('@playwright/test').Page, panelId: string) =>
  panel(page, panelId).locator('input[placeholder="Enter URL..."]')

const LAYOUT = layoutOf([
  { id: 'browser', slots: [{ id: 'browser', tabs: ['browser'] }] },
  { id: 'b2', slots: [{ id: 's-b2', tabs: [SECOND] }] }
])

test.describe('Layout: two browser panels', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let hub = ''
  let urlP = ''
  let urlB = ''

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    hub = cliEnv(await cliRoot(electronApp)).SLAYZONE_HUB_ADDRESS!
    expect(hub).toBeTruthy()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-two-browsers-'))
    for (const [name, body] of [
      ['two-primary', 'primary'],
      ['two-second', 'second']
    ]) {
      fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><h1>${body}</h1>`)
    }
    urlP = `file://${path.join(dir, 'two-primary.html')}`
    urlB = `file://${path.join(dir, 'two-second.html')}`
    const p = await seed(mainWindow).createProject({
      name: 'Two browsers',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  async function api<T>(method: 'GET' | 'POST', route: string, body?: object) {
    const res = await fetch(`http://${hub}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: (await res.json()) as T }
  }

  const hrefOf = async (taskId: string, tabId?: string): Promise<string> => {
    const r = await api<{ result?: string; error?: string }>('POST', '/api/browser/eval', {
      taskId,
      ...(tabId ? { tabId } : {}),
      code: 'location.href'
    })
    expect(r.status, r.body.error).toBe(200)
    return r.body.result ?? ''
  }

  const storedTabs = async (page: import('@playwright/test').Page, taskId: string) => {
    const tasks = (await seed(page).getTasks()) as {
      id: string
      browser_tabs?: {
        tabs: { id: string }[]
        byPanel?: Record<string, { tabIds: string[] }>
      } | null
    }[]
    return tasks.find((t) => t.id === taskId)?.browser_tabs ?? null
  }

  test('--tab reaches a tab in either panel; no tab: the primary, then the panel used', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, 'Two 1', LAYOUT, ['browser', SECOND], {
      update: {
        browserTabs: {
          tabs: [
            { id: 'tab-p', url: urlP, title: 'Primary' },
            { id: 'tab-b', url: urlB, title: 'Second' }
          ],
          activeTabId: 'tab-p',
          byPanel: { [SECOND]: { tabIds: ['tab-b'], activeTabId: 'tab-b' } }
        }
      }
    })
    // One view per tab: each panel mounted its own.
    await expect
      .poll(async () => (await getViewsForTask(page, taskId)).length, { timeout: 15_000 })
      .toBe(2)

    // `slay browser tabs` lists both, both live.
    await expect
      .poll(async () => {
        const r = await api<{ tabs: { id: string; registered: boolean }[] }>(
          'GET',
          `/api/browser/tabs?taskId=${taskId}`
        )
        return r.body.tabs.map((t) => [t.id, t.registered])
      })
      .toEqual([
        ['tab-p', true],
        ['tab-b', true]
      ])

    // `--tab` reaches the tab whichever panel shows it.
    await expect.poll(() => hrefOf(taskId, 'tab-b')).toContain('two-second')
    await expect.poll(() => hrefOf(taskId, 'tab-p')).toContain('two-primary')
    // No tab named: the primary panel's active tab…
    expect(await hrefOf(taskId)).toContain('two-primary')
    // …until the other panel is used.
    // A press in its chrome (the tab is agent-locked now: its banner covers the bar).
    await addressBar(page, SECOND).dispatchEvent('pointerdown')
    await expect.poll(() => hrefOf(taskId), { timeout: 10_000 }).toContain('two-second')
  })

  test('`slay browser new` opens in the browser panel focused last', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, 'Two 2', LAYOUT, ['browser', SECOND], {
      update: {
        browserTabs: {
          tabs: [
            { id: 'tab-p2', url: urlP, title: 'Primary' },
            { id: 'tab-b2', url: urlB, title: 'Second' }
          ],
          activeTabId: 'tab-p2',
          byPanel: { [SECOND]: { tabIds: ['tab-b2'], activeTabId: 'tab-b2' } }
        }
      }
    })
    await expect
      .poll(async () => (await getViewsForTask(page, taskId)).length, { timeout: 15_000 })
      .toBe(2)
    // Focus the second panel (its address bar).
    await addressBar(page, SECOND).click()
    const r = await api<{ tabId?: string; error?: string }>('POST', '/api/browser/tabs', {
      taskId,
      url: urlP
    })
    expect(r.status, r.body.error).toBe(200)
    const newTab = r.body.tabId!
    expect(newTab).toBeTruthy()
    await expect
      .poll(async () => (await storedTabs(page, taskId))?.byPanel?.[SECOND]?.tabIds)
      .toEqual(['tab-b2', newTab])
    const stored = await storedTabs(page, taskId)
    expect(stored?.tabs.map((t) => t.id)).toContain(newTab)
    await expect.poll(() => hrefOf(taskId, newTab)).toContain('two-primary')
  })
})
