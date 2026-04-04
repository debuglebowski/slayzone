import { test, expect, seed, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

/**
 * Tests that changing worktree_path, base_dir, or project_id auto-clears
 * all conversation IDs while preserving flags (handlers.ts:383-397).
 */
test.describe('Worktree/project change clears conversation IDs', () => {
  let projectId: string
  let project2Id: string
  let taskId: string

  /** Seed conversationIds and flags for claude-code + codex on the test task */
  const seedConversationState = async (mainWindow: import('@playwright/test').Page, id: string) => {
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: {
          'claude-code': { conversationId: 'claude-conv-aaa', flags: '--claude-flag' },
          codex: { conversationId: 'codex-conv-bbb', flags: '--codex-flag' },
        },
      }),
      { id }
    )
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'WtClear', color: '#10b981', path: TEST_PROJECT_PATH })
    const p2 = await s.createProject({ name: 'WtClear2', color: '#f59e0b', path: TEST_PROJECT_PATH })
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
      ({ id }) => window.api.db.updateTask({ id, worktreePath: '/tmp/new-worktree' }),
      { id: taskId }
    )

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    // Conversation IDs should be cleared
    expect(task?.provider_config?.['claude-code']?.conversationId ?? null).toBeNull()
    expect(task?.provider_config?.codex?.conversationId ?? null).toBeNull()
    // Flags should survive
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')
  })

  test('changing baseDir clears conversationIds, preserves flags', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({ id, baseDir: '/tmp/new-base' }),
      { id: taskId }
    )

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.['claude-code']?.conversationId ?? null).toBeNull()
    expect(task?.provider_config?.codex?.conversationId ?? null).toBeNull()
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')
  })

  test('changing projectId clears conversationIds, preserves flags', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    await mainWindow.evaluate(
      ({ id, pid }) => window.api.db.updateTask({ id, projectId: pid }),
      { id: taskId, pid: project2Id }
    )

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.['claude-code']?.conversationId ?? null).toBeNull()
    expect(task?.provider_config?.codex?.conversationId ?? null).toBeNull()
    expect(task?.provider_config?.['claude-code']?.flags).toBe('--claude-flag')
    expect(task?.provider_config?.codex?.flags).toBe('--codex-flag')

    // Move back for subsequent tests
    await mainWindow.evaluate(
      ({ id, pid }) => window.api.db.updateTask({ id, projectId: pid }),
      { id: taskId, pid: projectId }
    )
  })

  test('changing worktree with explicit providerConfig skips auto-clear', async ({ mainWindow }) => {
    await seedConversationState(mainWindow, taskId)

    // Change worktree AND provide explicit providerConfig — auto-clear should NOT trigger
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        worktreePath: '/tmp/another-worktree',
        providerConfig: { 'claude-code': { conversationId: 'explicit-keep' } },
      }),
      { id: taskId }
    )

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    // claude-code should have the explicitly provided value (deep merged)
    expect(task?.provider_config?.['claude-code']?.conversationId).toBe('explicit-keep')
    // codex should also survive (auto-clear was suppressed by explicit providerConfig)
    expect(task?.provider_config?.codex?.conversationId).toBe('codex-conv-bbb')
  })
})
