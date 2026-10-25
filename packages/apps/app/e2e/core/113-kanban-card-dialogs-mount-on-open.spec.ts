import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, showProjectBoard, TEST_PROJECT_PATH } from '../fixtures/electron'

// Every kanban card wraps a TaskContextMenu that owns six dialogs (archive, delete,
// custom snooze, new tag, blocking task, blocked-with-comment). They used to mount
// closed on every card: on a 289-card board that was ~21k of the home pane's 42k
// fibers, and each closed BlockerDialog re-filtered the whole task list on every
// task-list update. Dialogs now mount on first open. This spec pins both sides:
// nothing mounts while closed, and every menu entry still opens its dialog
// instantly with working focus handling and actions.

const DIALOG_COMPONENTS = [
  'AlertDialog',
  'Dialog',
  'CustomSnoozeDialog',
  'CreateTagDialog',
  'BlockerDialog'
] as const

/** Fibers + hooks inside the TaskContextMenus of the board, by component name. */
async function contextMenuSubtrees(page: Page) {
  return page.evaluate((names) => {
    type Fiber = {
      tag: number
      type?: { name?: string; displayName?: string } | string | null
      child: Fiber | null
      sibling: Fiber | null
      memoizedState: { next: unknown } | null
    }
    const nameOf = (f: Fiber) =>
      typeof f.type === 'object' || typeof f.type === 'function'
        ? (f.type as { displayName?: string; name?: string })?.displayName ||
          (f.type as { name?: string })?.name
        : undefined
    const cards = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].filter(
      (el) => el.offsetParent !== null && el.closest('[data-sidebar-tree-item]') === null
    )
    const key = Object.keys(cards[0]).find((k) => k.startsWith('__reactFiber'))!
    const menus = new Set<Fiber>()
    for (const el of cards) {
      let f = (el as unknown as Record<string, Fiber & { return: Fiber | null }>)[key] as
        | (Fiber & { return: Fiber | null })
        | null
      while (f && nameOf(f) !== 'TaskContextMenu') f = f.return as typeof f
      if (f) menus.add(f)
    }
    let fibers = 0
    let hooks = 0
    const byName: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]))
    for (const menu of menus) {
      const stack: (Fiber | null)[] = [menu.child]
      while (stack.length) {
        const f = stack.pop()
        if (!f) continue
        fibers++
        if (f.tag === 0 || f.tag === 11 || f.tag === 15) {
          let h = f.memoizedState as { next: unknown } | null
          while (h) {
            hooks++
            h = h.next as typeof h
          }
        }
        const n = nameOf(f)
        if (n && n in byName) byName[n]++
        stack.push(f.sibling, f.child)
      }
    }
    return { menus: menus.size, fibers, hooks, byName }
  }, DIALOG_COMPONENTS as unknown as string[])
}

test.describe('Kanban card dialogs mount on open', () => {
  test('closed card dialogs cost nothing; every entry still opens its dialog', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Card Dialogs',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const N = 40
    for (let i = 0; i < N; i++) {
      await s.createTask({ projectId: p.id, title: `Dialog task ${i}`, status: 'todo' })
    }
    await s.refreshData()
    await showProjectBoard(mainWindow, 'CA', 'Dialog task 0')
    const card = (i: number) =>
      mainWindow.getByText(`Dialog task ${i}`, { exact: true }).filter({ visible: true })
    await expect(card(N - 1)).toBeVisible()

    const closed = await contextMenuSubtrees(mainWindow)
    const summary = `menus=${closed.menus} fibers=${closed.fibers} (${(closed.fibers / closed.menus).toFixed(1)}/card) hooks=${closed.hooks} (${(closed.hooks / closed.menus).toFixed(1)}/card) dialogs=${JSON.stringify(closed.byName)}`
    test.info().annotations.push({ type: 'closed-menus', description: summary })
    console.log(summary)
    expect(closed.menus).toBe(N)
    for (const n of DIALOG_COMPONENTS) expect(closed.byName[n], summary).toBe(0)

    const openMenu = async (i: number) => {
      await card(i).click({ button: 'right' })
      const menu = mainWindow.locator('[role="menu"]').filter({ visible: true })
      await expect(menu).toHaveCount(1)
      return menu
    }
    const cardRoot = (i: number) => mainWindow.locator('[data-task-id]').filter({ has: card(i) })
    const dialog = (role: 'dialog' | 'alertdialog' = 'dialog') =>
      mainWindow.getByRole(role).filter({ visible: true })

    // Archive: AlertDialog opens on the first click with Cancel focused; Cancel closes it.
    let menu = await openMenu(1)
    await menu.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(dialog('alertdialog')).toContainText('Archive "Dialog task 1"?')
    await expect(dialog('alertdialog').getByRole('button', { name: 'Cancel' })).toBeFocused()
    await dialog('alertdialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog('alertdialog')).toHaveCount(0)
    await expect(card(1)).toBeVisible()

    // Reopen the same dialog (stays mounted after first open): still works.
    menu = await openMenu(1)
    await menu.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(dialog('alertdialog')).toContainText('Archive "Dialog task 1"?')
    await dialog('alertdialog').getByRole('button', { name: 'Archive' }).click()
    await expect(dialog('alertdialog')).toHaveCount(0)
    await expect(card(1)).toHaveCount(0)

    // Blocked by → Set blocking task: the dialog body (task list) mounts with it.
    menu = await openMenu(2)
    await menu.getByRole('menuitem', { name: 'Blocked by' }).hover()
    await mainWindow.getByRole('menuitem', { name: 'Set blocking task' }).click()
    await expect(dialog()).toContainText('Add blocking task')
    await expect(dialog().getByRole('textbox', { name: 'Search available blockers' })).toBeVisible()
    await dialog().getByRole('textbox', { name: 'Search available blockers' }).fill('task 3')
    await dialog().getByRole('button', { name: 'Dialog task 3', exact: true }).click()
    await expect(dialog()).toHaveCount(0)
    await expect(cardRoot(2).getByTitle('Blocked')).toBeVisible()

    // Blocked by → Set blocked with comment: Dialog with textarea.
    menu = await openMenu(4)
    await menu.getByRole('menuitem', { name: 'Blocked by' }).hover()
    await mainWindow.getByRole('menuitem', { name: 'Set blocked with comment' }).click()
    await expect(dialog()).toContainText('Set blocked with comment')
    await dialog().getByPlaceholder('Why is this task blocked?').fill('waiting on review')
    await dialog().getByRole('button', { name: 'Set blocked' }).click()
    await expect(dialog()).toHaveCount(0)
    await expect(cardRoot(4).getByTitle('Blocked')).toBeVisible()

    // Snooze → Custom...: calendar dialog.
    menu = await openMenu(5)
    await menu.getByRole('menuitem', { name: 'Snooze' }).hover()
    await mainWindow.getByRole('menuitem', { name: 'Custom...' }).click()
    await expect(dialog()).toContainText('Snooze until')
    await dialog().getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog()).toHaveCount(0)

    // Tags → New tag: create-tag dialog; the new tag lands on the card.
    menu = await openMenu(6)
    await menu.getByRole('menuitem', { name: 'Tags' }).hover()
    await mainWindow.getByRole('menuitem', { name: 'New tag' }).click()
    await expect(dialog()).toBeVisible()
    await dialog().getByRole('textbox').first().fill('fresh-tag')
    await dialog().getByRole('button', { name: 'Create' }).click()
    await expect(dialog()).toHaveCount(0)
    await expect(cardRoot(6)).toContainText('fresh-tag')

    // Delete: AlertDialog confirm removes the card.
    menu = await openMenu(7)
    await menu.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(dialog('alertdialog')).toContainText('Delete "Dialog task 7"?')
    await dialog('alertdialog').getByRole('button', { name: 'Delete' }).click()
    await expect(card(7)).toHaveCount(0)

    // Only the cards whose dialogs were opened carry them now.
    const after = await contextMenuSubtrees(mainWindow)
    expect(after.byName.CustomSnoozeDialog).toBe(1)
    expect(after.byName.CreateTagDialog).toBe(1)
    expect(after.byName.BlockerDialog).toBe(1)
  })
})
