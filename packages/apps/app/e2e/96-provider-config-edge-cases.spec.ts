import { test, expect, seed, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

test.describe('Provider config edge cases', () => {
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CfgEdge', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectId = p.id
    const t = await s.createTask({ projectId: p.id, title: 'Edge case task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
  })

  test('set conversationId via providerConfig syncs to legacy column', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { codex: { conversationId: 'via-config-abc' } },
      }),
      { id: taskId }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.codex?.conversationId).toBe('via-config-abc')
    // Legacy column should be synced by dual-write
    expect(task?.codex_conversation_id).toBe('via-config-abc')
  })

  test('deep merge: updating conversationId preserves existing flags', async ({ mainWindow }) => {
    // Set flags first
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { codex: { flags: '--keep-this-flag' } },
      }),
      { id: taskId }
    )
    // Now update only conversationId
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { codex: { conversationId: 'merge-test-id' } },
      }),
      { id: taskId }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.codex?.conversationId).toBe('merge-test-id')
    expect(task?.provider_config?.codex?.flags).toBe('--keep-this-flag')
  })

  test('deep merge: updating flags preserves existing conversationId', async ({ mainWindow }) => {
    // Set conversationId first
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { gemini: { conversationId: 'gemini-persist' } },
      }),
      { id: taskId }
    )
    // Now update only flags
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { gemini: { flags: '--new-flag' } },
      }),
      { id: taskId }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.gemini?.conversationId).toBe('gemini-persist')
    expect(task?.provider_config?.gemini?.flags).toBe('--new-flag')
  })

  test('provider_config JSON matches legacy columns after update', async ({ mainWindow }) => {
    const cid = 'sync-check-id-123'
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: cid } },
      }),
      { id: taskId, cid }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.['claude-code']?.conversationId).toBe(cid)
    expect(task?.claude_conversation_id).toBe(cid)
  })

  test('set conversationId on task with empty provider_config', async ({ mainWindow }) => {
    // Create a fresh task (provider_config will have default flags but no conversationIds)
    const fresh = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'Fresh config task' }),
      projectId
    )
    // Set conversationId on it
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: 'first-ever-id' } },
      }),
      { id: fresh!.id }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), fresh!.id)
    expect(task?.provider_config?.['claude-code']?.conversationId).toBe('first-ever-id')
  })

  test('qwen conversationId roundtrip (no legacy column)', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'qwen-code': { conversationId: 'qwen-session-xyz' } },
      }),
      { id: taskId }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.['qwen-code']?.conversationId).toBe('qwen-session-xyz')
  })

  test('copilot conversationId roundtrip (no legacy column)', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { copilot: { conversationId: 'copilot-session-abc' } },
      }),
      { id: taskId }
    )
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.provider_config?.copilot?.conversationId).toBe('copilot-session-abc')
  })

  test('subtask does not inherit parent conversationId', async ({ mainWindow }) => {
    // Set conversationId on parent
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: 'parent-session' } },
      }),
      { id: taskId }
    )

    // Create subtask
    const subtask = await mainWindow.evaluate(
      ({ pid, parentId }) => window.api.db.createTask({
        projectId: pid,
        title: 'Child task',
        parentId,
      }),
      { pid: projectId, parentId: taskId }
    )

    const child = await mainWindow.evaluate((id) => window.api.db.getTask(id), subtask!.id)
    // Subtask should NOT have parent's conversationId
    expect(child?.provider_config?.['claude-code']?.conversationId ?? null).toBeNull()
  })
})
