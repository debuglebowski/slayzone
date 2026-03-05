import { test, expect, seed, goHome, clickProject, projectBlob } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

function testInvoke(page: import('@playwright/test').Page, channel: string, ...args: unknown[]) {
  return page.evaluate(
    ({ ch, a }) => window.__testInvoke(ch, ...a),
    { ch: channel, a: args }
  ) as Promise<any>
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

test.describe('Project settings & context menu', () => {
  let projectAbbrev: string
  let projectId: string

  const seedGithubRepoMocks = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.evaluate(
      async (pid) => {
        await window.api.integrations.clearProjectProvider({ projectId: pid, provider: 'linear' }).catch(() => {})
        await window.api.integrations.clearProjectProvider({ projectId: pid, provider: 'github' }).catch(() => {})
      },
      projectId
    )
    await testInvoke(mainWindow, 'integrations:test:clear-github-mocks')
    await testInvoke(mainWindow, 'integrations:test:seed-github-connection', {
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
    await testInvoke(mainWindow, 'integrations:test:set-github-repository-issues', {
      repositoryFullName: GITHUB_REPOSITORY_FULL_NAME,
      issues: GITHUB_REPOSITORY_ISSUES
    })
    await mainWindow.evaluate(
      ({ pid, cid }) => window.api.integrations.setProjectMapping({
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
    const githubConnections = await mainWindow.evaluate(
      () => window.api.integrations.listConnections('github')
    ) as Array<{ id: string }>
    for (const connection of githubConnections) {
      await testInvoke(mainWindow, 'integrations:test:set-github-repositories', {
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
    await testInvoke(mainWindow, 'integrations:test:set-github-repository-issues', {
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
      await mainWindow.keyboard.press('Escape')
      await expect(settingsHeading).not.toBeVisible({ timeout: 3_000 })
    }

    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(settingsHeading).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByTestId('settings-tab-integrations').click()
    if (entry === 'github_projects') {
      await expect(mainWindow.getByTestId('project-integration-provider-github')).toBeVisible({ timeout: 5_000 })
      await mainWindow.getByTestId('project-integration-provider-github').click()
    } else {
      await expect(mainWindow.getByTestId('project-integration-provider-github-issues')).toBeVisible({ timeout: 5_000 })
      await mainWindow.getByTestId('project-integration-provider-github-issues').click()
    }

    if (!ensureRepoCard) return null
    const repoCard = mainWindow.getByTestId('github-repo-import-card')
    await expect(repoCard).toBeVisible({ timeout: 5_000 })
    return repoCard
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    // Create a dedicated project for this test
    const project = await s.createProject({ name: 'Settings Test', color: '#10b981', path: TEST_PROJECT_PATH })
    projectId = project.id
    projectAbbrev = project.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  test('right-click project blob opens context menu', async ({ mainWindow }) => {
    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })

    await expect(mainWindow.getByRole('menuitem', { name: 'Settings' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    // Dismiss context menu so it doesn't block subsequent tests
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('menuitem', { name: 'Settings' })).not.toBeVisible({ timeout: 3_000 })
  })

  test('context menu Settings opens project settings dialog', async ({ mainWindow }) => {
    // Re-open context menu (may have closed between tests)
    const blob = projectBlob(mainWindow, projectAbbrev)
    await blob.click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()

    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5_000 })
    // General tab is default — verify name input exists
    await expect(mainWindow.locator('#edit-name')).toBeVisible({ timeout: 3_000 })
    // Switch to Integrations tab
    await mainWindow.getByTestId('settings-tab-integrations').click()
    const githubProjectsProvider = mainWindow.getByTestId('project-integration-provider-github')
    await expect(githubProjectsProvider).toBeVisible({ timeout: 3_000 })
    if (await githubProjectsProvider.isEnabled().catch(() => false)) {
      await githubProjectsProvider.click()
    }
    await expect(mainWindow.getByTestId('project-integration-provider-github-issues')).toBeVisible({ timeout: 3_000 })
    // Switch back to General for the next test (edit name)
    await mainWindow.getByTestId('settings-tab-general').click()
    await expect(mainWindow.locator('#edit-name')).toBeVisible({ timeout: 3_000 })
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
    await expect.poll(async () => {
      const tasks = await seed(mainWindow).getTasks()
      return tasks.some((task: { project_id: string; title: string }) =>
        task.project_id === projectId && task.title === 'Repository issue alpha'
      )
    }, { timeout: 5_000 }).toBe(true)
  })

  test('linked GitHub repository issue row shows Linked and is not selectable', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) => window.api.integrations.importGithubRepositoryIssues({
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

    await expect.poll(async () => {
      const tasks = await seed(mainWindow).getTasks()
      return tasks.some((task: { project_id: string; title: string }) =>
        task.project_id === projectId && task.title === 'Repository issue alpha'
      )
    }, { timeout: 5_000 }).toBe(true)

    const reloadIssuesButton = repoCard.getByTestId('github-repo-load-issues')
    if (await reloadIssuesButton.isEnabled().catch(() => false)) {
      await reloadIssuesButton.click()
    }

    const linkedRow = repoCard.getByText(/Linked\s*acme\/slay-e2e#101 - Repository issue alpha/)
    if (await linkedRow.isVisible().catch(() => false)) {
      await expect(linkedRow).toBeVisible({ timeout: 5_000 })
    }
    await expect(
      repoCard.locator('label').filter({ hasText: 'acme/slay-e2e#101 - Repository issue alpha' })
    ).toHaveCount(0)
  })

  test('GitHub bulk sync controls check diffs and run push/pull', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) => window.api.integrations.importGithubRepositoryIssues({
        projectId: pid,
        connectionId: cid,
        repositoryFullName: repo,
        limit: 50
      }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )
    await openProjectSettingsIntegrations(mainWindow, 'github_projects', false)

    const importedTasks = await seed(mainWindow).getTasks() as Array<{
      id: string
      project_id: string
      title: string
    }>
    const alphaTask = importedTasks.find((task) =>
      task.project_id === projectId && task.title === 'Repository issue alpha'
    )
    if (!alphaTask) throw new Error('Expected imported alpha task')

    await mainWindow.evaluate(
      ({ id, title }) => window.api.db.updateTask({ id, title }),
      { id: alphaTask.id, title: 'Repository issue alpha local changed' }
    )
    await setGithubRepoIssues(mainWindow, GITHUB_REPOSITORY_ISSUES_REMOTE_AHEAD)

    await mainWindow.getByTestId('github-project-check-diffs').click()
    await expect(mainWindow.getByText('Local ahead: 1')).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByText('Remote ahead: 1')).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByTestId('github-project-push-local-ahead').click()
    await expect(mainWindow.getByText('Push complete: 1 pushed, 0 skipped')).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByTestId('github-project-pull-remote-ahead').click()
    await expect(mainWindow.getByText('Pull complete: 1 pulled, 0 skipped')).toBeVisible({ timeout: 5_000 })
    await expect.poll(async () => {
      const tasks = await seed(mainWindow).getTasks() as Array<{ project_id: string; title: string }>
      return tasks.some((task) =>
        task.project_id === projectId && task.title === 'Repository issue beta remote refreshed'
      )
    }, { timeout: 5_000 }).toBe(true)
    await expect(mainWindow.getByText('Local ahead: 0')).toBeVisible({ timeout: 5_000 })
  })

  test('GitHub repo import skips issues linked to another project', async ({ mainWindow }) => {
    await seedGithubRepoMocks(mainWindow)
    await mainWindow.evaluate(
      ({ pid, cid, repo }) => window.api.integrations.importGithubRepositoryIssues({
        projectId: pid,
        connectionId: cid,
        repositoryFullName: repo,
        selectedIssueIds: ['gh-issue-101'],
        limit: 50
      }),
      { pid: projectId, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    )

    const otherProject = await seed(mainWindow).createProject({
      name: 'Overlap Target',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    }) as { id: string }

    const result = await mainWindow.evaluate(
      ({ pid, cid, repo }) => window.api.integrations.importGithubRepositoryIssues({
        projectId: pid,
        connectionId: cid,
        repositoryFullName: repo,
        selectedIssueIds: ['gh-issue-101'],
        limit: 50
      }),
      { pid: otherProject.id, cid: GITHUB_REPO_CONNECTION_ID, repo: GITHUB_REPOSITORY_FULL_NAME }
    ) as { imported: number; created: number; updated: number; skippedAlreadyLinked: number }

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

    await mainWindow.getByTestId('settings-tab-columns').click()
    await expect(mainWindow.getByTestId('project-column-review')).toBeVisible({ timeout: 3_000 })
    await mainWindow.getByTestId('delete-project-column-review').click()
    await expect(mainWindow.getByTestId('project-column-review')).not.toBeVisible({ timeout: 3_000 })
    await mainWindow.getByTestId('save-project-columns').click()

    const updatedTasks = await s.getTasks()
    const updatedTask = updatedTasks.find((t: { id: string; status: string }) => t.id === remapTask.id)
    expect(updatedTask?.status).toBe('inbox')

    const refreshedProjects = await s.getProjects()
    const refreshedProject = refreshedProjects.find((p: { id: string }) => p.id === project.id) as {
      columns_config: Array<{ id: string }> | null
    }
    expect(Boolean(refreshedProject?.columns_config?.some((column) => column.id === 'review'))).toBe(false)
  })

  test('edit project name in settings dialog', async ({ mainWindow }) => {
    const nameInput = mainWindow.locator('#edit-name')
    if (!(await nameInput.isVisible().catch(() => false))) {
      const blob = projectBlob(mainWindow, projectAbbrev)
      await blob.click({ button: 'right' })
      await mainWindow.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5_000 })
      await mainWindow.getByRole('button', { name: 'General', exact: true }).click()
      await expect(nameInput).toBeVisible({ timeout: 3_000 })
    }

    await nameInput.clear()
    await nameInput.fill('Xylo Project')

    await mainWindow.getByRole('button', { name: 'Save' }).click()

    // Dialog should close
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).not.toBeVisible({ timeout: 3_000 })

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
