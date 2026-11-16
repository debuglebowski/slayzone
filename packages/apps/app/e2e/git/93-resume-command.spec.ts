import { test, expect, seed, resetApp, proveConversationTurn } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  startAgentTerminal,
  closeAllTaskTabs,
  seedSession
} from '../fixtures/terminal'

/**
 * Verifies that the correct pty:create opts are sent when resuming vs starting fresh.
 * Mocks pty:create to capture the opts object without spawning real CLIs.
 */
// Migrated 2026-06-22: host pty:create spy orphaned by the slice-9 cutover; AI-mode
// terminals are idle-gated now, so click the "Open <agent>" starter (startAgentTerminal)
// to trigger the spawn and capture the opts at the createPty chokepoint (stubbed, no spawn).
test.describe('Resume command opts', () => {
  let projectAbbrev: string
  let projectId: string

  const installMock = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )

  const getLastOpts = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.evaluate(async () => {
      const all = (await window
        .getTrpcVanillaClient()
        .pty.testTakePtyCreateOpts.query()) as unknown[]
      return all[all.length - 1] ?? null
    }) as Promise<{
      sessionId: string
      conversationId?: string | null
      existingConversationId?: string | null
      /** What the spawn resumes (the ledger's, on the computer). */
      resumeConversationId?: string | null
      mode?: string
      providerArgs?: string[] | null
    } | null>

  const resetCapture = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    await installMock(mainWindow)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Resume Cmd',
      color: '#ec4899',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    await s.refreshData()
  })

  // Per-test terminal teardown: serial AI-mode opens otherwise accumulate
  // hidden mounted terminals that destabilize the shared createPty capture
  // for later tests (getLastOpts null for the 6th+ open).
  test.afterEach(async ({ mainWindow }) => {
    await closeAllTaskTabs(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: false })
    )
  })

  // --- Fresh start: no stored conversationId ---

  test('claude-code fresh start: conversationId is UUID, no existingConversationId', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    await s.createTask({ projectId, title: 'RC fresh claude', status: 'in_progress' })
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC fresh claude' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('claude-code')
    expect(opts?.resumeConversationId).toBeFalsy()
    // Fresh start should generate a UUID for conversationId
    expect(opts?.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  test('codex fresh start: no existingConversationId', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.createTask({
      projectId,
      title: 'RC fresh codex',
      status: 'in_progress',
      agentId: 'codex'
    })
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC fresh codex' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('codex')
    expect(opts?.resumeConversationId).toBeFalsy()
    // Codex initialCommand lacks {id} — no UUID should be generated
    expect(opts?.conversationId).toBeFalsy()
  })

  // --- Resume: stored conversationId flows through ---

  test('claude-code resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'claude-resume-11111111'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC resume claude', status: 'in_progress' })
    await seedSession(mainWindow, t.id, 'claude-code', storedId)
    await proveConversationTurn(mainWindow, t.id, storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume claude' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('claude-code')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  test('codex resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'codex-resume-22222222'
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC resume codex',
      status: 'in_progress',
      agentId: 'codex'
    })
    await seedSession(mainWindow, t.id, 'codex', storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume codex' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('codex')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  test('cursor-agent resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'cursor-resume-44444444'
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC resume cursor',
      status: 'in_progress',
      agentId: 'cursor-agent'
    })
    await seedSession(mainWindow, t.id, 'cursor-agent', storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume cursor' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('cursor-agent')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  test('opencode resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'opencode-resume-55555555'
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC resume opencode',
      status: 'in_progress',
      agentId: 'opencode'
    })
    await seedSession(mainWindow, t.id, 'opencode', storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume opencode' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('opencode')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  test('qwen-code resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'qwen-resume-66666666'
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC resume qwen',
      status: 'in_progress',
      agentId: 'qwen-code'
    })
    await seedSession(mainWindow, t.id, 'qwen-code', storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume qwen' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('qwen-code')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  test('copilot resume: existingConversationId equals stored ID', async ({ mainWindow }) => {
    const storedId = 'copilot-resume-77777777'
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC resume copilot',
      status: 'in_progress',
      agentId: 'copilot'
    })
    await seedSession(mainWindow, t.id, 'copilot', storedId)
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC resume copilot' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.mode).toBe('copilot')
    expect(opts?.resumeConversationId).toBe(storedId)
  })

  // --- providerConfig (not legacy fields) feeds resume ---

  test('providerConfig update feeds resume correctly', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({
      projectId,
      title: 'RC cfg path',
      status: 'in_progress',
      agentId: 'codex'
    })
    // Use providerConfig field (not legacy codexConversationId)
    await seedSession(mainWindow, t.id, 'codex', 'via-provider-config')
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC cfg path' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    expect(opts?.resumeConversationId).toBe('via-provider-config')
  })

  // --- Flags flow through as providerFlags ---

  test('provider flags flow through in pty:create opts', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'RC flags test', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id }) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          providerConfig: { 'claude-code': { flags: '--custom-test-flag --verbose' } }
        }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'RC flags test' })
    await startAgentTerminal(mainWindow)

    await expect.poll(() => getLastOpts(mainWindow), { timeout: 10_000 }).not.toBeNull()
    const opts = await getLastOpts(mainWindow)
    const args = (opts?.providerArgs ?? []).join(' ')
    expect(args).toContain('--custom-test-flag')
    expect(args).toContain('--verbose')
  })
})
