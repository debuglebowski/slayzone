import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import type { Page, Locator, ElectronApplication } from '@playwright/test'

// --- Helpers ---

const settingsPanel = (page: Page): Locator => page.getByTestId('task-settings-panel').last()

const descriptionCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-description-card')

const subtasksCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-subtasks-card')

const artifactsCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-artifacts-card')

const cardsGrid = (page: Page): Locator => settingsPanel(page).getByTestId('settings-cards-grid')

// Details: pinned at the panel bottom in normal mode; an in-grid card in full-height.
const detailsPinned = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-details-pinned')

const detailsCard = (page: Page): Locator =>
  settingsPanel(page).getByTestId('settings-details-card')

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
        await window.getTrpcVanillaClient().task.create.mutate({
          projectId,
          parentId,
          title: `Subtask ${i + 1}`,
          status: 'todo'
        })
      }
    },
    { parentId, projectId, count }
  )
  await page.evaluate(async () => {
    await (
      window as unknown as { __slayzone_refreshData?: () => Promise<void> }
    ).__slayzone_refreshData?.()
    await new Promise((r) => setTimeout(r, 100))
  })
}

async function clearSubtasks(page: Page, parentId: string) {
  await page.evaluate(async (pid) => {
    const c = window.getTrpcVanillaClient()
    const subs = await c.task.getSubTasks.query({ parentId: pid })
    for (const s of subs) await c.task.delete.mutate({ id: s.id })
  }, parentId)
  await page.evaluate(async () => {
    await (
      window as unknown as { __slayzone_refreshData?: () => Promise<void> }
    ).__slayzone_refreshData?.()
    await new Promise((r) => setTimeout(r, 100))
  })
}

// A description tall enough to overflow any panel — the reported bug.
const LONG_DESCRIPTION = Array.from(
  { length: 120 },
  (_, i) => `Paragraph ${i + 1}: ${'lorem ipsum dolor sit amet consectetur adipiscing. '.repeat(3)}`
).join('\n\n')

async function seedDescription(page: Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      await window.getTrpcVanillaClient().task.update.mutate({ id, description: text })
      await (
        window as unknown as { __slayzone_refreshData?: () => Promise<void> }
      ).__slayzone_refreshData?.()
      await new Promise((r) => setTimeout(r, 200))
    },
    { id, text }
  )
}

// The description editor's internal scroll layer.
const descriptionScroll = (page: Page): Locator =>
  descriptionCard(page).locator('.mk-doc-scroll')

async function isScrollable(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.scrollHeight > el.clientHeight + 4)
}

async function resizeWindow(electronApp: ElectronApplication, width: number, height: number) {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) =>
          !w.isDestroyed() &&
          w.webContents.getURL() !== 'about:blank' &&
          !w.webContents.getURL().startsWith('data:')
      )
      if (win) {
        win.setSize(size.width, size.height)
        win.center()
      }
    },
    { width, height }
  )
}

// --- Tests ---

test.describe('Settings panel card sizing', () => {
  let projectAbbrev: string
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'CardSize Test',
      color: '#6366f1',
      path: TEST_PROJECT_PATH
    })
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
    // Reset state: clear subtasks + description, ensure cards start known
    await clearSubtasks(mainWindow, taskId)
    await seedDescription(mainWindow, taskId, '')
  })

  test('all cards closed: each card is roughly header-height', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(artifactsCard(mainWindow))).toBeLessThan(60)
  })

  test('only subtasks open + 0 subtasks: subtasks card is small (content-sized)', async ({
    mainWindow
  }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), false)

    // Just header + "Add subtask" button
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(120)
    // Closed peers stay small
    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(artifactsCard(mainWindow))).toBeLessThan(60)
  })

  test('only subtasks open + 25 subtasks: card caps at share, does not overflow grid', async ({
    mainWindow
  }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), false)

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))

    // Card should be substantial (much more than header-only)
    expect(subH).toBeGreaterThan(150)
    // Card should not exceed grid height
    expect(subH).toBeLessThanOrEqual(gridH + 1)
  })

  test('all open + 25 subtasks: subtasks caps, description + artifacts stay content-sized', async ({
    mainWindow
  }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    const descH = await cardHeight(descriptionCard(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))
    const artifactsH = await cardHeight(artifactsCard(mainWindow))

    // Subtasks should be much bigger than both other cards
    expect(subH).toBeGreaterThan(descH)
    expect(subH).toBeGreaterThan(artifactsH)
    // Description + artifacts stay small (content-sized — empty editor + "Add artifact" button)
    expect(artifactsH).toBeLessThan(120)
  })

  test('all open + empty: cards are content-sized, total < grid', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))
    const artifactsH = await cardHeight(artifactsCard(mainWindow))

    // Three small cards + two gaps should be well under grid height (leftover at bottom)
    const total = descH + subH + artifactsH + 32 // 2 × 16px gap
    expect(total).toBeLessThan(gridH - 50)
  })

  test('only description open: description content-sized, peers tiny', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    const descH = await cardHeight(descriptionCard(mainWindow))
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Empty description editor: small, not filling entire grid
    expect(descH).toBeLessThan(gridH - 100)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(artifactsCard(mainWindow))).toBeLessThan(60)
  })

  test('only artifacts open: artifacts content-sized, peers tiny', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), false)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), true)

    const artifactsH = await cardHeight(artifactsCard(mainWindow))
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Empty artifacts: small, not filling
    expect(artifactsH).toBeLessThan(gridH - 100)
    expect(await cardHeight(descriptionCard(mainWindow))).toBeLessThan(60)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
  })

  test('long description, normal mode: caps within the grid + scrolls internally (bug)', async ({
    mainWindow
  }) => {
    // The reported bug: a very long description grew past its allotted space and
    // blew the grid out of the panel, and its editor never scrolled.
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    const panelH = await cardHeight(settingsPanel(mainWindow))
    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))

    // Grid stays inside the panel; description stays inside the grid.
    expect(gridH).toBeLessThanOrEqual(panelH + 1)
    expect(descH).toBeLessThanOrEqual(gridH + 1)
    // The editor takes over the overflow by scrolling internally.
    expect(await isScrollable(descriptionScroll(mainWindow))).toBe(true)
  })

  test('long description, normal mode: takes the space empty peers leave unused', async ({
    mainWindow
  }) => {
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))

    // Empty peers hug their content (small)...
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(120)
    expect(await cardHeight(artifactsCard(mainWindow))).toBeLessThan(120)
    // ...so the long description gets far more than an even 1/3 share.
    expect(descH).toBeGreaterThan(gridH * 0.5)
  })

  test('toggle subtasks closed with 25 subtasks: collapses back to header', async ({
    mainWindow
  }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(subtasksCard(mainWindow), true)
    const openH = await cardHeight(subtasksCard(mainWindow))
    expect(openH).toBeGreaterThan(150)

    await setCardOpen(subtasksCard(mainWindow), false)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeLessThan(60)
  })

  test('short window: open card with content stays visible, panel scrolls (regression)', async ({
    mainWindow,
    electronApp
  }) => {
    // Regression: a short panel used to starve the cards grid (flex-1) — the
    // fit-content `share` calc went ~0/negative and open cards clipped to
    // header-only. Open cards holding content must stay visible; the panel
    // degrades by scrolling instead.
    await createSubtasks(mainWindow, taskId, projectId, 6)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    await resizeWindow(electronApp, 1100, 500)
    await mainWindow.waitForTimeout(300)

    // Sub-tasks card has 6 items — must not clip to header-only
    expect(await cardHeight(subtasksCard(mainWindow))).toBeGreaterThan(60)

    // Panel degrades by scrolling, not clipping
    const scrollable = await settingsPanel(mainWindow).evaluate(
      (el) => el.scrollHeight > el.clientHeight
    )
    expect(scrollable).toBe(true)

    await resizeWindow(electronApp, 1920, 1200)
  })

  test.afterAll(async ({ electronApp }) => {
    await resizeWindow(electronApp, 1920, 1200)
  })

  test('description full-height mode: sub-tasks + artifacts still expandable', async ({
    mainWindow
  }) => {
    // Repro: after toggling Description "Full height", the handler force-closes
    // sub-tasks/artifacts. Clicking their headers must still re-open them.
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    // Enter full-height mode (force-closes sub-tasks + artifacts)
    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()
    await expect(subtasksCard(mainWindow)).toHaveAttribute('data-state', 'closed')
    await expect(artifactsCard(mainWindow)).toHaveAttribute('data-state', 'closed')

    // User clicks the headers — they must expand
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeGreaterThan(60)
    expect(await cardHeight(artifactsCard(mainWindow))).toBeGreaterThan(60)

    // Restore default height for later tests
    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
  })

  test('full-height mode: a LONG description fills the panel + scrolls', async ({ mainWindow }) => {
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))
    // Sole open card with tall content → fills almost the whole grid...
    expect(descH).toBeGreaterThan(gridH * 0.7)
    expect(descH).toBeLessThanOrEqual(gridH + 1)
    // ...and scrolls internally rather than overflowing.
    expect(await isScrollable(descriptionScroll(mainWindow))).toBe(true)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
  })

  test('full-height mode: an EMPTY description hugs (does not force-fill)', async ({
    mainWindow
  }) => {
    // New behaviour: full-height no longer force-fills. With no content the
    // description hugs, leaving the rest of the panel empty.
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()

    const gridH = await cardHeight(cardsGrid(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))
    expect(descH).toBeLessThan(gridH - 100)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
  })

  test('full-height mode: opening a peer shares the space (both capped, none runs away)', async ({
    mainWindow
  }) => {
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()

    // Open the 25-item sub-tasks card alongside the long description.
    await setCardOpen(subtasksCard(mainWindow), true)
    const gridH = await cardHeight(cardsGrid(mainWindow))
    const subH = await cardHeight(subtasksCard(mainWindow))
    const descH = await cardHeight(descriptionCard(mainWindow))

    // Both are substantial and both stay inside the grid (neither runs away).
    expect(subH).toBeGreaterThan(120)
    expect(descH).toBeGreaterThan(120)
    expect(subH).toBeLessThanOrEqual(gridH + 1)
    expect(descH).toBeLessThanOrEqual(gridH + 1)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
  })

  test('9rem floor: under sharing pressure cards are not crushed, panel scrolls', async ({
    mainWindow,
    electronApp
  }) => {
    // Two tall cards in a short window: the fair share drops below the 9rem
    // floor, so each card must hold at ~144px (not be squeezed smaller) and the
    // panel degrades by scrolling.
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), false)

    await resizeWindow(electronApp, 1100, 500)
    await mainWindow.waitForTimeout(350)

    // Neither tall card is squeezed below the 9rem (144px) floor.
    expect(await cardHeight(descriptionCard(mainWindow))).toBeGreaterThanOrEqual(140)
    expect(await cardHeight(subtasksCard(mainWindow))).toBeGreaterThanOrEqual(140)

    // Panel degrades by scrolling rather than clipping.
    const scrollable = await settingsPanel(mainWindow).evaluate(
      (el) => el.scrollHeight > el.clientHeight
    )
    expect(scrollable).toBe(true)

    await resizeWindow(electronApp, 1920, 1200)
  })

  test('normal mode: Details is pinned at the panel bottom, no header, not a grid card', async ({
    mainWindow
  }) => {
    // Default = normal mode. Details lives at the bottom, always shown, and is
    // NOT rendered as the in-grid collapsible card.
    await expect(detailsPinned(mainWindow)).toBeVisible()
    await expect(detailsCard(mainWindow)).toHaveCount(0)

    const panelBox = await settingsPanel(mainWindow).boundingBox()
    const pinnedBox = await detailsPinned(mainWindow).boundingBox()
    if (!panelBox || !pinnedBox) throw new Error('missing box')
    // Pinned to the bottom: its bottom edge sits at the panel's bottom (modulo
    // the panel's p-3 padding).
    const gapToBottom = panelBox.y + panelBox.height - (pinnedBox.y + pinnedBox.height)
    expect(gapToBottom).toBeGreaterThanOrEqual(0)
    expect(gapToBottom).toBeLessThan(24)
  })

  test('full-height mode: Details becomes a collapsible grid card (collapsed on enter)', async ({
    mainWindow
  }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()

    // Pinned meta is replaced by the in-grid card, collapsed on entering.
    await expect(detailsPinned(mainWindow)).toHaveCount(0)
    await expect(detailsCard(mainWindow)).toBeVisible()
    await expect(detailsCard(mainWindow)).toHaveAttribute('data-state', 'closed')

    // User can expand it — it then shares grid space.
    await setCardOpen(detailsCard(mainWindow), true)
    expect(await cardHeight(detailsCard(mainWindow))).toBeGreaterThan(60)

    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
    // Back to pinned in normal mode.
    await expect(detailsPinned(mainWindow)).toBeVisible()
  })

  test('exiting full-height re-opens the peers it collapsed', async ({ mainWindow }) => {
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    // Enter → force-closes peers.
    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()
    await expect(subtasksCard(mainWindow)).toHaveAttribute('data-state', 'closed')
    await expect(artifactsCard(mainWindow)).toHaveAttribute('data-state', 'closed')

    // Exit → restores them.
    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
    await expect(subtasksCard(mainWindow)).toHaveAttribute('data-state', 'open')
    await expect(artifactsCard(mainWindow)).toHaveAttribute('data-state', 'open')
  })

  test('full-height: a long description re-flows when the window resizes (live recompute)', async ({
    mainWindow,
    electronApp
  }) => {
    await resizeWindow(electronApp, 1920, 1200)
    await seedDescription(mainWindow, taskId, LONG_DESCRIPTION)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)
    await settingsPanel(mainWindow).getByRole('button', { name: 'Full height' }).click()
    await mainWindow.waitForTimeout(250)
    const tallH = await cardHeight(descriptionCard(mainWindow))

    // Shrink the window — the sole open, tall card must track the new available
    // height (proves the ResizeObserver recompute path runs).
    await resizeWindow(electronApp, 1400, 700)
    await mainWindow.waitForTimeout(400)
    const shortH = await cardHeight(descriptionCard(mainWindow))
    expect(shortH).toBeLessThan(tallH - 50)

    await resizeWindow(electronApp, 1920, 1200)
    await settingsPanel(mainWindow).getByRole('button', { name: 'Default height' }).click()
  })

  test('clicking anywhere on a card header toggles it (not just the chevron)', async ({
    mainWindow
  }) => {
    // Repro: the CollapsibleTrigger only covered the chevron + label, leaving
    // the rest of the header row as dead space — clicking there did nothing.
    await setCardOpen(subtasksCard(mainWindow), false)
    await setCardOpen(artifactsCard(mainWindow), false)

    for (const card of [subtasksCard(mainWindow), artifactsCard(mainWindow)]) {
      const header = card.locator('[data-slot="collapsible-trigger"]').first()
      const box = await header.boundingBox()
      if (!box) throw new Error('no header box')
      // The header trigger must span the full row width — clicking its
      // far-right edge (dead space in the old layout) must toggle the card.
      expect(box.width).toBeGreaterThan(200)
      await mainWindow.mouse.click(box.x + box.width - 16, box.y + box.height / 2)
      await expect(card).toHaveAttribute('data-state', 'open', { timeout: 2_000 })
    }
  })

  test('cards grid total does not exceed panel height', async ({ mainWindow }) => {
    await createSubtasks(mainWindow, taskId, projectId, 25)
    await setCardOpen(descriptionCard(mainWindow), true)
    await setCardOpen(subtasksCard(mainWindow), true)
    await setCardOpen(artifactsCard(mainWindow), true)

    const panel = settingsPanel(mainWindow)
    const panelH = await cardHeight(panel)
    const gridH = await cardHeight(cardsGrid(mainWindow))

    // Grid always fits within its panel parent
    expect(gridH).toBeLessThanOrEqual(panelH + 1)
  })
})
