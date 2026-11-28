import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

// The palette's task results add the hub's search (`task.search`): a word that is only
// in a description, which the board search (titles, fuzzy) cannot see.
test.describe('Palette: hub task search', () => {
  test('finds a task by a word in its description', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hub Search',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
    await s.createTask({
      projectId: p.id,
      title: 'Plain title',
      status: 'todo',
      description: 'The quokkaword lives only here.'
    })
    await s.refreshData()
    await pressShortcut(mainWindow, 'search')
    const input = mainWindow.getByPlaceholder(
      'Search files, folders, commands, projects, and tasks...'
    )
    await input.fill('quokkaword')
    await expect(mainWindow.locator('[cmdk-item]').getByText('Plain title')).toBeVisible({
      timeout: 5_000
    })
    await mainWindow.keyboard.press('Escape')
  })
})
