import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { currentSession, seedSession } from '../fixtures/terminal'

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

  test('record a session for codex mode', async ({ mainWindow }) => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    // Session ids live on the task's computer (robustness plan §9).
    await seedSession(mainWindow, taskId, 'codex', conversationId)
    expect(await currentSession(mainWindow, taskId, 'codex')).toBe(conversationId)
  })

  test('record a session for cursor mode', async ({ mainWindow }) => {
    const conversationId = '11111111-2222-4333-8444-555555555555'
    // Session ids live on the task's computer (robustness plan §9).
    await seedSession(mainWindow, taskId, 'cursor-agent', conversationId)
    expect(await currentSession(mainWindow, taskId, 'cursor-agent')).toBe(conversationId)
  })

  test('record a session for gemini mode', async ({ mainWindow }) => {
    const conversationId = 'gemini-session-abc123'
    // Session ids live on the task's computer (robustness plan §9).
    await seedSession(mainWindow, taskId, 'gemini', conversationId)
    expect(await currentSession(mainWindow, taskId, 'gemini')).toBe(conversationId)
  })

  test('record a session for opencode mode', async ({ mainWindow }) => {
    const conversationId = 'opencode-session-xyz789'
    // Session ids live on the task's computer (robustness plan §9).
    await seedSession(mainWindow, taskId, 'opencode', conversationId)
    expect(await currentSession(mainWindow, taskId, 'opencode')).toBe(conversationId)
  })

  test('sessions of several modes coexist independently', async ({ mainWindow }) => {
    expect(await currentSession(mainWindow, taskId, 'codex')).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
    expect(await currentSession(mainWindow, taskId, 'cursor-agent')).toBe(
      '11111111-2222-4333-8444-555555555555'
    )
    expect(await currentSession(mainWindow, taskId, 'gemini')).toBe('gemini-session-abc123')
    expect(await currentSession(mainWindow, taskId, 'opencode')).toBe('opencode-session-xyz789')
  })

  test('update flags for gemini mode', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      ({ id, flags }) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, geminiFlags: flags }),
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

  test('reset one mode: the others keep their sessions', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.resetConversation.mutate({ id, mode: 'codex' }),
      taskId
    )
    expect(await currentSession(mainWindow, taskId, 'codex')).toBeNull()
    expect(await currentSession(mainWindow, taskId, 'cursor-agent')).toBe(
      '11111111-2222-4333-8444-555555555555'
    )
    expect(await currentSession(mainWindow, taskId, 'gemini')).toBe('gemini-session-abc123')
  })

  test('modes without a legacy column (qwen, copilot) keep sessions too', async ({
    mainWindow
  }) => {
    await seedSession(mainWindow, taskId, 'qwen-code', 'qwen-session-xyz')
    await seedSession(mainWindow, taskId, 'copilot', 'copilot-session-abc')
    expect(await currentSession(mainWindow, taskId, 'qwen-code')).toBe('qwen-session-xyz')
    expect(await currentSession(mainWindow, taskId, 'copilot')).toBe('copilot-session-abc')
  })

  test('a session id in a providerConfig update is not a hub value; flags merge as before', async ({
    mainWindow
  }) => {
    // Was spec 96's deep-merge cases: the hub entry merges per key, and a session id
    // never lands there (it is the computer ledger's, robustness plan §9).
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          providerConfig: { codex: { flags: '--keep-this-flag', conversationId: 'via-config' } }
        }),
      taskId
    )
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          providerConfig: { gemini: { flags: '--new-flag' } }
        }),
      taskId
    )
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    const config = task?.provider_config as Record<string, Record<string, unknown>> | undefined
    expect(config?.codex?.flags).toBe('--keep-this-flag')
    expect(config?.codex).not.toHaveProperty('conversationId')
    expect(config?.gemini?.flags).toBe('--new-flag')
    expect(await currentSession(mainWindow, taskId, 'codex')).toBeNull()
    expect(await currentSession(mainWindow, taskId, 'gemini')).toBe('gemini-session-abc123')
  })

  test('a subtask does not inherit its parent sessions', async ({ mainWindow }) => {
    const child = await seed(mainWindow).createTask({
      projectId,
      parentId: taskId,
      title: 'Provider config child',
      status: 'todo'
    })
    expect(await currentSession(mainWindow, child.id, 'gemini')).toBeNull()
    expect(await currentSession(mainWindow, child.id, 'cursor-agent')).toBeNull()
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
    // Set a custom default via agents table
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.agentsUpdate.mutate({
        id: 'claude-code',
        updates: { defaultFlags: '--test-default-flag' }
      })
    )

    const task = await mainWindow.evaluate(
      (pid) =>
        window
          .getTrpcVanillaClient()
          .task.create.mutate({ projectId: pid, title: 'Default flags task' }),
      projectId
    )
    expect(task?.claude_flags).toBe('--test-default-flag')

    // Restore default
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.agentsUpdate.mutate({
        id: 'claude-code',
        updates: { defaultFlags: '--allow-dangerously-skip-permissions' }
      })
    )
  })
})
