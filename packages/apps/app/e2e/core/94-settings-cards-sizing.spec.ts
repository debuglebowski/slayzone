import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page, Locator } from '@playwright/test'

// --- Helpers ---

const settingsPanel = (page: Page): Locator =>
  page.getByTestId('task-settings-panel').last()

const descriptionCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-description-card')

const subtasksCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-subtasks-card')

const assetsCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-assets-card')

const cardsGrid = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-cards-grid')

async function cardHeight(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  return box?.height ?? 0
}

async function cardState(locator: Locator): Promise<'open' | 'closed'> {
  const state = await locator.getAttribute('data-state')
  return state === 'open' ? 'open' : 'closed'
}

async function setCardOpen(card: Locator, open: boolean) {
  const current = await cardState(card)
  const want = open ? 'open' : 'closed'
  if (current === want) return
  await card.locator('button').first().click()
  await expect(card).toHaveAttribute('data-state', want, { timeout: 2_000 })
}

async function createSubtasks(page: Page, parentId: string, projectId: string, count: number) {
  await page.evaluate(
    async ({ parentId, projectId, count }) => {
      for (let i = 0; i < count; i += 1) {
        await window.api.db.createTask({
          projectId,
          parentId,
          title: `Subtask ${i + 1}`,
          status: 'todo',
        })
      }
    },
    { parentId, projectId, count },
  )
  await page.evaluate(async () => {
    await (window as unknown as { __slayzone_refreshData?: () => Promise<void> }).__slayzone_refreshData?.()
    await new Promise(r => setTimeout(r, 100))
  })
}

async function clearSubtasks(page: Page, parentId: string) {
  await page.evaluate(async (pid) => {
    const subs = await window.api.db.getSubTasks(pid)
    for (const s of subs) await window.api.db.deleteTask(s.id)
  }, parentId)
  await page.evaluate(async () => {
    await (window as unknown as { __slayzone_refreshData?: () => Promise<void> }).__slayzone_refreshData?.()
    await new Promise(r => setTimeout(r, 100))
  })
}

// --- Tests ---

test.describe('Settings panel card sizing', () => {
  let projectAbbrev: string
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CardSize Test', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Card sizing task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Card sizing task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Card sizing task').first().click()
    await expect(settingsPanel(mainWindow)).toBeVisible({ timeout: 5_000 })
  })

  test.beforeEach(async ({ mainWindow }) => {
    // Reset state: clear subtasks, ensure cards start in known state
    await clearSubtasks(mainWindow, taskId)
  })

  test('all cards closed: each card is roughly header-height', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(assetsCard(mainWindow), false)

    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(assetsCard(mainWindow))).toBeLessThan(60)
  })

  test('only subtasks open + 0 subtasks: subtasks card is small (content-sized)', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(assetsCard(mainWindow), false)

    // Just header + "Add subtask" button
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(120)
    // Closed peers stay small
    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(assetsCard(mainWindow))).toBeLessThan(60)
  })

  test('only subtasks open + 25 subtasks: card caps at share, does not overflow grid', async ({ mainWindow }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(assetsCard(mainWindow), false)

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))

    // Card should be substantial (much more than header-only)
    expect(subH).toBeGreaterThan(150)
    // Card should not exceed grid height
    expect(subH).toBeLessThanOrEqual(gridH + 1)
  })

  test('all open + 25 subtasks: subtasks caps, description + assets stay content-sized', async ({ mainWindow }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(assetsCard(mainWindow), true)

    const descH = await cardHeight(descriptionCard(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))
    const assetsH = await cardHeight(assetsCard(mainWindow))

    // Subtasks should be much bigger than both other cards
    expect(subH).toBeGreaterThan(descH)
    expect(subH).toBeGreaterThan(assetsH)
    // Description + assets stay small (content-sized — empty editor + "Add asset" button)
    expect(assetsH).toBeLessThan(120)
  })

  test('all open + empty: cards are content-sized, total < grid', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(assetsCard(mainWindow), true)

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))
    const assetsH = await cardHeight(assetsCard(mainWindow))

    // Three small cards + two gaps should be well under grid height (leftover at bottom)
    const total = descH + subH + assetsH + 32 // 2 × 16px gap
    expect(total).toBeLessThan(gridH - 50)
  })

  test('only description open: description content-sized, peers tiny', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(assetsCard(mainWindow), false)

    const descH = await cardHeight(descriptionCard(mainWindow))
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Empty description editor: small, not filling entire grid
    expect(descH).toBeLessThan(gridH - 100)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(assetsCard(mainWindow))).toBeLessThan(60)
  })

  test('only assets open: assets content-sized, peers tiny', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(assetsCard(mainWindow), true)

    const assetsH = await cardHeight(assetsCard(mainWindow))
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Empty assets: small, not filling
    expect(assetsH).toBeLessThan(gridH - 100)
    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
  })

  test('toggle subtasks closed with 25 subtasks: collapses back to header', async ({ mainWindow }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(subtasksCard(mainWindow), true)
    const openH = await cardHeight(subtasksCard(mainWindow))
    expect(openH).toBeGreaterThan(150)

    await setCardOpen(subtasksCard(mainWindow), false)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
  })

  test('cards grid total does not exceed panel height', async ({ mainWindow }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(assetsCard(mainWindow), true)

    const panel = settingsPanel(mainWindow)
    const panelH = await cardHeight(panel)
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Grid always fits within its panel parent
    expect(gridH).toBeLessThanOrEqual(panelH + 1)
  })
})
