import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  test,
  expect,
  seed,
  resetApp,
  projectBlob,
  openProjectSettings,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

test('Relocate moves files, Update path locates a manual move, and settings drafts survive', async ({
  mainWindow
}) => {
  test.setTimeout(120_000)
  await resetApp(mainWindow)
  const base = mkdtempSync(join(dirname(TEST_PROJECT_PATH), 'project-relocation-'))
  const source = join(base, 'source')
  const destination = join(base, 'destination')
  const manual = join(base, 'manual')
  const final = join(base, 'final')
  const occupied = join(base, 'occupied')
  mkdirSync(source)
  mkdirSync(occupied)
  writeFileSync(join(source, 'uncommitted.txt'), 'keep this file')
  const s = seed(mainWindow)
  const project = await s.createProject({
    name: 'Relocate Project',
    color: '#2563eb',
    path: source
  })
  try {
    const task = await s.createTask({
      projectId: project.id,
      title: 'Keep this task',
      status: 'todo'
    })
    const artifact = await s.createArtifact({
      taskId: task.id,
      title: 'Keep this note',
      content: 'unchanged history'
    })
    if (!artifact) throw new Error('Failed to seed the task artifact')
    await s.refreshData()

    await projectBlob(mainWindow, 'RE').click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Relocate…', exact: true }).click()
    const dialog = mainWindow
      .getByRole('dialog')
      .filter({ has: mainWindow.getByRole('heading', { name: 'Relocate “Relocate Project”' }) })
    await expect(dialog.getByText(/SlayZone moves the folder and its files/)).toBeVisible()
    await expect(dialog.getByText(/No files are moved/)).toBeVisible()
    await dialog.getByLabel('New folder path').fill(occupied)
    await dialog.getByRole('button', { name: 'Move folder', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('already exists')
    expect(existsSync(source)).toBe(true)
    await dialog.getByLabel('New folder path').fill(destination)
    await dialog.getByRole('button', { name: 'Move folder', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 20_000 })
    await expect(mainWindow.getByTestId('settings-project-page')).not.toBeVisible()
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(destination, 'uncommitted.txt'), 'utf8')).toBe('keep this file')
    await expect
      .poll(
        async () => (await s.getProjects()).find((p) => p.id === project.id)?.placements[0]?.path
      )
      .toBe(destination)

    renameSync(destination, manual)
    await projectBlob(mainWindow, 'RE').click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Relocate…', exact: true }).click()
    await dialog.getByRole('radio', { name: /Update path/ }).check()
    await dialog.getByLabel('Existing folder path').fill(manual)
    await dialog.getByRole('button', { name: 'Update path', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 20_000 })
    await expect(mainWindow.getByTestId('settings-project-page')).not.toBeVisible()
    expect(readFileSync(join(manual, 'uncommitted.txt'), 'utf8')).toBe('keep this file')
    expect(existsSync(destination)).toBe(false)
    await expect
      .poll(
        async () => (await s.getProjects()).find((p) => p.id === project.id)?.placements[0]?.path
      )
      .toBe(manual)

    const settings = await openProjectSettings(mainWindow, 'RE', 'general')
    await settings.getByLabel('Name', { exact: true }).fill('Edited label')
    await settings.locator('#edit-icon-letters').fill('XY')
    await settings.getByRole('button', { name: 'Relocate…' }).click()
    await dialog.getByLabel('New folder path').fill(final)
    await dialog.getByRole('button', { name: 'Move folder', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 20_000 })
    await expect(settings.getByLabel('Name', { exact: true })).toHaveValue('Edited label')
    await expect(settings.locator('#edit-icon-letters')).toHaveValue('XY')
    await expect(settings.getByLabel('Repository Path')).toHaveValue(final)
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(mainWindow.getByText('Saved', { exact: true }).first()).toBeVisible({
      timeout: 5_000
    })
    await expect
      .poll(async () => (await s.getProjects()).find((p) => p.id === project.id)?.name)
      .toBe('Edited label')
    const saved = (await s.getProjects()).find((p) => p.id === project.id)
    expect(saved).toMatchObject({ name: 'Edited label', icon_letters: 'XY' })
    expect((await s.getTasks()).find((t) => t.id === task.id)).toMatchObject({
      title: 'Keep this task',
      project_id: project.id
    })
    expect((await s.getArtifacts(task.id)).find((a) => a.id === artifact.id)).toMatchObject({
      title: 'Keep this note'
    })
    expect(readFileSync(join(final, 'uncommitted.txt'), 'utf8')).toBe('keep this file')
  } finally {
    await s.deleteProject(project.id)
    rmSync(base, { recursive: true, force: true })
  }
})
