import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// Issue #180: with more task tabs than fit, the tabs on the right were unreachable.
// The strip is `overflow-x-auto` with a hidden scrollbar, so only a horizontal wheel
// delta (macOS trackpad) scrolled it — a Windows/Linux mouse wheel (vertical only)
// did nothing, activating an off-screen tab left it off-screen, and nothing showed
// that more tabs existed.

type TabStoreWindow = {
  __slayzone_tabStore: {
    getState: () => {
      tabs: Array<{ type: string; taskId?: string }>
      openTask: (taskId: string) => void
      openTaskInBackground: (taskId: string) => void
    }
  }
}

const TOTAL = 24
const titleOf = (i: number): string =>
  `Overflow tab ${String(i).padStart(2, '0')} with a long title`

function strip(page: Page): Locator {
  return page.getByTestId('task-tab-strip')
}

function scrollLeftOf(page: Page): Promise<number> {
  return strip(page).evaluate((el) => el.scrollLeft)
}

async function setScrollLeft(page: Page, x: number): Promise<void> {
  await strip(page).evaluate((el, v) => {
    el.scrollLeft = v
    el.dispatchEvent(new Event('scroll'))
  }, x)
  await expect.poll(() => scrollLeftOf(page)).toBe(x)
}

/** True when `tab` lies fully inside the strip's visible box. */
async function isFullyVisibleInStrip(page: Page, tab: Locator): Promise<boolean> {
  const [s, t] = await Promise.all([strip(page).boundingBox(), tab.boundingBox()])
  if (!s || !t) return false
  return t.x >= s.x - 1 && t.x + t.width <= s.x + s.width + 1
}

test.describe('Task tab strip overflow (#180)', () => {
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Tab Overflow',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    taskIds = []
    for (let i = 0; i < TOTAL; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: titleOf(i),
        status: 'in_progress',
        agentId: 'terminal'
      })
      taskIds.push(t.id)
    }
    await s.refreshData()
    await mainWindow.evaluate((ids) => {
      const st = (window as unknown as TabStoreWindow).__slayzone_tabStore.getState()
      for (const id of ids) st.openTaskInBackground(id)
    }, taskIds)
    await expect(strip(mainWindow).getByText(titleOf(TOTAL - 1))).toBeAttached({
      timeout: 10_000
    })
    // Precondition: the tabs really overflow the strip.
    const overflow = await strip(mainWindow).evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeGreaterThan(200)
  })

  test('vertical mouse wheel scrolls the strip horizontally', async ({ mainWindow }) => {
    await setScrollLeft(mainWindow, 0)
    const first = strip(mainWindow).getByText(titleOf(0))
    await first.hover()
    await mainWindow.mouse.wheel(0, 300)
    await expect.poll(() => scrollLeftOf(mainWindow), { timeout: 3_000 }).toBeGreaterThan(0)
  })

  test('activating an off-screen tab scrolls it into view', async ({ mainWindow }) => {
    await setScrollLeft(mainWindow, 0)
    const last = strip(mainWindow).getByText(titleOf(TOTAL - 1))
    expect(await isFullyVisibleInStrip(mainWindow, last)).toBe(false)

    await mainWindow.evaluate(
      (id) => {
        ;(window as unknown as TabStoreWindow).__slayzone_tabStore.getState().openTask(id)
      },
      taskIds[TOTAL - 1]
    )

    await expect.poll(() => isFullyVisibleInStrip(mainWindow, last), { timeout: 3_000 }).toBe(true)
  })

  test('scroll arrows appear only on the overflowing side and scroll the strip', async ({
    mainWindow
  }) => {
    const left = mainWindow.getByTestId('task-tab-strip-scroll-left')
    const right = mainWindow.getByTestId('task-tab-strip-scroll-right')

    await setScrollLeft(mainWindow, 0)
    await expect(left).toBeHidden()
    await expect(right).toBeVisible()

    await right.click()
    await expect.poll(() => scrollLeftOf(mainWindow), { timeout: 3_000 }).toBeGreaterThan(0)
    await expect(left).toBeVisible()

    const max = await strip(mainWindow).evaluate((el) => el.scrollWidth - el.clientWidth)
    await setScrollLeft(mainWindow, max)
    await expect(right).toBeHidden()
    await expect(left).toBeVisible()

    await left.click()
    await expect.poll(() => scrollLeftOf(mainWindow), { timeout: 3_000 }).toBeLessThan(max)
  })
})
