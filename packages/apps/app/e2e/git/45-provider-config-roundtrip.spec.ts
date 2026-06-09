import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Provider config roundtrip', () => {
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'ProvCfg RT',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    const t = await s.createTask({ projectId: p.id, title: 'Provider config task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
  })

  test('new task has default flags from settings', async ({ mainWindow }) => {
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    // Default claude flags should be populated
    expect(task?.claude_flags).toBeTruthy()
    expect(typeof task?.claude_flags).toBe('string')
    // Default codex flags should be populated
    expect(task?.codex_flags).toBeTruthy()
    expect(typeof task?.codex_flags).toBe('string')
  })

  test('update conversationId for codex mode', async ({ mainWindow }) => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, codexConversationId: cid }),
      { id: taskId, cid: conversationId }
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.codex_conversation_id).toBe(conversationId)
  })

  test('update conversationId for cursor mode', async ({ mainWindow }) => {
    const conversationId = '11111111-2222-4333-8444-555555555555'
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, cursorConversationId: cid }),
      { id: taskId, cid: conversationId }
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.cursor_conversation_id).toBe(conversationId)
  })

  test('update conversationId for gemini mode', async ({ mainWindow }) => {
    const conversationId = 'gemini-session-abc123'
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, geminiConversationId: cid }),
      { id: taskId, cid: conversationId }
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.gemini_conversation_id).toBe(conversationId)
  })

  test('update conversationId for opencode mode', async ({ mainWindow }) => {
    const conversationId = 'opencode-session-xyz789'
    await mainWindow.evaluate(
      ({ id, cid }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, opencodeConversationId: cid }),
      { id: taskId, cid: conversationId }
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.opencode_conversation_id).toBe(conversationId)
  })

  test('multiple conversation IDs coexist independently', async ({ mainWindow }) => {
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    // All previously set IDs should still be present
    expect(task?.codex_conversation_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(task?.cursor_conversation_id).toBe('11111111-2222-4333-8444-555555555555')
    expect(task?.gemini_conversation_id).toBe('gemini-session-abc123')
    expect(task?.opencode_conversation_id).toBe('opencode-session-xyz789')
  })

  test('update flags for gemini mode', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      ({ id, flags }) => window.getTrpcVanillaClient().task.update.mutate({ id, geminiFlags: flags }),
      { id: taskId, flags: '--sandbox --verbose' }
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.gemini_flags).toBe('--sandbox --verbose')
  })

  test('update flags does not affect other providers', async ({ mainWindow }) => {
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    // Gemini flags changed, others should be their defaults
    expect(task?.gemini_flags).toBe('--sandbox --verbose')
    // Other flags should still be their defaults (not empty)
    expect(task?.claude_flags).toBeTruthy()
    expect(task?.codex_flags).toBeTruthy()
  })

  test('clear a single conversation ID via null', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, codexConversationId: null }),
      taskId
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.codex_conversation_id).toBeNull()
    // Others should be unaffected
    expect(task?.cursor_conversation_id).toBe('11111111-2222-4333-8444-555555555555')
    expect(task?.gemini_conversation_id).toBe('gemini-session-abc123')
  })

  test('create task with explicit flags override', async ({ mainWindow }) => {
    const task = await mainWindow.evaluate(
      (pid) =>
        window.getTrpcVanillaClient().task.create.mutate({
          projectId: pid,
          title: 'Custom flags task',
          claudeFlags: '--my-custom-flag',
          codexFlags: '--custom-codex'
        }),
      projectId
    )
    expect(task?.claude_flags).toBe('--my-custom-flag')
    expect(task?.codex_flags).toBe('--custom-codex')
  })

  test('default flags setting is used for new tasks', async ({ mainWindow }) => {
    // Set a custom default via terminal_modes table
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.modesUpdate.mutate({
        id: 'claude-code',
        updates: { defaultFlags: '--test-default-flag' }
      })
    )

    const task = await mainWindow.evaluate(
      (pid) =>
        window.getTrpcVanillaClient().task.create.mutate({ projectId: pid, title: 'Default flags task' }),
      projectId
    )
    expect(task?.claude_flags).toBe('--test-default-flag')

    // Restore default
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.modesUpdate.mutate({
        id: 'claude-code',
        updates: { defaultFlags: '--allow-dangerously-skip-permissions' }
      })
    )
  })
})
