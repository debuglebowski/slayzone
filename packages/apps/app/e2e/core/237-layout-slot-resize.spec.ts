import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  box,
  layoutOf,
  openTaskWithLayout,
  slot,
  storedLayout,
  strip
} from '../fixtures/task-layout'

// Vertical slots (docs/plans/panel-model.md step 6): a column stacks its groups by
// weight; the divider between two moves weight from one to the other, persisted
// in the task's panel_layout; double-click evens the pair out.

test.describe('Layout slot resize', () => {
  let projectId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Slots',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('dragging the divider resizes the two slots and persists their weights', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(
      page,
      projectId,
      'Slot resize',
      layoutOf([
        { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
        {
          id: 'stack',
          slots: [
            { id: 's-editor', tabs: ['editor'] },
            { id: 's-settings', tabs: ['settings'] }
          ]
        }
      ]),
      ['terminal', 'editor', 'settings']
    )

    const top = slot(page, 's-editor')
    const bottom = slot(page, 's-settings')
    const handle = strip(page).locator('[data-testid="slot-resize-handle"]')
    await expect(handle).toHaveCount(1)
    const t0 = await box(top)
    const b0 = await box(bottom)
    // Equal weights: equal heights, the 16px divider between them.
    expect(Math.abs(t0.height - b0.height)).toBeLessThanOrEqual(2)
    expect(Math.round(b0.y - (t0.y + t0.height))).toBe(16)

    const h = await box(handle)
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 120, { steps: 8 })
    await page.mouse.up()

    await expect.poll(async () => Math.round((await box(top)).height - t0.height)).toBe(120)
    const b1 = await box(bottom)
    expect(Math.round(b0.height - b1.height)).toBe(120)

    // Persisted as slot weights in the same proportion.
    await expect
      .poll(async () => {
        const stack = (await storedLayout(page, taskId))?.columns.find((c) => c.id === 'stack')
        if (!stack) return null
        const [a, b] = stack.slots.map((s) => s.weight)
        return Math.round((a / (a + b)) * 100)
      })
      .toBe(Math.round(((t0.height + 120) / (t0.height + b0.height)) * 100))

    // A slot never shrinks below its minimum.
    const h2 = await box(handle)
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2)
    await page.mouse.down()
    await page.mouse.move(h2.x + h2.width / 2, h2.y + 5_000, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await box(bottom)).height)).toBe(80)

    // Double-click evens the pair out again.
    await handle.dblclick()
    await expect
      .poll(async () => Math.abs((await box(top)).height - (await box(bottom)).height))
      .toBeLessThanOrEqual(2)
  })
})
