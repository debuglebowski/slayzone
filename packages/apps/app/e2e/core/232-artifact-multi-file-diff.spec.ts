import { test, expect, seed, resetApp, openTaskById, TEST_PROJECT_PATH } from '../fixtures/electron'

const ROWS = 1500
const patch = (name: string) =>
  `diff --git a/${name}.txt b/${name}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/${name}.txt\n@@ -0,0 +1,${ROWS} @@\n${Array.from({ length: ROWS }, (_, i) => `+${name} line ${i}`).join('\n')}\n`

test('multi-file artifact diff scrolls every later file through its own bounded list', async ({
  mainWindow
}) => {
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  const project = await s.createProject({
    name: 'Shared diff viewport',
    color: '#f97316',
    path: TEST_PROJECT_PATH
  })
  const task = await s.createTask({
    projectId: project.id,
    title: 'Multi-file patch',
    status: 'todo'
  })
  await s.createArtifact({
    taskId: task.id,
    title: 'multi.diff',
    content: patch('alpha') + patch('bravo') + patch('charlie')
  })
  await s.refreshData()
  await openTaskById(mainWindow, task.id)
  await mainWindow.keyboard.press('Meta+Shift+A')
  const panel = mainWindow.locator('[data-panel-id="artifacts"]:visible')
  await expect(panel).toBeVisible()
  await panel
    .locator('[data-testid="artifacts-sidebar"] [data-testid^="artifact-row-"]')
    .filter({ hasText: 'multi.diff' })
    .first()
    .click()
  const vp = panel.locator('div.overflow-auto.font-mono.text-xs')
  await expect(vp).toBeVisible()
  await expect(vp.getByText('alpha line 0', { exact: true })).toBeInViewport()
  const rowHeight = await vp
    .locator('[data-index="0"]')
    .first()
    .evaluate((row) => row.getBoundingClientRect().height)
  expect(rowHeight).toBeGreaterThan(0)
  // Real Chromium layout/scrolling, no supplied jsdom coordinates. File headers
  // and preceding virtual-list sizers establish each independent list's origin.
  for (const [fileIndex, name] of [
    [1, 'bravo'],
    [2, 'charlie']
  ] as const) {
    for (const index of [0, 750, 1499]) {
      await vp.evaluate(
        (element, { fileIndex, index, rowHeight }) => {
          const section = element.children[fileIndex] as HTMLElement
          const header = section.firstElementChild as HTMLElement
          const origin =
            section.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            element.clientTop +
            element.scrollTop +
            header.getBoundingClientRect().height
          element.scrollTop = origin + index * rowHeight
        },
        { fileIndex, index, rowHeight }
      )
      await expect(vp.getByText(`${name} line ${index}`, { exact: true })).toBeInViewport()
      expect(await vp.locator('[data-index]').count()).toBeLessThan(300)
    }
  }
})
