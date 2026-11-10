import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { currentSession, seedSession } from '../fixtures/terminal'

/**
 * Tests that changing worktree_path, base_dir, or project_id resets every session of
 * the task (a reset intent its computer applies to its session ledger, robustness
 * plan §9) while preserving flags.
 */
test.describe('Worktree/project change clears conversation IDs', () => {
  let projectId: string
  let project2Id: string
  let taskId: string

  /**
   * A folder the task's computer accepts as this task's (§9 7e: it judges every path a
   * user sets — inside its allowed roots, never in another task's or project's folder).
   */
  const folder = (name: string) => `${TEST_PROJECT_PATH}-wt-clearing/${name}`

  /** Seed sessions (on the task's computer) and flags for claude-code + codex */
  const seedConversationState = async (mainWindow: import('@playwright/test').Page, id: string) => {
    await mainWindow.evaluate(
      ({ id }) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          providerConfig: {
            'claude-code': { flags: '--claude-flag' },
            codex: { flags: '--codex-flag' }
          }
        }),
      { id }
    )
    // A session newer than any earlier reset.
    await new Promise((r) => setTimeout(r, 5))
    await seedSession(mainWindow, id, 'codex', 'codex-conv-bbb')
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'WtClear', color: '#10b981', path: TEST_PROJECT_PATH })
    const p2 = await s.createProject({
      name: 'WtClear2',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    project2Id = p2.id
    const t = await s.createTask({ projectId: p.id, title: 'Wt clearing task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
  })

  test('changing worktreePath clears conversationIds, preserves flags', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    // Change worktree path without explicit providerConfig
    await mainWindow.evaluate(
      ({ id, worktreePath }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, worktreePath }),
      { id: taskId, worktreePath: folder('new-worktree') }
    )

    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    // The sessions reset
    expect(await currentSession(mainWindow, taskId, 'codex')).toBeNull()
    // Flags should survive
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')
  })

  test('changing baseDir clears conversationIds, preserves flags', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    await mainWindow.evaluate(
      ({ id, baseDir }) => window.getTrpcVanillaClient().task.update.mutate({ id, baseDir }),
      { id: taskId, baseDir: folder('new-base') }
    )

    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(await currentSession(mainWindow, taskId, 'codex')).toBeNull()
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')
  })

  test('changing projectId clears conversationIds, preserves flags', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    await mainWindow.evaluate(
      ({ id, pid }) => window.getTrpcVanillaClient().task.update.mutate({ id, projectId: pid }),
      { id: taskId, pid: project2Id }
    )

    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(await currentSession(mainWindow, taskId, 'codex')).toBeNull()
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')

    // Move back for subsequent tests
    await mainWindow.evaluate(
      ({ id, pid }) => window.getTrpcVanillaClient().task.update.mutate({ id, projectId: pid }),
      { id: taskId, pid: projectId }
    )
  })

  test('changing worktree with explicit providerConfig skips auto-clear', async ({
    mainWindow
  }) => {
    await seedConversationState(mainWindow, taskId)

    // Change worktree AND provide explicit providerConfig — auto-clear should NOT trigger
    await mainWindow.evaluate(
      ({ id, worktreePath }) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          worktreePath,
          providerConfig: { 'claude-code': { flags: '--explicit' } }
        }),
      { id: taskId, worktreePath: folder('another-worktree') }
    )

    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--explicit')
    // The session survives (the reset was suppressed by the explicit providerConfig)
    expect(await currentSession(mainWindow, taskId, 'codex')).toBe('codex-conv-bbb')
  })
})
