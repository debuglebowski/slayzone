import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

// Lenses (plans/layout-redesign.md, phase 2): the tree sidebar's Lens button switches
// between saved presets, the editor changes and saves one, and the cross-project
// lenses list every project's tasks in one grouped list.

type Store = {
  setState: (s: unknown) => void
  getState: () => Record<string, unknown> & { applyLens: (id: string) => void }
}

async function patchStore(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    const store = (window as unknown as { __slayzone_tabStore?: Store }).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.setState(p)
  }, patch)
}

async function applyLens(page: Page, id: string) {
  await page.evaluate((lensId) => {
    ;(window as unknown as { __slayzone_tabStore: Store }).__slayzone_tabStore
      .getState()
      .applyLens(lensId)
  }, id)
}

const lensButton = (page: Page) => page.getByTestId('lens-button')
const menuItem = (page: Page, name: string) =>
  page.getByTestId('lens-menu-item').filter({ hasText: name })
// Linux/Windows: Alt+1–9 (Ctrl+1–9 switches tabs there); macOS: ⌃1–9.
const lensKey = (n: number) => `${process.platform === 'darwin' ? 'Control' : 'Alt'}+${n}`

test.describe('Sidebar lenses', () => {
  // Several dialogs, menus and a Settings round trip per test: more than the 30s default.
  test.describe.configure({ timeout: 90_000 })

  let alphaId: string
  let betaId: string
  let alphaRunning: string
  let alphaTodo: string
  let betaReview: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    alphaId = (
      await s.createProject({ name: 'Lens Alpha', color: '#3b82f6', path: TEST_PROJECT_PATH })
    ).id
    betaId = (
      await s.createProject({ name: 'Lens Beta', color: '#f59e0b', path: TEST_PROJECT_PATH })
    ).id
    alphaRunning = (
      await s.createTask({ projectId: alphaId, title: 'Alpha in progress', status: 'in_progress' })
    ).id
    alphaTodo = (await s.createTask({ projectId: alphaId, title: 'Alpha todo', status: 'todo' })).id
    betaReview = (await s.createTask({ projectId: betaId, title: 'Beta review', status: 'review' }))
      .id
    // Starred: Today (active & starred projects) shows both without open tabs.
    await mainWindow.evaluate(
      async (ids) => {
        const c = window.getTrpcVanillaClient()
        for (const id of ids) await c.projects.update.mutate({ id, starred: true })
      },
      [alphaId, betaId]
    )
    await s.refreshData()
  })

  test.beforeEach(async ({ mainWindow }) => {
    await patchStore(mainWindow, { sidebarView: 'projects' })
    await patchStore(mainWindow, { sidebarView: 'tree', selectedProjectId: alphaId })
    await applyLens(mainWindow, 'today')
    await expect(lensButton(mainWindow)).toHaveAttribute('data-lens-id', 'today')
  })

  test('the menu lists the built-in lenses and switching applies one', async ({ mainWindow }) => {
    await lensButton(mainWindow).click()
    await expect(mainWindow.getByTestId('lens-menu-item')).toHaveText([
      /Today/,
      /Agent status/,
      /Task status/,
      /Recent/,
      /Accordion/
    ])
    await expect(mainWindow.getByRole('menuitem', { name: 'Manage lenses…' })).toBeVisible()

    // Task status: one list across both projects, grouped by status.
    await menuItem(mainWindow, 'Task status').click()
    await expect(lensButton(mainWindow)).toHaveAttribute('data-lens-id', 'task-status')
    const lists = mainWindow.locator('[data-testid="lens-task-lists"][data-lens-group="status"]')
    await expect(lists).toBeVisible()
    const inProgress = lists.locator('[data-testid="lens-group"][data-group-key="in_progress"]')
    const todo = lists.locator('[data-testid="lens-group"][data-group-key="todo"]')
    const review = lists.locator('[data-testid="lens-group"][data-group-key="review"]')
    await expect(inProgress.locator(`[data-task-id="${alphaRunning}"]`)).toBeVisible()
    await expect(todo.locator(`[data-task-id="${alphaTodo}"]`)).toBeVisible()
    await expect(review.locator(`[data-task-id="${betaReview}"]`)).toBeVisible()
    // Each row says which project it belongs to.
    await expect(
      review.locator(`[data-task-id="${betaReview}"] [data-testid="task-row-project-dot"]`)
    ).toHaveAttribute('aria-label', 'Lens Beta')

    // The keyboard: the first lens is Today again.
    await mainWindow.keyboard.press(lensKey(1))
    await expect(lensButton(mainWindow)).toHaveAttribute('data-lens-id', 'today')
    await expect(lists).toHaveCount(0)
    await mainWindow.keyboard.press(lensKey(3))
    await expect(lensButton(mainWindow)).toHaveAttribute('data-lens-id', 'task-status')
  })

  test('editing shows live, Save keeps it, the settings page resets it', async ({ mainWindow }) => {
    const card = mainWindow.locator('[data-project-look]').first()
    await expect(card).toHaveAttribute('data-project-look', 'cards')

    await lensButton(mainWindow).click()
    await menuItem(mainWindow, 'Today').hover()
    await mainWindow.getByRole('button', { name: 'Edit Today' }).click()
    const dialog = mainWindow.getByTestId('lens-edit-dialog')
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole('radiogroup', { name: 'Look' })
      .getByRole('radio', { name: 'Flat' })
      .click()
    // Live: the sidebar already shows it, and the Lens button marks it unsaved.
    await expect(card).toHaveAttribute('data-project-look', 'flat')
    await expect(lensButton(mainWindow).getByTestId('toolbar-button-dot')).toBeVisible()

    // The other tabs hold the rest of the display settings.
    await dialog.getByRole('tab', { name: 'What to show' }).click()
    await expect(dialog.getByRole('switch', { name: 'Group blocked tasks' })).toBeVisible()
    await dialog.getByRole('tab', { name: 'How rows look' }).click()
    await expect(dialog.getByTestId('lens-row-preview')).toBeVisible()

    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(lensButton(mainWindow).getByTestId('toolbar-button-dot')).toHaveCount(0)
    await mainWindow.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Saved into the lens: switching away and back keeps it.
    await mainWindow.keyboard.press(lensKey(4))
    await expect(lensButton(mainWindow)).toHaveAttribute('data-lens-id', 'recent')
    await mainWindow.keyboard.press(lensKey(1))
    await expect(card).toHaveAttribute('data-project-look', 'flat')
    await lensButton(mainWindow).click()
    await expect(menuItem(mainWindow, 'Today')).toContainText('· edited')

    // Manage lenses… → Settings › Lenses → Reset to default.
    await mainWindow.getByRole('menuitem', { name: 'Manage lenses…' }).click()
    const page = mainWindow.getByTestId('lens-settings-page')
    await expect(page).toBeVisible()
    await expect(page.getByTestId('lens-settings-row')).toHaveCount(5)
    await expect(page.getByTestId('lens-preview')).toBeVisible()
    await page.getByRole('button', { name: 'Reset to default' }).click()
    await expect(page.getByRole('button', { name: 'Reset to default' })).toHaveCount(0)
    await mainWindow.getByTestId('settings-back').click()
    await expect(card).toHaveAttribute('data-project-look', 'cards')
  })

  test('Save as new makes a lens of the edits and leaves the original as it was', async ({
    mainWindow
  }) => {
    await lensButton(mainWindow).click()
    await menuItem(mainWindow, 'Accordion').hover()
    await mainWindow.getByRole('button', { name: 'Edit Accordion' }).click()
    const dialog = mainWindow.getByTestId('lens-edit-dialog')
    await dialog.getByRole('switch', { name: '“Needs you” at the top' }).click()
    await dialog.getByRole('button', { name: 'Save as new…' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Lens name' })).toHaveValue('Accordion copy')
    await mainWindow.keyboard.press('Escape')

    const id = await lensButton(mainWindow).getAttribute('data-lens-id')
    expect(id).not.toBe('accordion')
    await lensButton(mainWindow).click()
    await expect(menuItem(mainWindow, 'Accordion copy')).toBeVisible()
    await expect(menuItem(mainWindow, 'Accordion').first()).not.toContainText('· edited')
    await mainWindow.keyboard.press('Escape')
    const lenses = await mainWindow.evaluate(() =>
      (
        (window as unknown as { __slayzone_tabStore: Store }).__slayzone_tabStore.getState()
          .lenses as Array<{ id: string; spec: { needsYou: boolean; look: string } }>
      ).map((l) => ({ id: l.id, needsYou: l.spec.needsYou, look: l.spec.look }))
    )
    expect(lenses.find((l) => l.id === 'accordion')).toMatchObject({ needsYou: false })
    expect(lenses.find((l) => l.id === id)).toMatchObject({ needsYou: true, look: 'accordion' })
  })
})
