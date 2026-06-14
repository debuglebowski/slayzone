import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  TEST_PROJECT_PATH,
  resetApp
} from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'

type ExportImportResult = {
  success: boolean
  error?: string
  projectCount?: number
  taskCount?: number
  importedProjects?: Array<{ id: string; name: string }>
}

const exportImportTest = {
  exportAllToPath: (page: Page, filePath: string) =>
    page.evaluate((p) => {
      return window.getTrpcVanillaClient().app.exportImport.testExportAllToPath.mutate({
        filePath: p
      })
    }, filePath) as Promise<ExportImportResult>,
  exportProjectToPath: (page: Page, projectId: string, filePath: string) =>
    page.evaluate(
      ({ pid, p }) => {
        return window.getTrpcVanillaClient().app.exportImport.testExportProjectToPath.mutate({
          projectId: pid,
          filePath: p
        })
      },
      { pid: projectId, p: filePath }
    ) as Promise<ExportImportResult>,
  importFromPath: (page: Page, filePath: string) =>
    page.evaluate((p) => {
      return window.getTrpcVanillaClient().app.exportImport.testImportFromPath.mutate({
        filePath: p
      })
    }, filePath) as Promise<ExportImportResult>,
  setTaskParent: (page: Page, taskId: string, parentId: string | null) =>
    page.evaluate(
      ({ tid, pid }) => {
        return window.getTrpcVanillaClient().app.exportImport.testSetTaskParent.mutate({
          taskId: tid,
          parentId: pid
        })
      },
      { tid: taskId, pid: parentId }
    )
}

test.describe('Export & Import', () => {
  const exportDir = path.join(TEST_PROJECT_PATH, '..', 'export-test')
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    fs.mkdirSync(exportDir, { recursive: true })

    const s = seed(mainWindow)
    await s.deleteAllProjects()

    // Create a project with tasks, tags, and dependencies
    const project = await s.createProject({
      name: 'EX Project',
      color: '#ef4444',
      path: TEST_PROJECT_PATH
    })
    projectId = project.id

    const tag1 = await s.createTag({ name: 'ex-urgent', color: '#dc2626' })
    const tag2 = await s.createTag({ name: 'ex-backend', color: '#2563eb' })

    const t1 = await s.createTask({
      projectId,
      title: 'EX Task Alpha',
      status: 'in_progress',
      priority: 1
    })
    const t2 = await s.createTask({
      projectId,
      title: 'EX Task Beta',
      status: 'inbox',
      priority: 3
    })
    await s.createTask({
      projectId,
      title: 'EX Task Gamma',
      status: 'done',
      priority: 2
    })

    await s.setTagsForTask(t1.id, [tag1.id, tag2.id])
    await s.setTagsForTask(t2.id, [tag2.id])
    await s.addBlocker(t2.id, t1.id) // t1 blocks t2

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, 'EX')
  })

  test('export all projects to file', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'all-export.slay')
    const result = await exportImportTest.exportAllToPath(mainWindow, filePath)

    expect(result.success).toBe(true)
    expect(fs.existsSync(filePath)).toBe(true)

    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(bundle.meta.version).toBe(1)
    expect(bundle.meta.scope).toBe('all')
    expect(bundle.data.projects).toHaveLength(1)
    expect(bundle.data.projects[0].name).toBe('EX Project')
    expect(bundle.data.tasks).toHaveLength(3)
    expect(bundle.data.tags.length).toBeGreaterThanOrEqual(2)
    expect(bundle.data.task_tags.length).toBeGreaterThanOrEqual(3)
    expect(bundle.data.task_dependencies).toHaveLength(1)
  })

  test('export single project to file', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'project-export.slay')
    const result = await exportImportTest.exportProjectToPath(mainWindow, projectId, filePath)

    expect(result.success).toBe(true)

    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(bundle.meta.scope).toBe('project')
    expect(bundle.meta.projectId).toBe(projectId)
    expect(bundle.data.projects).toHaveLength(1)
    expect(bundle.data.tasks).toHaveLength(3)
    // Only tags used by this project's tasks
    const tagNames = bundle.data.tags.map((t: { name: string }) => t.name).sort()
    expect(tagNames).toContain('ex-urgent')
    expect(tagNames).toContain('ex-backend')
    // No settings or ai_config_sources for project export
    expect(bundle.data.settings).toHaveLength(0)
    expect(bundle.data.ai_config_sources).toHaveLength(0)
  })

  test('import creates new project with remapped IDs', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'project-export.slay')
    const s = seed(mainWindow)

    const projectsBefore = await s.getProjects()
    const tasksBefore = await s.getTasks()

    const result = await exportImportTest.importFromPath(mainWindow, filePath)
    expect(result.success).toBe(true)
    expect(result.projectCount).toBe(1)
    expect(result.taskCount).toBe(3)

    // Verify importedProjects in result
    expect(result.importedProjects).toHaveLength(1)
    expect(result.importedProjects[0].name).toBe('EX Project (imported)')
    expect(result.importedProjects[0].id).toBeTruthy()

    await s.refreshData()

    const projectsAfter = await s.getProjects()
    const tasksAfter = await s.getTasks()

    // Should have one more project
    expect(projectsAfter).toHaveLength(projectsBefore.length + 1)
    // Should have 3 more tasks
    expect(tasksAfter).toHaveLength(tasksBefore.length + 3)

    // Imported project has " (imported)" suffix due to name collision
    const imported = projectsAfter.find((p: { name: string }) => p.name === 'EX Project (imported)')
    expect(imported).toBeTruthy()

    // Imported project ID matches what was returned in result
    expect(imported!.id).toBe(result.importedProjects[0].id)

    // Imported project has a different ID from original
    expect(imported!.id).not.toBe(projectId)

    // Imported tasks belong to the new project
    const importedTasks = tasksAfter.filter(
      (t: { project_id: string }) => t.project_id === imported!.id
    )
    expect(importedTasks).toHaveLength(3)
    const importedTitles = importedTasks.map((t: { title: string }) => t.title).sort()
    expect(importedTitles).toEqual(['EX Task Alpha', 'EX Task Beta', 'EX Task Gamma'])
  })

  test('import deduplicates tags by name', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const tags = await s.getTags()

    // Should still have only one 'ex-urgent' and one 'ex-backend'
    const urgentTags = tags.filter((t: { name: string }) => t.name === 'ex-urgent')
    const backendTags = tags.filter((t: { name: string }) => t.name === 'ex-backend')
    expect(urgentTags).toHaveLength(1)
    expect(backendTags).toHaveLength(1)
  })

  test('imported project visible on kanban after refresh', async ({ mainWindow }) => {
    await goHome(mainWindow)
    // The imported project should appear in the sidebar
    await clickProject(mainWindow, 'EX')
    // At least one of the EX projects should show tasks
    await expect(mainWindow.getByText('EX Task Alpha').first()).toBeVisible({ timeout: 5_000 })
  })

  test('double import appends another suffix', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'project-export.slay')
    const s = seed(mainWindow)

    const result = await exportImportTest.importFromPath(mainWindow, filePath)
    expect(result.success).toBe(true)

    await s.refreshData()
    const projects = await s.getProjects()

    // Now we have: "EX Project", "EX Project (imported)", "EX Project (imported) (imported)"
    const importedNames = projects
      .map((p: { name: string }) => p.name)
      .filter((n: string) => n.startsWith('EX Project'))
      .sort()
    expect(importedNames).toHaveLength(3)
    expect(importedNames).toContain('EX Project')
    expect(importedNames).toContain('EX Project (imported)')
    expect(importedNames).toContain('EX Project (imported) (imported)')
  })

  test('export nonexistent project fails', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'fail.slay')
    const result = await exportImportTest.exportProjectToPath(
      mainWindow,
      'nonexistent-id',
      filePath
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  test('import invalid file fails gracefully', async ({ mainWindow }) => {
    const filePath = path.join(exportDir, 'bad.slay')
    fs.writeFileSync(filePath, '{"meta":{"version":999}}', 'utf8')

    const result = await exportImportTest.importFromPath(mainWindow, filePath)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unsupported export version')
  })

  test('import project with sub-tasks + stale parent_id succeeds', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const fkProject = await s.createProject({
      name: 'FK Project',
      color: '#14b8a6',
      path: TEST_PROJECT_PATH
    })

    // Create child BEFORE parent so child's rowid is lower. SELECT * returns
    // rowid order → child row appears before parent in the bundle. Without
    // deferred FKs the INSERT for child would fail (parent not yet present).
    const child = await s.createTask({ projectId: fkProject.id, title: 'FK Child' })
    const parent = await s.createTask({ projectId: fkProject.id, title: 'FK Parent' })
    const orphan = await s.createTask({ projectId: fkProject.id, title: 'FK Orphan' })

    // Wire parent_id via test-only IPC (disables FK checks to seed stale ref).
    await exportImportTest.setTaskParent(mainWindow, child.id, parent.id)
    await exportImportTest.setTaskParent(
      mainWindow,
      orphan.id,
      '00000000-0000-4000-8000-000000000000'
    )

    const filePath = path.join(exportDir, 'fk-project.slay')
    const exportResult = await exportImportTest.exportProjectToPath(
      mainWindow,
      fkProject.id,
      filePath
    )
    expect(exportResult.success).toBe(true)

    const importResult = await exportImportTest.importFromPath(mainWindow, filePath)
    expect(importResult.success).toBe(true)
    expect(importResult.error).toBeUndefined()
    expect(importResult.taskCount).toBe(3)

    await s.refreshData()
    const allTasks = await s.getTasks()
    const importedProjectId = importResult.importedProjects[0].id
    const importedTasks = allTasks.filter(
      (t: { project_id: string }) => t.project_id === importedProjectId
    )
    expect(importedTasks).toHaveLength(3)

    const byTitle = new Map<string, { id: string; parent_id: string | null }>(
      importedTasks.map((t: { title: string; id: string; parent_id: string | null }) => [
        t.title,
        { id: t.id, parent_id: t.parent_id }
      ])
    )
    const importedParent = byTitle.get('FK Parent')!
    const importedChild = byTitle.get('FK Child')!
    const importedOrphan = byTitle.get('FK Orphan')!

    // Parent/child link preserved via remap despite insertion order.
    expect(importedChild.parent_id).toBe(importedParent.id)
    // Stale parent_id nulled out — no crash, no dangling ref.
    expect(importedOrphan.parent_id).toBeNull()
  })
})
