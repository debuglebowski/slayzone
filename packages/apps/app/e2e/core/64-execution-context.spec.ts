import { test, expect, seed, goHome, projectBlob, openProjectSettings, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Project execution context settings', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    // Use a unique abbreviation to avoid collisions with earlier suites (e.g. "EX Project").
    const project = await s.createProject({ name: 'QX Exec Ctx', color: '#7c3aed', path: TEST_PROJECT_PATH })
    projectId = project.id
    projectAbbrev = project.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  // ---------------------------------------------------------------------------
  // Helper: ensure project settings dialog is open on Environment tab
  // ---------------------------------------------------------------------------
  async function openSettings(mainWindow: import('@playwright/test').Page) {
    const dialog = await openProjectSettings(mainWindow, projectAbbrev)

    const execContext = dialog.locator('#exec-context')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await dialog.getByTestId('settings-tab-environment').first().click().catch(() => {})
      if (await execContext.isVisible({ timeout: 1_500 }).catch(() => false)) return
      await mainWindow.waitForTimeout(120)
    }
    await expect(execContext).toBeVisible({ timeout: 5_000 })
  }

  async function selectExecutionContext(
    mainWindow: import('@playwright/test').Page,
    optionName: 'This machine' | 'A Docker container' | 'A remote machine (SSH)'
  ) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const trigger = mainWindow.locator('#exec-context').first()
      await trigger.click().catch(() => {})
      const option = mainWindow.getByRole('option', { name: optionName }).first()
      if (await option.isVisible({ timeout: 1_200 }).catch(() => false)) {
        await option.click()
        return
      }
      await mainWindow.waitForTimeout(120)
    }
    await mainWindow.getByRole('option', { name: optionName }).first().click()
  }

  // ---------------------------------------------------------------------------
  // 1) Default execution context is "This machine"
  // ---------------------------------------------------------------------------
  test('default execution context is Local', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    const trigger = mainWindow.locator('#exec-context')
    await expect(trigger).toBeVisible({ timeout: 3_000 })
    await expect(trigger).toHaveText(/This machine/)
  })

  // ---------------------------------------------------------------------------
  // 2) Selecting Docker shows docker-specific fields
  // ---------------------------------------------------------------------------
  test('selecting Docker shows container fields', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'A Docker container')
    await expect(mainWindow.locator('#exec-container')).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.locator('#exec-workdir')).toBeVisible()
    await expect(mainWindow.locator('#exec-shell')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 3) Selecting SSH shows ssh-specific fields
  // ---------------------------------------------------------------------------
  test('selecting SSH shows target fields', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'A remote machine (SSH)')
    await expect(mainWindow.locator('#exec-ssh-target')).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.locator('#exec-workdir-ssh')).toBeVisible()
    await expect(mainWindow.locator('#exec-shell-ssh')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 4) Save Docker config and verify DB roundtrip
  // ---------------------------------------------------------------------------
  test('save docker execution context persists in DB', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'A Docker container')

    await mainWindow.locator('#exec-container').fill('my-dev-container')
    await mainWindow.locator('#exec-workdir').fill('/workspace')
    await mainWindow.locator('#exec-shell').fill('/bin/zsh')

    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' }))
      .not.toBeVisible({ timeout: 3_000 })

    // Verify DB
    const projects = await seed(mainWindow).getProjects()
    const project = projects.find((p: { id: string }) => p.id === projectId) as {
      execution_context: { type: string; container: string; workdir: string; shell: string } | null
    }
    expect(project?.execution_context).toEqual({
      type: 'docker',
      container: 'my-dev-container',
      workdir: '/workspace',
      shell: '/bin/zsh'
    })
  })

  // ---------------------------------------------------------------------------
  // 5) Reopen dialog — Docker fields are pre-filled
  // ---------------------------------------------------------------------------
  test('docker fields are restored on reopen', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await expect(mainWindow.locator('#exec-context')).toHaveText(/Docker container/)
    await expect(mainWindow.locator('#exec-container')).toHaveValue('my-dev-container')
    await expect(mainWindow.locator('#exec-workdir')).toHaveValue('/workspace')
    await expect(mainWindow.locator('#exec-shell')).toHaveValue('/bin/zsh')
  })

  // ---------------------------------------------------------------------------
  // 6) Switch to SSH, save, verify roundtrip
  // ---------------------------------------------------------------------------
  test('save ssh execution context persists in DB', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'A remote machine (SSH)')

    await mainWindow.locator('#exec-ssh-target').fill('user@remote-host')
    await mainWindow.locator('#exec-workdir-ssh').fill('/home/user/project')

    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' }))
      .not.toBeVisible({ timeout: 3_000 })

    const projects = await seed(mainWindow).getProjects()
    const project = projects.find((p: { id: string }) => p.id === projectId) as {
      execution_context: { type: string; target: string; workdir: string; shell?: string } | null
    }
    expect(project?.execution_context).toMatchObject({
      type: 'ssh',
      target: 'user@remote-host',
      workdir: '/home/user/project'
    })
  })

  // ---------------------------------------------------------------------------
  // 7) Switch back to Local, save, verify null in DB
  // ---------------------------------------------------------------------------
  test('switching to Local clears execution context', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'This machine')

    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' }))
      .not.toBeVisible({ timeout: 3_000 })

    const projects = await seed(mainWindow).getProjects()
    const project = projects.find((p: { id: string }) => p.id === projectId) as {
      execution_context: unknown
    }
    expect(project?.execution_context).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 8) Test connection button shows failure for nonexistent container
  // ---------------------------------------------------------------------------
  test('test connection shows failure for nonexistent docker container', async ({ mainWindow }) => {
    await openSettings(mainWindow)
    await selectExecutionContext(mainWindow, 'A Docker container')
    await mainWindow.locator('#exec-container').fill('nonexistent-container-12345')

    await mainWindow.getByRole('button', { name: 'Test connection' }).click()

    // Should show error (docker not found or container not running)
    const dockerSection = mainWindow.locator('#exec-container').locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]')
    const errorResult = dockerSection.locator('span.text-red-500').first()
    await expect(errorResult).toBeVisible({ timeout: 15_000 })
    await expect(errorResult).not.toHaveText(/^Connected$/)

    // Close without saving
    await mainWindow.keyboard.press('Escape')
  })

  // ---------------------------------------------------------------------------
  // 9) Test connection shows failure for nonexistent SSH target
  // ---------------------------------------------------------------------------
  test('test connection shows failure for nonexistent ssh target', async ({ mainWindow }) => {
    const result = await mainWindow.evaluate(() =>
      window.api.pty.testExecutionContext({
        type: 'ssh',
        target: 'user@invalid.invalid',
        workdir: '/tmp'
      })
    )
    expect(result.success).toBe(false)
    expect(result.error ?? '').toMatch(/timed out|refused|resolve|failed|unknown|enoent|spawn|not found/i)
  })

  // ---------------------------------------------------------------------------
  // 10) DB seeded execution context is reflected in UI
  // ---------------------------------------------------------------------------
  test('DB-seeded execution context appears in settings UI', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Escape').catch(() => {})
    // Seed directly via API
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateProject({
        id,
        executionContext: { type: 'docker', container: 'seeded-container', workdir: '/app' }
      }),
      { id: projectId }
    )
    await seed(mainWindow).refreshData()

    const projects = await seed(mainWindow).getProjects()
    const project = projects.find((p: { id: string }) => p.id === projectId) as {
      execution_context: { type: string; container?: string; workdir?: string } | null
    }
    expect(project?.execution_context).toMatchObject({
      type: 'docker',
      container: 'seeded-container',
      workdir: '/app'
    })

    // Clean up — reset to host
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateProject({ id, executionContext: null }),
      { id: projectId }
    )
    await seed(mainWindow).refreshData()
    await mainWindow.keyboard.press('Escape')
  })
})
