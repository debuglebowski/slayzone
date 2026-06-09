import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

/** Focus the xterm instance so keyboard shortcuts reach attachCustomKeyEventHandler */
async function focusTerminal(page: import('@playwright/test').Page) {
  // xterm element may have zero dimensions in test layout; focus via its hidden textarea.
  // Multiple terminals may exist from prior test tabs, so poll until one is focusable.
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          // Get all xterm textareas; the last one is the active/visible terminal
          const textareas = document.querySelectorAll('.xterm-helper-textarea')
          const target = textareas[textareas.length - 1] as HTMLTextAreaElement | null
          if (!target) return false
          target.focus()
          return document.activeElement === target
        })
      },
      { timeout: 10_000 }
    )
    .toBe(true)
}

test.describe('Terminal search', () => {
  let projectAbbrev: string
  let taskId: string
  let sessionId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Echo Search',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Search term task',
      status: 'in_progress'
    })
    taskId = t.id
    sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      taskId
    )
    await s.refreshData()

    // Open terminal and seed it with content
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Search term task' })
    await waitForPtySession(mainWindow, sessionId)
  })

  test('Cmd+F opens search bar and finds matches', async ({ mainWindow }) => {
    const marker = `SRCH_${Date.now()}`

    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    // Focus xterm then open search
    await focusTerminal(mainWindow)
    await mainWindow.keyboard.press('Meta+f')

    const searchInput = mainWindow.getByPlaceholder('Find...')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()

    // Search — should find at least 1 match
    await searchInput.fill(marker)
    const countSpan = mainWindow.locator('span.tabular-nums')
    await expect(countSpan).toHaveText(/\d+\/[1-9]\d*/, { timeout: 3_000 })

    // Close for next test
    await mainWindow.keyboard.press('Escape')
    await expect(searchInput).not.toBeVisible()
  })

  test('Escape closes search bar', async ({ mainWindow }) => {
    await focusTerminal(mainWindow)
    await mainWindow.keyboard.press('Meta+f')

    const searchInput = mainWindow.getByPlaceholder('Find...')
    await expect(searchInput).toBeVisible()

    await mainWindow.keyboard.press('Escape')
    await expect(searchInput).not.toBeVisible()
  })

  test('search with no matches shows 0/0', async ({ mainWindow }) => {
    await focusTerminal(mainWindow)
    await mainWindow.keyboard.press('Meta+f')

    const searchInput = mainWindow.getByPlaceholder('Find...')
    await expect(searchInput).toBeVisible()

    await searchInput.fill('XYZNONEXISTENT999')

    const countSpan = mainWindow.locator('span.tabular-nums')
    await expect(countSpan).toHaveText('0/0', { timeout: 3_000 })

    await mainWindow.keyboard.press('Escape')
  })

  test('Enter cycles to next match', async ({ mainWindow }) => {
    const marker = `MULTI_${Date.now()}`

    // Write the marker multiple times
    await runCommand(mainWindow, sessionId, `echo ${marker} && echo ${marker} && echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    await focusTerminal(mainWindow)
    await mainWindow.keyboard.press('Meta+f')

    const searchInput = mainWindow.getByPlaceholder('Find...')
    await expect(searchInput).toBeVisible()

    await searchInput.fill(marker)
    const countSpan = mainWindow.locator('span.tabular-nums')
    await expect(countSpan).toHaveText(/\d+\/[1-9]\d*/, { timeout: 3_000 })

    // Read initial index
    const initialText = await countSpan.innerText()
    const [initialIdx] = initialText.split('/')

    // Press Enter to go to next match
    await mainWindow.keyboard.press('Enter')
    await expect
      .poll(async () => {
        const text = await countSpan.innerText()
        return text.split('/')[0]
      })
      .not.toBe(initialIdx)

    await mainWindow.keyboard.press('Escape')
  })

  test('case sensitivity toggle filters results', async ({ mainWindow }) => {
    const lower = `casemix_${Date.now()}`

    await runCommand(mainWindow, sessionId, `echo ${lower}`)
    await waitForBufferContains(mainWindow, sessionId, lower)

    await focusTerminal(mainWindow)
    await mainWindow.keyboard.press('Meta+f')

    const searchInput = mainWindow.getByPlaceholder('Find...')
    await expect(searchInput).toBeVisible()

    const countSpan = mainWindow.locator('span.tabular-nums')

    // Search uppercase — case-insensitive (default) should find matches
    await searchInput.fill(lower.toUpperCase())
    await expect(countSpan).toHaveText(/\d+\/[1-9]\d*/, { timeout: 3_000 })

    // Toggle case sensitivity on
    await mainWindow.locator('button[title="Case Sensitive"]').click()

    // Re-type to force fresh search with new option
    await searchInput.fill('')
    await searchInput.fill(lower.toUpperCase())
    await expect(countSpan).toHaveText('0/0', { timeout: 3_000 })

    await mainWindow.keyboard.press('Escape')
  })
})
