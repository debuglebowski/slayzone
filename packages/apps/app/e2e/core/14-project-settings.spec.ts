import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  projectBlob,
  resetApp
} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page, Locator } from '@playwright/test'

/** Click a testid-identified button via evaluate (immune to element detach).
 *  Waits for the button to not be disabled before clicking. */
async function clickByTestId(mainWindow: Page, testId: string): Promise<void> {
  await mainWindow.evaluate(async (tid) => {
    // Wait briefly for button to exist and not be disabled
    for (let i = 0; i < 10; i++) {
      const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLButtonElement | null
      if (el && !el.disabled) {
        el.click()
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    // Last resort: click even if disabled
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
    el?.click()
  }, testId)
}

/** Retry-click a settings tab that may detach during React re-renders */
async function clickSettingsTab(
  mainWindow: Page,
  tab: Locator,
  readyLocator: Locator
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await readyLocator.isVisible({ timeout: 300 }).catch(() => false)) return
    await tab.click().catch(() => {})
    if (await readyLocator.isVisible({ timeout: 500 }).catch(() => false)) return
    await mainWindow.waitForTimeout(80)
  }
  await expect(readyLocator).toBeVisible({ timeout: 3_000 })
}

const GITHUB_REPO_CONNECTION_ID = 'gh-e2e-settings'
const GITHUB_REPOSITORY_FULL_NAME = 'acme/slay-e2e'

const GITHUB_REPOSITORY_ISSUES = [
  {
    id: 'gh-issue-101',
    number: 101,
    title: 'Repository issue alpha',
    body: 'Issue body alpha',
    updatedAt: '2026-03-04T10:00:00Z',
    state: 'open' as const,
    assignee: null,
    labels: [],
    repository: {
      owner: 'acme',
      name: 'slay-e2e',
      fullName: GITHUB_REPOSITORY_FULL_NAME
    },
    url: 'https://github.com/acme/slay-e2e/issues/101'
  },
  {
    id: 'gh-issue-102',
    number: 102,
    title: 'Repository issue beta',
    body: 'Issue body beta',
    updatedAt: '2026-03-04T11:00:00Z',
    state: 'closed' as const,
    assignee: null,
    labels: [],
    repository: {
      owner: 'acme',
      name: 'slay-e2e',
      fullName: GITHUB_REPOSITORY_FULL_NAME
    },
    url: 'https://github.com/acme/slay-e2e/issues/102'
  }
]

const GITHUB_REPOSITORY_ISSUES_REMOTE_AHEAD = [
  {
    ...GITHUB_REPOSITORY_ISSUES[0],
    updatedAt: '2026-03-04T10:30:00Z'
  },
  {
    ...GITHUB_REPOSITORY_ISSUES[1],
    title: 'Repository issue beta remote refreshed',
    updatedAt: '2026-03-04T12:40:00Z'
  }
]

const GITHUB_STATUS_OPTIONS = [
  { id: 'gh-status-inbox', name: 'Inbox', color: 'gray' },
  { id: 'gh-status-backlog', name: 'Backlog', color: 'slate' },
  { id: 'gh-status-todo', name: 'To Do', color: 'blue' },
  { id: 'gh-status-in-progress', name: 'In Progress', color: 'yellow' },
  { id: 'gh-status-review', name: 'Review', color: 'purple' },
  { id: 'gh-status-done', name: 'Done', color: 'green' }
]

const githubTest = {
  clearMocks: (page: Page) =>
    page.evaluate(() => window.getTrpcVanillaClient().integrations.testClearGithubMocks.mutate()),
  seedConnection: (
    page: Page,
    input: {
      id?: string
      projectId?: string
      token?: string
      repositories?: Array<{
        id: string
        owner: string
        name: string
        fullName: string
        private: boolean
      }>
    }
  ) =>
    page.evaluate(
      (payload) =>
        window.getTrpcVanillaClient().integrations.testSeedGithubConnection.mutate(payload),
      input
    ),
  setRepositories: (
    page: Page,
    input: {
      connectionId: string
      repositories: Array<{
        id: string
        owner: string
        name: string
        fullName: string
        private: boolean
      }>
    }
  ) =>
    page.evaluate(
      (payload) =>
        window.getTrpcVanillaClient().integrations.testSetGithubRepositories.mutate(payload),
      input
    ),
  setRepositoryIssues: (
    page: Page,
    input: {
      repositoryFullName: string
      issues: typeof GITHUB_REPOSITORY_ISSUES
    }
  ) =>
    page.evaluate(
      (payload) =>
        window.getTrpcVanillaClient().integrations.testSetGithubRepositoryIssues.mutate(payload),
      input
    )
}

test.describe('Project settings & context menu', () => {
  let projectAbbrev: string
  let projectId: string

  const seedGithubRepoMocks = async (mainWindow: import('@playwright/test').Page) => {
    // clearProjectProvider deletes external_links but not the tasks themselves,
    // so orphaned duplicates accumulate across tests that re-import the same
    // GitHub issues. Clear providers first (removes links), then delete tasks
    // (deleteTask blocks if external_links exist).
    await mainWindow.evaluate(async (pid) => {
      const c = window.getTrpcVanillaClient()
      await c.integrations.clearProjectProvider
        .mutate({ projectId: pid, provider: 'linear' })
        .catch(() => {})
      await c.integrations.clearProjectProvider
        .mutate({ projectId: pid, provider: 'github' })
        .catch(() => {})
      const tasks = (await c.task.getByProject.query({ projectId: pid })) as Array<{ id: string }>
      for (const task of tasks) await c.task.delete.mutate({ id: task.id })
    }, projectId)
    await githubTest.clearMocks(mainWindow)
    await githubTest.seedConnection(mainWindow, {
      id: GITHUB_REPO_CONNECTION_ID,
      projectId,
      repositories: [
        {
          id: 'repo-e2e-1',
          owner: 'acme',
          name: 'slay-e2e',
          fullName: GITHUB_REPOSITORY_FULL_NAME,
          private: false
        }
      ]
    })
    await githubTest.setRepositoryIssues(mainWindow, {
      repositoryFullName: GITHUB_REPOSITORY_FULL_NAME,
      issues: GITHUB_REPOSITORY_ISSUES
    })
    await mainWindow.evaluate(
      ({ pid, cid }) =>
        window.getTrpcVanillaClient().integrations.setProjectMapping.mutate({
          projectId: pid,
          provider: 'github',
          connectionId: cid,
          externalTeamId: 'acme',
          externalTeamKey: 'acme#1',
          externalProjectId: 'PVT_test',
          syncMode: 'one_way'
        }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID }
    )
    await mainWindow.evaluate(
      ({ pid, statuses }) =>
        window.getTrpcVanillaClient().integrations.applyStatusSync.mutate({
          projectId: pid,
          provider: 'github',
          statuses
        }),
      { pid: projectId, statuses: GITHUB_STATUS_OPTIONS }
    )
    const githubConnections = (await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().integrations.listConnections.query({ provider: 'github' })
    )) as Array<{ id: string }>
    for (const connection of githubConnections) {
      await githubTest.setRepositories(mainWindow, {
        connectionId: connection.id,
        repositories: [
          {
            id: 'repo-e2e-1',
            owner: 'acme',
            name: 'slay-e2e',
            fullName: GITHUB_REPOSITORY_FULL_NAME,
            private: false
          }
        ]
      })
    }
  }

  const setGithubRepoIssues = async (
    mainWindow: import('@playwright/test').Page,
    issues: typeof GITHUB_REPOSITORY_ISSUES
  ) => {
    await githubTest.setRepositoryIssues(mainWindow, {
      repositoryFullName: GITHUB_REPOSITORY_FULL_NAME,
      issues
    })
  }

  const openProjectSettingsIntegrations = async (
    mainWindow: import('@playwright/test').Page,
    entry: 'github_projects' | 'github_issues' = 'github_projects',
    ensureRepoCard = true
  ) => {
    const settingsHeading = mainWindow.getByRole('heading', { name: 'Project Settings' })
    if (await settingsHeading.isVisible().catch(() => false)) {
      // Dismiss dialog — may need multiple attempts because Escape can be
      // swallowed by focused sub-elements (dropdowns, popovers, etc.)
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!(await settingsHeading.isVisible().catch(() => false))) break
        const overlay = mainWindow.locator('[data-radix-dialog-overlay]')
        if (await overlay.isVisible({ timeout: 300 }).catch(() => false)) {
          await overlay.click({ position: { x: 5, y: 5 }, force: true })
        } else {
          await mainWindow.keyboard.press('Escape')
        }
        await mainWindow.waitForTimeout(200)
      }
      await expect(settingsHeading).not.toBeVisible({ timeout: 3_000 })
    }

    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(settingsHeading).toBeVisible({ timeout: 5_000 })

    const integrationsReady =
      entry === 'github_projects'
        ? mainWindow.getByTestId('project-integration-provider-github')
        : mainWindow.getByTestId('project-integration-provider-github-issues')
    await clickSettingsTab(
      mainWindow,
      mainWindow.getByTestId('settings-tab-integrations'),
      integrationsReady
    )
    await integrationsReady.click()

    if (!ensureRepoCard) return null
    const repoCard = mainWindow.getByTestId('github-repo-import-card')
    await expect(repoCard).toBeVisible({ timeout: 5_000 })
    return repoCard
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    // Create a dedicated project for this test
    const project = await s.createProject({
      name: 'Settings Test',
      color: '#10b981',
      path: TEST_PROJECT_PATH
    })
    projectId = project.id
    projectAbbrev = project.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  test('right-click project blob opens context menu', async ({ mainWindow }) => {
    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })

    await expect(mainWindow.getByRole('menuitem', { name: 'Settings' })).toBeVisible({
      timeout: 3_000
    })
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    // Dismiss context menu so it doesn't block subsequent tests
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('menuitem', { name: 'Settings' })).not.toBeVisible({
      timeout: 3_000
    })
  })

  test('context menu Settings opens project settings dialog', async ({ mainWindow }) => {
    // Re-open context menu (may have closed between tests)
    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()

    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({
      timeout: 5_000
    })
    // General tab is default — verify name input exists
    await expect(mainWindow.locator('#edit-name')).toBeVisible({ timeout: 3_000 })
    // Switch to Integrations tab
    const githubProjectsProvider = mainWindow.getByTestId('project-integration-provider-github')
    await clickSettingsTab(
      mainWindow,
      mainWindow.getByTestId('settings-tab-integrations'),
      githubProjectsProvider
    )
    if (await githubProjectsProvider.isEnabled().catch(() => false)) {
      await githubProjectsProvider.click()
    }
    await expect(mainWindow.getByTestId('project-integration-provider-github-issues')).toBeVisible({
      timeout: 3_000
    })
    // Switch back to General for the next test (edit name)
    await clickSettingsTab(
      mainWindow,
      mainWindow.getByTestId('settings-tab-general'),
      mainWindow.locator('#edit-name')
    )
  })

  test('imports GitHub repository issues via project settings', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    const repoCard = await openProjectSettingsIntegrations(mainWindow, 'github_issues')
    if (!repoCard) throw new Error('Expected repo card')

    const loadIssuesButton = repoCard.getByTestId('github-repo-load-issues')
    await expect(loadIssuesButton).toBeEnabled({ timeout: 5_000 })
    await loadIssuesButton.click()
    await expect(repoCard.getByText('2 issues loaded')).toBeVisible({ timeout: 5_000 })

    await repoCard
      .locator('label')
      .filter({ hasText: 'acme/slay-e2e#101 - Repository issue alpha' })
      .first()
      .click()
    await expect(repoCard.getByText('1 selected')).toBeVisible()

    await repoCard.getByTestId('github-repo-import-issues').click()
    await expect
      .poll(
        async () => {
          const tasks = await seed(mainWindow).getTasks()
          return tasks.some(
            (task: { project_id: string; title: string }) =>
              task.project_id === projectId && task.title === 'Repository issue alpha'
          )
        },
        { timeout: 5_000 }
      )
      .toBe(true)
  })

  test('linked GitHub repository issue row shows Linked and is not selectable', async ({
    mainWindow
  }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) =>
        window.getTrpcVanillaClient().integrations.importGithubRepositoryIssues.mutate({
          projectId: pid,
          connectionId: cid,
          repositoryFullName: repo,
          selectedIssueIds: ['gh-issue-101'],
          limit: 50
        }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )

    const repoCard = await openProjectSettingsIntegrations(mainWindow, 'github_issues')
    if (!repoCard) throw new Error('Expected repo card')

    await expect
      .poll(
        async () => {
          const tasks = await seed(mainWindow).getTasks()
          return tasks.some(
            (task: { project_id: string; title: string }) =>
              task.project_id === projectId && task.title === 'Repository issue alpha'
          )
        },
        { timeout: 5_000 }
      )
      .toBe(true)

    const reloadIssuesButton = repoCard.getByTestId('github-repo-load-issues')
    await expect(reloadIssuesButton).toBeEnabled({ timeout: 5_000 })
    await reloadIssuesButton.click()
    // Wait for issues to load before asserting
    await expect(repoCard.getByText(/issues loaded/)).toBeVisible({ timeout: 5_000 })

    // Issue #101 should show as "Linked" (not a selectable checkbox label)
    await expect(
      repoCard.getByText(/Linked\s*acme\/slay-e2e#101 - Repository issue alpha/)
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      repoCard.locator('label').filter({ hasText: 'acme/slay-e2e#101 - Repository issue alpha' })
    ).toHaveCount(0)
  })

  test('GitHub bulk sync controls check diffs and run push/pull', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) =>
        window.getTrpcVanillaClient().integrations.importGithubRepositoryIssues.mutate({
          projectId: pid,
          connectionId: cid,
          repositoryFullName: repo,
          limit: 50
        }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )
    // Do data manipulation BEFORE opening dialog to avoid re-render closing it
    const importedTasks = (await seed(mainWindow).getTasks()) as Array<{
      id: string
      project_id: string
      title: string
    }>
    const alphaTask = importedTasks.find(
      (task) => task.project_id === projectId && task.title === 'Repository issue alpha'
    )
    if (!alphaTask) throw new Error('Expected imported alpha task')

    await mainWindow.evaluate(
      ({ id, title }) => window.getTrpcVanillaClient().task.update.mutate({ id, title }),
      {
        id: alphaTask.id,
        title: 'Repository issue alpha local changed'
      }
    )
    await setGithubRepoIssues(mainWindow, GITHUB_REPOSITORY_ISSUES_REMOTE_AHEAD)

    /** Wait for button to be enabled, click it, then wait for result text in dialog. */
    const clickSyncButton = async (testId: string, resultText?: string) => {
      await mainWindow.waitForFunction(
        (tid) => {
          const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLButtonElement | null
          return el != null && !el.disabled
        },
        testId,
        { timeout: 3_000 }
      )
      await clickByTestId(mainWindow, testId)
      if (!resultText) return
      await mainWindow.waitForFunction(
        (text) => {
          const dialog = document.querySelector('[role="dialog"]')
          return dialog?.textContent?.includes(text) ?? false
        },
        resultText,
        { timeout: 5_000 }
      )
    }

    await openProjectSettingsIntegrations(mainWindow, 'github_projects', false)
    await clickSyncButton('project-check-diffs', 'Local ahead: 1')
    await expect(mainWindow.getByText('Remote ahead: 1')).toBeVisible({ timeout: 3_000 })

    await clickSyncButton('project-push-local-ahead', 'Push complete: 1 pushed, 0 skipped')

    await clickSyncButton('project-check-diffs', 'Remote ahead: 1')
    await clickSyncButton('project-pull-remote-ahead')
    await expect
      .poll(
        async () => {
          const tasks = (await seed(mainWindow).getTasks()) as Array<{
            project_id: string
            title: string
          }>
          return tasks.some(
            (task) =>
              task.project_id === projectId &&
              task.title === 'Repository issue beta remote refreshed'
          )
        },
        { timeout: 3_000 }
      )
      .toBe(true)
  })

  test('GitHub repo import skips issues linked to another project', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) =>
        window.getTrpcVanillaClient().integrations.importGithubRepositoryIssues.mutate({
          projectId: pid,
          connectionId: cid,
          repositoryFullName: repo,
          selectedIssueIds: ['gh-issue-101'],
          limit: 50
        }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )

    const otherProject = (await seed(mainWindow).createProject({
      name: 'Overlap Target',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })) as { id: string }

    const result = (await mainWindow.evaluate(
      ({ pid, cid, repo }) =>
        window.getTrpcVanillaClient().integrations.importGithubRepositoryIssues.mutate({
          projectId: pid,
          connectionId: cid,
          repositoryFullName: repo,
          selectedIssueIds: ['gh-issue-101'],
          limit: 50
        }),
      { pid: otherProject.id, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )) as { imported: number; created: number; updated: number; skippedAlreadyLinked: number }

    expect(result.imported).toBe(0)
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.skippedAlreadyLinked).toBe(1)
  })

  test('deleting a column remaps tasks to the project default status', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const project = projects.find((p: { id: string; name: string }) => p.name === 'Settings Test')
    if (!project) throw new Error('Settings Test project not found')

    const remapTask = await s.createTask({
      projectId: project.id,
      title: 'Needs status remap',
      status: 'review'
    })
    await s.refreshData()

    const settingsHeading = mainWindow.getByRole('heading', { name: 'Project Settings' })
    const isOpen = await settingsHeading.isVisible().catch(() => false)
    if (!isOpen) {
      const blob = projectBlob(mainWindow, projectAbbrev)
      await blob.click({ button: 'right' })
      await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(settingsHeading).toBeVisible({ timeout: 5_000 })
    }

    await clickSettingsTab(
      mainWindow,
      mainWindow.getByTestId('settings-tab-tasks/statuses'),
      mainWindow.getByTestId('project-column-review')
    )
    await mainWindow.getByTestId('delete-project-column-review').click()
    await expect(mainWindow.getByTestId('project-column-review')).not.toBeVisible({
      timeout: 3_000
    })
    await mainWindow.getByTestId('save-project-columns').click()

    await expect
      .poll(async () => {
        const refreshedProjects = await s.getProjects()
        const refreshedProject = refreshedProjects.find((p: { id: string }) => p.id === project.id) as
          | { columns_config: Array<{ id: string }> | null }
          | undefined
        return Boolean(refreshedProject?.columns_config?.some((column) => column.id === 'review'))
      })
      .toBe(false)

    await expect
      .poll(async () => {
        const updatedTasks = await s.getTasks()
        return updatedTasks.find((t: { id: string; status: string }) => t.id === remapTask.id)
          ?.status
      })
      .toBe('inbox')
  })

  test('edit project name in settings dialog', async ({ mainWindow }) => {
    const nameInput = mainWindow.locator('#edit-name')
    if (!(await nameInput.isVisible().catch(() => false))) {
      const blob = projectBlob(mainWindow, projectAbbrev)
      await blob.click({ button: 'right' })
      await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({
        timeout: 5_000
      })
      await clickSettingsTab(
        mainWindow,
        mainWindow.getByRole('button', { name: 'General', exact: true }),
        nameInput
      )
    }

    await nameInput.clear()
    await nameInput.fill('Xylo Project')

    await mainWindow.getByRole('button', { name: 'Save' }).click()

    // Dialog should close
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).not.toBeVisible({
      timeout: 3_000
    })

    // Sidebar should show new abbreviation
    projectAbbrev = 'XY'
    await expect(projectBlob(mainWindow, 'XY')).toBeVisible({ timeout: 3_000 })
  })

  test('project rename persisted in DB', async ({ mainWindow }) => {
    const projects = await seed(mainWindow).getProjects()
    const renamed = projects.find((p: { name: string }) => p.name === 'Xylo Project')
    expect(renamed).toBeTruthy()
  })

  test('context menu Delete action can be invoked', async ({ mainWindow }) => {
    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Delete' }).click()

    const deleteDialog = mainWindow.locator('[role="dialog"][aria-modal="true"]:visible').last()
    if (await deleteDialog.isVisible({ timeout: 1_200 }).catch(() => false)) {
      const cancelBtn = deleteDialog.getByRole('button', { name: /Cancel/i })
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click()
      } else {
        await mainWindow.keyboard.press('Escape')
      }
      await expect(deleteDialog).not.toBeVisible({ timeout: 3_000 })
    }
  })
})
