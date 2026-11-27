import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  layoutOf,
  openTaskWithLayout,
  panel,
  storedLayout,
  strip,
  tab
} from '../fixtures/task-layout'

// Web page panels (docs/plans/panel-model.md step 12): one static URL, no address
// bar. ⋯ → Web page adds one that asks for its URL in the panel; "Edit URL" in its
// header or its tab menu changes it. Nothing listens on the loopback ports used, so
// no page has to load: what is checked is what the panel stores and shows.

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const PAGE_ID = 'web:aaaa1111'

/** A web page sharing a tab strip with Settings (so its tab, and tab menu, show). */
const WITH_PAGE = layoutOf(
  [
    { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
    { id: 'mid', slots: [{ id: 's-mid', tabs: ['settings', PAGE_ID], active: PAGE_ID }] }
  ],
  { [PAGE_ID]: { url: 'http://localhost:9/' } }
)

type Instances = Record<string, { kind: string; settings: Record<string, unknown> }>

async function instances(page: Page, taskId: string): Promise<Instances> {
  return ((await storedLayout(page, taskId))?.instances ?? {}) as Instances
}

async function webPages(page: Page, taskId: string): Promise<[string, string | undefined][]> {
  return Object.entries(await instances(page, taskId))
    .filter(([, i]) => i.kind === 'web' && 'url' in i.settings)
    .map(([id, i]) => [id, i.settings.url as string | undefined])
}

const toggles = (page: Page): Locator => page.locator('[data-testid="panel-toggles"]:visible')

test.describe('Web page panels', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Web pages',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('⋯ → Web page asks for its URL, then shows it; the header edits it', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, `Web page ${++n}`, CLASSIC, [
      'terminal',
      'settings'
    ])
    await page.locator('[data-testid="new-panel-menu"]:visible').click()
    await page.getByTestId('new-panel-web-page').click()

    await expect.poll(() => webPages(page, taskId)).toHaveLength(1)
    const [[id, url]] = await webPages(page, taskId)
    expect(id).toMatch(/^web:[0-9a-f]{8}$/)
    expect(url).toBe('')
    const pagePanel = panel(page, id)
    const prompt = pagePanel.getByTestId('web-page-prompt')
    await expect(prompt).toBeVisible()

    // Not a URL: no Open.
    await prompt.getByTestId('web-page-url-input').fill('hello')
    await expect(prompt.getByTestId('web-page-url-submit')).toBeDisabled()
    await prompt.getByTestId('web-page-url-input').fill('localhost:9')
    await prompt.getByTestId('web-page-url-submit').click()

    await expect.poll(() => webPages(page, taskId)).toEqual([[id, 'http://localhost:9/']])
    await expect(prompt).toBeHidden()
    // Named after its host, with no address bar of its own to type in.
    await expect(
      toggles(page).getByRole('button', { name: 'localhost:9', exact: true })
    ).toBeVisible()
    await expect(pagePanel.getByRole('textbox')).toHaveCount(0)

    await pagePanel.getByTestId('web-page-edit-url').click()
    const dialog = page.getByTestId('web-page-url-dialog')
    await expect(dialog.getByTestId('web-page-edit-url-input')).toHaveValue('http://localhost:9/')
    await dialog.getByTestId('web-page-edit-url-input').fill('localhost:8/status')
    await dialog.getByTestId('web-page-edit-url-submit').click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => webPages(page, taskId)).toEqual([[id, 'http://localhost:8/status']])
    await expect(
      toggles(page).getByRole('button', { name: 'localhost:8', exact: true })
    ).toBeVisible()
  })

  test('the tab menu edits a web page’s URL; New Web page panel adds another', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, `Web page ${++n}`, WITH_PAGE, [
      'terminal',
      PAGE_ID
    ])
    await expect(tab(page, PAGE_ID)).toHaveText(/localhost:9/)

    await tab(page, PAGE_ID).click({ button: 'right' })
    await page.getByTestId('panel-tab-edit-url').click()
    const dialog = page.getByTestId('web-page-url-dialog')
    await dialog.getByTestId('web-page-edit-url-input').fill('127.0.0.1:7/app')
    await dialog.getByTestId('web-page-edit-url-submit').click()
    await expect
      .poll(async () => (await instances(page, taskId))[PAGE_ID]?.settings.url)
      .toBe('http://127.0.0.1:7/app')
    await expect(tab(page, PAGE_ID)).toHaveText(/127\.0\.0\.1:7/)

    // "New Web page panel" adds a fresh page (asking for its URL) to the same group.
    await tab(page, PAGE_ID).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New Web page panel' }).click()
    await expect.poll(() => webPages(page, taskId).then((p) => p.length)).toBe(2)
    const fresh = (await webPages(page, taskId)).find(([pid]) => pid !== PAGE_ID)
    if (!fresh) throw new Error('no new web page')
    expect(fresh[1]).toBe('')
    await expect(
      strip(page).locator(`[data-tabstrip="s-mid"] [data-panel-tab="${fresh[0]}"]`)
    ).toBeVisible()
  })
})
