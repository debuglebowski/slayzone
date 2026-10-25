import { test, expect, seed, resetApp, showProjectBoard, TEST_PROJECT_PATH } from '../fixtures/electron'

// Dialogs opened from a kanban card's context menu (custom snooze, archive,
// blocker, new tag, ...) and then dismissed with Escape must hand pointer
// events back to the app. A leaked `pointer-events: none` on <body> (Radix's
// modal layer bookkeeping) silently freezes every click in the window.

test.describe('Menu-opened dialogs closed with Escape', () => {
  test('Escape restores body pointer-events and clicks keep working', async ({ mainWindow }) => {
    test.setTimeout(120_000)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Escape Dialogs',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    for (let i = 0; i < 8; i++) {
      await s.createTask({ projectId: p.id, title: `Esc task ${i}`, status: 'todo' })
    }
    await s.refreshData()
    await showProjectBoard(mainWindow, 'ES', 'Esc task 0')
    const card = (i: number) =>
      mainWindow.getByText(`Esc task ${i}`, { exact: true }).filter({ visible: true })
    await expect(card(7)).toBeVisible()

    const dialog = (role: 'dialog' | 'alertdialog' = 'dialog') =>
      mainWindow.getByRole(role).filter({ visible: true })
    const bodyPointerEvents = () =>
      mainWindow.evaluate(() => document.body.style.pointerEvents)
    const openMenu = async (i: number) => {
      await card(i).click({ button: 'right' })
      const menu = mainWindow.locator('[role="menu"]').filter({ visible: true })
      await expect(menu).toHaveCount(1)
      return menu
    }

    const cases: {
      name: string
      role?: 'dialog' | 'alertdialog'
      open: (i: number) => Promise<void>
      text: string
    }[] = [
      {
        name: 'custom snooze',
        text: 'Snooze until',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Snooze' }).hover()
          await mainWindow.getByRole('menuitem', { name: 'Custom...' }).click()
        }
      },
      {
        name: 'archive',
        role: 'alertdialog',
        text: 'Archive "Esc task',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Archive' }).click()
        }
      },
      {
        name: 'blocker',
        text: 'Add blocking task',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Blocked by' }).hover()
          await mainWindow.getByRole('menuitem', { name: 'Set blocking task' }).click()
        }
      },
      {
        name: 'blocked with comment',
        text: 'Set blocked with comment',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Blocked by' }).hover()
          await mainWindow.getByRole('menuitem', { name: 'Set blocked with comment' }).click()
        }
      },
      {
        name: 'new tag',
        text: '',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Tags' }).hover()
          await mainWindow.getByRole('menuitem', { name: 'New tag' }).click()
        }
      },
      {
        name: 'delete',
        role: 'alertdialog',
        text: 'Delete "Esc task',
        open: async (i) => {
          const menu = await openMenu(i)
          await menu.getByRole('menuitem', { name: 'Delete' }).click()
        }
      }
    ]

    const leaked: string[] = []
    for (const [idx, c] of cases.entries()) {
      // Reopen the same card twice: first open (mount) and a re-open (latched mount).
      for (const pass of [1, 2]) {
        await c.open(idx + 1)
        await expect(dialog(c.role)).toBeVisible()
        if (c.text) await expect(dialog(c.role)).toContainText(c.text)
        await mainWindow.keyboard.press('Escape')
        await expect(dialog(c.role)).toHaveCount(0)
        // Radix restores body pointer-events in an effect cleanup; give it a beat.
        await expect
          .poll(bodyPointerEvents, { timeout: 2_000 })
          .not.toBe('none')
          .catch(async () => {
            leaked.push(`${c.name} (pass ${pass})`)
            // Unfreeze so the remaining cases still get measured.
            await mainWindow.evaluate(() => (document.body.style.pointerEvents = ''))
          })
      }
    }
    expect(leaked, `body pointer-events stuck at none after Escape`).toEqual([])

    // A real click still lands: open a card's menu and close it with a click elsewhere.
    await openMenu(0)
    await mainWindow.keyboard.press('Escape')
    await card(0).click({ timeout: 5_000 })
  })
})
