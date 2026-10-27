/**
 * Explode-mode layout control: repack (no dead cells), minimize to the header tray,
 * drag-to-swap — and none of them (nor toggling explode mode) remounts a pane.
 *
 * Cells are explicit pixel rects from `computeExplodeLayout` (column-major), not CSS
 * grid tracks. The old `repeat(cols) x repeat(rows)` grid put 3 tasks in 2 columns
 * as a 2x2 with a dead bottom-right cell and the third task at half height.
 */
import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, openTaskById, TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

type Box = { id: string; left: number; top: number; width: number; height: number }

const CELL = '[data-explode-task-id]'

async function setExplodeMode(page: Page, on: boolean, count: number): Promise<void> {
  const cells = page.locator(CELL)
  if ((await cells.count()) > 0 !== on) await pressShortcut(page, 'explode-mode')
  await expect(cells).toHaveCount(on ? count : 0, { timeout: 10_000 })
}

/** Cell boxes relative to the grid's padding box, plus that box's size. */
async function readLayout(page: Page): Promise<{ w: number; h: number; cells: Box[] }> {
  return page.evaluate((sel) => {
    const els = [...document.querySelectorAll<HTMLElement>(sel)]
    const grid = els[0]?.offsetParent as HTMLElement | null
    return {
      w: grid?.clientWidth ?? 0,
      h: grid?.clientHeight ?? 0,
      cells: els.map((el) => ({
        id: el.dataset.explodeTaskId ?? '',
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight
      }))
    }
  }, CELL)
}

/** Tag a pane's frame element so a remount (fresh element) is detectable. */
async function tagPane(page: Page, taskId: string): Promise<void> {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-explode-task-id="${id}"]`) as
      | (HTMLElement & { __probe?: string })
      | null
    if (!el) throw new Error(`no cell for ${id}`)
    el.__probe = id
    ;(window as Window & { __probeEl?: Element }).__probeEl = el
  }, taskId)
}

async function paneSurvived(page: Page, taskId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-explode-task-id="${id}"]`)
    return !!el && el === (window as Window & { __probeEl?: Element }).__probeEl
  }, taskId)
}

test.describe('explode mode layout control', () => {
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Explode', color: '#60a5fa', path: TEST_PROJECT_PATH })
    for (let i = 0; i < 3; i++) {
      const t = await s.createTask({ projectId: p.id, title: `Explode ${i + 1}`, status: 'todo' })
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
        t.id
      )
      taskIds.push(t.id)
    }
    await s.refreshData()
    for (const id of taskIds) await openTaskById(mainWindow, id)
    // Narrow enough for 2 columns at the 480px minimum cell width (3 tasks would
    // otherwise get 3 columns, which never had a dead cell).
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL() !== 'about:blank'
      )
      win?.setSize(1300, 900)
    })
  })

  test.afterAll(async ({ mainWindow, electronApp }) => {
    await setExplodeMode(mainWindow, false, 0).catch(() => {})
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL() !== 'about:blank'
      )
      win?.setSize(1920, 1200)
      win?.center()
    })
  })

  test('3 tasks in 2 columns: every column filled to the bottom, no dead cell', async ({
    mainWindow
  }) => {
    await setExplodeMode(mainWindow, true, 3)
    await expect(async () => {
      const { h, cells } = await readLayout(mainWindow)
      const cols = new Map<number, Box[]>()
      for (const c of cells) cols.set(c.left, [...(cols.get(c.left) ?? []), c])
      expect(cols.size).toBe(2)
      for (const col of cols.values()) {
        const bottom = Math.max(...col.map((c) => c.top + c.height))
        // Grid has a 4px padding frame; the column must reach its inner bottom edge.
        expect(Math.abs(bottom - (h - 4))).toBeLessThanOrEqual(1)
      }
      // The odd one out owns its column at full height.
      expect(Math.max(...cells.map((c) => c.height))).toBeGreaterThanOrEqual(h - 8 - 1)
    }).toPass({ timeout: 5_000 })
  })

  test('toggling explode mode off and on keeps every pane mounted', async ({ mainWindow }) => {
    await setExplodeMode(mainWindow, true, 3)
    await tagPane(mainWindow, taskIds[0])
    await setExplodeMode(mainWindow, false, 0)
    await setExplodeMode(mainWindow, true, 3)
    expect(await paneSurvived(mainWindow, taskIds[0])).toBe(true)
  })

  test('minimize parks a pane in the tray (mounted); survivors repack; restore', async ({
    mainWindow
  }) => {
    await setExplodeMode(mainWindow, true, 3)
    const victim = taskIds[1]
    await tagPane(mainWindow, victim)
    const cell = mainWindow.locator(`[data-explode-task-id="${victim}"]`)
    await cell.hover()
    await cell.getByTestId('explode-minimize').click()

    await expect(mainWindow.locator(CELL)).toHaveCount(2)
    const tray = mainWindow.getByTestId('explode-minimized-tray')
    await expect(tray).toHaveText(/1/)
    await expect(async () => {
      const { h, cells } = await readLayout(mainWindow)
      // Two survivors → two full-height columns.
      for (const c of cells) expect(c.height).toBeGreaterThanOrEqual(h - 8 - 1)
    }).toPass({ timeout: 5_000 })

    await tray.click()
    await mainWindow.getByTestId('explode-restore-item').click()
    await expect(mainWindow.locator(CELL)).toHaveCount(3)
    await expect(tray).toHaveCount(0)
    expect(await paneSurvived(mainWindow, victim)).toBe(true)
  })

  test('dragging one cell onto another swaps exactly those two', async ({ mainWindow }) => {
    await setExplodeMode(mainWindow, true, 3)
    const before = await readLayout(mainWindow)
    const [a, , c] = taskIds
    const boxOf = (l: { cells: Box[] }, id: string): Box => l.cells.find((x) => x.id === id)!
    const untouched = before.cells.find((x) => x.id !== a && x.id !== c)!

    // Drop onto the target's TERMINAL, not the cell frame: the terminal's own
    // dragover/drop listeners stopPropagation(), so only the grid's capture-phase
    // handler can see a drop there. Synthetic events, because Playwright's native
    // drag does not drive HTML5 DnD inside Electron.
    await expect(mainWindow.locator(`[data-explode-task-id="${c}"] .xterm`)).toBeVisible({
      timeout: 20_000
    })
    await mainWindow.evaluate(
      ({ a, c }) => {
        const handle = document.querySelector(
          `[data-explode-task-id="${a}"] [data-testid="explode-drag-handle"]`
        ) as HTMLElement
        const target = document.querySelector(
          `[data-explode-task-id="${c}"] .xterm-screen, [data-explode-task-id="${c}"] .xterm`
        ) as HTMLElement
        const dt = new DataTransfer()
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
          )
        }
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      },
      { a, c }
    )
    await expect(async () => {
      const after = await readLayout(mainWindow)
      expect(boxOf(after, a)).toMatchObject({ ...boxOf(before, c), id: a })
      expect(boxOf(after, c)).toMatchObject({ ...boxOf(before, a), id: c })
      expect(boxOf(after, untouched.id)).toEqual(untouched)
    }).toPass({ timeout: 5_000 })
  })

  test('double-clicking a cell title renames the task (tab bar is hidden)', async ({
    mainWindow
  }) => {
    await setExplodeMode(mainWindow, true, 3)
    const cell = mainWindow.locator(`[data-explode-task-id="${taskIds[2]}"]`)
    await cell.getByTestId('compact-title').dblclick()
    const input = cell.getByTestId('compact-title-input')
    await expect(input).toBeFocused()
    await input.fill('Explode renamed')
    await input.press('Enter')
    await expect(cell.getByTestId('compact-title')).toHaveText('Explode renamed')
    await expect
      .poll(() =>
        mainWindow.evaluate(
          (id) =>
            window
              .getTrpcVanillaClient()
              .task.get.query({ id })
              .then((t) => t?.title),
          taskIds[2]
        )
      )
      .toBe('Explode renamed')
  })
})
