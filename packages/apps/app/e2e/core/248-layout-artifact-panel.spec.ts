import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { layoutOf, panel, storedLayout, strip } from '../fixtures/task-layout'

// Artifact panels (docs/plans/panel-model.md step 12): one task artifact on its own,
// the artifacts viewer pinned to it (no tree). Opened from ⋯ → Artifact ▸ <file>, or
// a file's "Open in its own panel" in the artifacts panel; a file already open in a
// panel of its own is shown, not opened twice.

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const WITH_ARTIFACTS = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'artifacts', slots: [{ id: 'artifacts', tabs: ['artifacts'] }] }
])

type Instances = Record<string, { kind: string; settings: Record<string, unknown> }>

async function artifactPanels(page: Page, taskId: string): Promise<[string, unknown][]> {
  const instances = ((await storedLayout(page, taskId))?.instances ?? {}) as Instances
  return Object.entries(instances)
    .filter(([, i]) => i.kind === 'artifact')
    .map(([id, i]) => [id, i.settings.artifactId])
}

/** A task with two artifacts, its layout stored, opened. */
async function openTaskWithArtifacts(
  page: Page,
  projectId: string,
  title: string,
  layout: ReturnType<typeof layoutOf>,
  waitFor: string[]
): Promise<{ taskId: string; notesId: string }> {
  const s = seed(page)
  const t = await s.createTask({ projectId, title, status: 'todo' })
  const notes = (await s.createArtifact({
    taskId: t.id,
    title: 'notes.md',
    content: '# Pinned notes\n\nOnly this file.'
  })) as { id: string }
  await s.createArtifact({ taskId: t.id, title: 'other.md', content: '# Other' })
  await s.updateTask({ id: t.id, panelLayout: layout } as Parameters<typeof s.updateTask>[0])
  await s.refreshData()
  await expect(async () => {
    await page.evaluate((id) => {
      const fn = (window as Window & { __slayzone_openTask?: (i: string) => void })
        .__slayzone_openTask
      if (!fn) throw new Error('__slayzone_openTask not exposed yet')
      fn(id)
    }, t.id)
    for (const id of waitFor) await expect(panel(page, id)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 20_000 })
  return { taskId: t.id, notesId: notes.id }
}

test.describe('Artifact panels', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Artifact panels',
      color: '#ec4899',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('⋯ → Artifact ▸ a file opens it alone; choosing it again shows that panel', async ({
    mainWindow: page
  }) => {
    const { taskId, notesId } = await openTaskWithArtifacts(
      page,
      projectId,
      `Artifact ${++n}`,
      CLASSIC,
      ['terminal', 'settings']
    )
    const openFromMenu = async (): Promise<void> => {
      await page.locator('[data-testid="new-panel-menu"]:visible').click()
      await page.getByTestId('new-panel-artifact').click()
      await page.getByTestId(`new-panel-artifact:${notesId}`).click()
    }
    await openFromMenu()
    await expect.poll(() => artifactPanels(page, taskId)).toHaveLength(1)
    const [[id, artifactId]] = await artifactPanels(page, taskId)
    expect(id).toMatch(/^artifact:[0-9a-f]{8}$/)
    expect(artifactId).toBe(notesId)

    const pinned = panel(page, id)
    await expect(pinned.getByTestId('artifacts-header-title')).toHaveText('notes.md')
    await expect(pinned.getByText('Only this file.')).toBeVisible({ timeout: 15_000 })
    // Just the file: no tree, no sidebar toggle.
    await expect(pinned.getByTestId('artifacts-sidebar')).toHaveCount(0)
    await expect(pinned.getByRole('button', { name: 'Show sidebar' })).toHaveCount(0)
    // The group toggle is named after the file.
    await expect(
      page
        .locator('[data-testid="panel-toggles"]:visible')
        .getByRole('button', { name: 'notes.md', exact: true })
    ).toBeVisible()

    await openFromMenu()
    await page.waitForTimeout(500)
    expect(await artifactPanels(page, taskId)).toHaveLength(1)
  })

  test('a file’s “Open in its own panel” in the artifacts panel', async ({ mainWindow: page }) => {
    const { taskId, notesId } = await openTaskWithArtifacts(
      page,
      projectId,
      `Artifact ${++n}`,
      WITH_ARTIFACTS,
      ['terminal', 'artifacts']
    )
    const row = panel(page, 'artifacts').locator(`[data-testid="artifact-row-${notesId}"] button`)
    await expect(row.first()).toBeVisible({ timeout: 15_000 })
    await row.first().click({ button: 'right' })
    await page.getByTestId('artifact-open-own-panel').click()

    await expect
      .poll(() => artifactPanels(page, taskId))
      .toEqual([[expect.stringMatching(/^artifact:/), notesId]])
    const [[id]] = await artifactPanels(page, taskId)
    await expect(panel(page, id).getByTestId('artifacts-header-title')).toHaveText('notes.md')
    // A column of its own, beside the artifacts panel.
    await expect(strip(page).locator(`[data-panel-id="${id}"]`)).toBeVisible()
    await expect(panel(page, 'artifacts')).toBeVisible()
  })
})
