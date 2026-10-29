/**
 * Claude Code chat: compaction, local slash-command output, the context meter,
 * the CLI's own `/` commands and prompt history — as a reopened chat shows them.
 *
 * No agent subprocess: the session is seeded straight into `chat_events` (shapes
 * from the recorded CLI 2.1.312 transcripts in terminal/test/fixtures/claude-stream/
 * chatui-*.ndjson) and the task's prompt history into `agent_prompts`, which
 * chat.hydrate + the composer load without spawning (startup = manual). Nothing
 * here presses Enter on a command — that would start a real CLI.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskViaSearch } from '../fixtures/browser-view'

const MODEL = 'claude-haiku-5-5'

const usage = (input: number, cacheWrite: number, cacheRead: number, output = 4) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite
})

/** A result as Claude reports it: cumulative session cost + per-model accounting. */
const result = (totalCostUsd: number, text: string | null) => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1000,
  durationApiMs: 900,
  numTurns: 1,
  totalCostUsd,
  stopReason: 'end_turn',
  terminalReason: 'completed',
  text,
  modelUsage: {
    [MODEL]: {
      ...usage(18152, 59654, 121314, 606),
      costUsd: totalCostUsd,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000
    }
  },
  usage: usage(0, 0, 0, 0),
  permissionDenials: []
})

const EVENTS = [
  {
    kind: 'turn-init',
    sessionId: 'seeded-session',
    model: MODEL,
    cwd: TEST_PROJECT_PATH,
    tools: [],
    slashCommands: ['compact', 'context', 'usage', 'doctor', 'simplify'],
    terminalSlashCommands: ['doctor'],
    skills: ['simplify'],
    cliVersion: '2.1.312'
  },
  { kind: 'user-message', text: 'Remember the word APPLE' },
  { kind: 'assistant-text', messageId: 'm1', text: 'OK', usage: usage(8036, 40990, 0) },
  result(0.009, 'OK'),
  // Successful manual /compact.
  { kind: 'user-message', text: '/compact' },
  { kind: 'compact-status', phase: 'started' },
  { kind: 'compact-status', phase: 'succeeded' },
  { kind: 'compact-boundary', trigger: 'manual', preTokens: 49079, postTokens: 6408 },
  result(0.0129, ''),
  // /context — local command output (markdown).
  { kind: 'user-message', text: '/context' },
  {
    kind: 'command-output',
    id: 'ctx-1',
    command: 'context',
    text: '## Context Usage\n\n| Category | Tokens |\n|----------|--------|\n| Messages | 8.5k |\n'
  },
  result(0.0129, '## Context Usage'),
  // Failed /compact: the reason arrives on the status AND as command output.
  { kind: 'user-message', text: '/compact' },
  { kind: 'compact-status', phase: 'started' },
  { kind: 'compact-status', phase: 'failed', error: 'Not enough messages to compact.' },
  {
    kind: 'command-output',
    id: 'cmp-2',
    command: 'compact',
    text: 'Not enough messages to compact.'
  },
  result(0.0129, 'Not enough messages to compact.'),
  { kind: 'user-message', text: 'Which word did I ask you to remember?' },
  { kind: 'assistant-text', messageId: 'm2', text: 'APPLE', usage: usage(8036, 2569, 39334) },
  result(0.0147, 'APPLE')
]

// The task's stored prompts, oldest first: one typed in the terminal agent, two in chat.
const PROMPTS = [
  { agent: 'claude-code', text: 'typed in the terminal agent', at: 1000 },
  { agent: 'claude-chat', text: 'Remember the word APPLE', at: 2000 },
  { agent: 'claude-chat', text: 'Which word did I ask you to remember?', at: 3000 }
]

test.describe('Claude chat: compaction, context meter, slash commands, prompt history', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Chat Compaction',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({
      projectId: p.id,
      title: 'Chat compaction task',
      status: 'todo'
    })
    taskId = task.id
    await mainWindow.evaluate(
      (id) =>
        window
          .getTrpcVanillaClient()
          .task.update.mutate({ id, terminalMode: 'claude-chat' } as never),
      taskId
    )
    const tabId = await mainWindow.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
      return tab.id
    }, taskId)

    await electronApp.evaluate(
      async ({}, { tab, task, evs, prompts }) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        for (const [seq, ev] of evs.entries()) {
          await db.run('INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)', [
            tab,
            seq,
            JSON.stringify(ev)
          ])
        }
        for (const [i, p] of prompts.entries()) {
          await db.run(
            `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
             VALUES (?, ?, ?, NULL, ?, ?)`,
            [`seeded-prompt-${i}`, task, p.agent, p.text, p.at]
          )
        }
      },
      { tab: tabId, task: taskId, evs: EVENTS, prompts: PROMPTS }
    )
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Chat compaction task')
    await expect(mainWindow.getByText('APPLE', { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test('compaction shows a divider; a failed one shows its reason once', async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    await expect(
      panel.getByRole('separator').filter({ hasText: 'Conversation compacted' })
    ).toContainText('was 49k tokens')
    await expect(panel.getByRole('alert')).toHaveText(
      'Compaction failed: Not enough messages to compact.'
    )
    await expect(panel.getByText('Not enough messages to compact.', { exact: false })).toHaveCount(
      1
    )
  })

  test('/context output renders as markdown with its table', async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    await expect(panel.getByText('/context', { exact: true }).last()).toBeVisible()
    await expect(panel.locator('table').getByText('Messages', { exact: true })).toBeVisible()
  })

  test('the composer shows context used and session cost', async ({ mainWindow }) => {
    const meter = mainWindow.locator('[data-chat-panel]:visible [data-testid="chat-context-meter"]')
    // Latest main call: 8036 + 2569 + 39334 = 49,939 of 1,000,000 tokens; cost $0.0147.
    await expect(meter).toContainText('5% · 50k/1M')
    await expect(meter).toContainText('$0.01')
    await expect(meter).toHaveAttribute('title', /49,939 of 1,000,000 tokens/)
  })

  test('the / menu lists the CLI commands usable in chat', async ({ mainWindow }) => {
    const textarea = mainWindow.locator('[data-chat-panel]:visible textarea')
    await textarea.click()
    await textarea.fill('/')
    const menu = mainWindow.locator('[data-chat-panel]:visible [role="listbox"][data-source]')
    await expect(
      menu.locator('[data-source="cli-commands"]', { hasText: '/compact' })
    ).toBeVisible()
    await expect(
      menu.locator('[data-source="cli-commands"]', { hasText: '/context' })
    ).toBeVisible()
    // Terminal-only CLI commands stay out of the chat menu.
    await expect(menu.getByText('/doctor', { exact: true })).toHaveCount(0)
    await textarea.press('Escape')
    await textarea.fill('')
  })

  test('↑/↓ walk the task prompt history (chat + terminal) and restore the draft', async ({
    mainWindow
  }) => {
    const textarea = mainWindow.locator('[data-chat-panel]:visible textarea')
    await textarea.click()
    // The history loads asynchronously: retry from an empty composer until the
    // newest prompt comes back (an empty draft always restarts at the newest).
    await expect
      .poll(
        async () => {
          await textarea.fill('')
          await textarea.press('ArrowUp')
          return textarea.inputValue()
        },
        { timeout: 10_000 }
      )
      .toBe('Which word did I ask you to remember?')
    await textarea.press('ArrowUp')
    await expect(textarea).toHaveValue('Remember the word APPLE')
    await textarea.press('ArrowUp')
    await expect(textarea).toHaveValue('typed in the terminal agent')
    await textarea.press('ArrowDown')
    await textarea.press('ArrowDown')
    await textarea.press('ArrowDown')
    await expect(textarea).toHaveValue('')
  })

  test('Ctrl+R searches the prompt history into the composer', async ({ mainWindow }) => {
    // Windows/Linux: mod+r is the app's reload-browser shortcut and never reaches the page.
    test.skip(process.platform !== 'darwin', 'Ctrl+R reaches the chat only on macOS')
    const textarea = mainWindow.locator('[data-chat-panel]:visible textarea')
    await textarea.click()
    await textarea.fill('')
    await textarea.press('Control+r')
    const search = mainWindow.locator('[data-testid="chat-prompt-history-search"]')
    await expect(search).toBeVisible()
    await search.getByRole('searchbox').fill('terminal')
    await expect(search.getByRole('option')).toHaveText(['typed in the terminal agent'])
    await search.getByRole('searchbox').press('Enter')
    await expect(search).toHaveCount(0)
    await expect(textarea).toHaveValue('typed in the terminal agent')
  })
})
