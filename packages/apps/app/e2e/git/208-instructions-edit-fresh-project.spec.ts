/**
 * QA 964073b0 row 5b: editing a project's instruction file (AGENTS.md / CLAUDE.md) in
 * the Context Manager and blurring did not save when the project had never had its
 * instructions saved through the manager (no project `root_instructions` item — every
 * fresh project). The hub refused with "No instructions to push" before any write
 * reached the computer, and the editor said nothing. 63-context-manager-file-sync
 * missed it: its setup seeds that item first.
 */
import fs from 'fs'
import path from 'path'
import {
  test,
  expect,
  seed,
  goHome,
  projectBlob,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { openProjectContextSection } from '../fixtures/context-manager'

const projectAbbrev = 'FR'
const agentsPath = () => path.join(TEST_PROJECT_PATH, 'AGENTS.md')
const claudePath = () => path.join(TEST_PROJECT_PATH, 'CLAUDE.md')

function cleanup(): void {
  for (const f of [agentsPath(), claudePath()]) fs.rmSync(f, { force: true })
}

test.describe('Instructions editor on a fresh project', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    cleanup()
    fs.writeFileSync(agentsPath(), '# fresh v0\n')
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Fresh Instructions',
      color: '#6366f1',
      path: TEST_PROJECT_PATH
    })
    await mainWindow.evaluate(
      ({ id }) =>
        window
          .getTrpcVanillaClient()
          .aiConfig.setProjectProviders.mutate({ projectId: id, providers: ['claude', 'codex'] }),
      { id: project.id }
    )
    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(() => cleanup())

  test('an edit saves to disk on blur, with no error shown', async ({ mainWindow }) => {
    const body = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
    await body.getByRole('button').filter({ hasText: 'AGENTS.md' }).first().click()
    const textarea = body.getByPlaceholder('Write instructions...')
    await expect(textarea).toHaveValue('# fresh v0\n', { timeout: 5_000 })

    await textarea.fill('# fresh v0\nadded line\n')
    await textarea.blur()

    await expect
      .poll(() => fs.readFileSync(agentsPath(), 'utf-8'), { timeout: 5_000 })
      .toBe('# fresh v0\nadded line\n')
    await expect(body.getByTestId('instructions-save-error')).toHaveCount(0)
  })
})
