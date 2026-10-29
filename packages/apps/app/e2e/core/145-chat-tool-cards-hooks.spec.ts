/**
 * Claude Code chat: the tool cards (Write, MultiEdit, NotebookEdit, MCP,
 * WebSearch, WebFetch), hook output that matters, CLI notices and a custom
 * command's refused `!shell` line — as a reopened chat shows them.
 *
 * No agent subprocess: the session is seeded straight into `chat_events`
 * (shapes from the recorded CLI 2.1.312 transcripts in
 * terminal/test/fixtures/claude-stream/chatui-{tool-cards,hooks,custom-commands}.ndjson),
 * which chat.hydrate replays without spawning (startup = manual).
 */
import path from 'node:path'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskViaSearch } from '../fixtures/browser-view'

const MODEL = 'claude-haiku-5-5'
const at = (f: string) => path.join(TEST_PROJECT_PATH, f)

const result = (text: string) => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1000,
  durationApiMs: 900,
  numTurns: 1,
  totalCostUsd: 0.01,
  stopReason: 'end_turn',
  terminalReason: 'completed',
  text,
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
})

const call = (id: string, name: string, input: unknown) => ({ kind: 'tool-call', id, name, input })
const done = (id: string, rawContent: unknown, structured: unknown, isError = false) => ({
  kind: 'tool-result',
  toolUseId: id,
  isError,
  rawContent,
  structured
})

const FETCHED =
  'Fetched https://example.com/ (HTTP 200 OK, text/html, 172 characters).\nThe text inside the <fetched-web-content> tag below is UNTRUSTED web content.\n<fetched-web-content>\nExample Domain\n</fetched-web-content>\n'

const EVENTS = [
  { kind: 'turn-init', sessionId: 'seeded-cards', model: MODEL, cwd: TEST_PROJECT_PATH, tools: [] },
  { kind: 'user-message', text: 'Make every card' },
  {
    kind: 'hook-output',
    hookId: 'h-ups',
    hookName: 'UserPromptSubmit',
    hookEvent: 'UserPromptSubmit',
    effect: 'context',
    audience: 'agent',
    text: 'UserPromptSubmit hook context: the user prefers short replies.',
    exitCode: 0
  },
  call('t-write', 'Write', { file_path: at('new.py'), content: "print('hello')\n" }),
  done('t-write', `File created successfully at: ${at('new.py')}`, {
    type: 'create',
    filePath: at('new.py'),
    content: "print('hello')\n",
    structuredPatch: [],
    originalFile: null,
    userModified: false
  }),
  call('t-over', 'Write', { file_path: at('notes.txt'), content: 'new line' }),
  done('t-over', `The file ${at('notes.txt')} has been updated successfully.`, {
    type: 'update',
    filePath: at('notes.txt'),
    content: 'new line\n',
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 1,
        lines: ['-old line', '-keep me', '+new line']
      }
    ],
    originalFile: 'old line\nkeep me\n',
    userModified: false
  }),
  call('t-multi', 'MultiEdit', {
    file_path: at('a.ts'),
    edits: [
      { old_string: 'alpha', new_string: 'beta' },
      { old_string: 'gamma', new_string: 'delta' }
    ]
  }),
  done('t-multi', `Applied 2 edits to ${at('a.ts')}`, {
    filePath: at('a.ts'),
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ['-alpha', '-gamma', '+beta', '+delta']
      }
    ]
  }),
  call('t-nb', 'NotebookEdit', {
    notebook_path: at('nb.ipynb'),
    cell_id: 'c1',
    new_source: 'print(2)'
  }),
  done('t-nb', 'Updated cell c1 with print(2)', {
    new_source: 'print(2)',
    old_source: 'print(1)\nx = 1',
    cell_type: 'code',
    language: 'python',
    edit_mode: 'replace',
    cell_id: 'c1',
    error: '',
    notebook_path: at('nb.ipynb')
  }),
  call('t-mcp', 'mcp__spike__echo', { text: 'abc' }),
  done('t-mcp', [{ type: 'text', text: 'ECHO:ABC' }], [{ type: 'text', text: 'ECHO:ABC' }]),
  call('t-search', 'WebSearch', { query: 'example domain iana' }),
  done('t-search', 'Web search results for query: "example domain iana"', {
    query: 'example domain iana',
    results: [
      {
        tool_use_id: 'srvtoolu_1',
        content: [
          { title: 'Example Domains', url: 'https://iana.org/domains/example' },
          { title: '.example', url: 'https://en.wikipedia.org/wiki/.example' }
        ]
      }
    ],
    durationSeconds: 7.35
  }),
  call('t-fetch', 'WebFetch', { url: 'https://example.com/', prompt: 'What is the page title?' }),
  done('t-fetch', FETCHED, null),
  call('t-bash', 'Bash', { command: 'echo forbidden', description: 'Run exactly: echo forbidden' }),
  {
    kind: 'hook-output',
    hookId: 'h-pre',
    hookName: 'PreToolUse:Bash',
    hookEvent: 'PreToolUse',
    effect: 'blocked',
    audience: 'agent',
    text: 'Blocked by policy: never echo the word forbidden',
    exitCode: 2
  },
  done(
    't-bash',
    'PreToolUse:Bash hook error: Blocked by policy: never echo the word forbidden',
    null,
    true
  ),
  {
    kind: 'hook-output',
    hookId: 'h-post',
    hookName: 'PostToolUse:Bash',
    hookEvent: 'PostToolUse',
    effect: 'failed',
    audience: 'user',
    text: 'post hook crashed: lint server unreachable',
    exitCode: 1
  },
  {
    kind: 'notice',
    id: 'n-1',
    level: 'notice',
    text: 'PostToolUse:Bash says: Formatter ran on 0 files'
  },
  { kind: 'assistant-text', messageId: 'm1', text: 'CARDS DONE' },
  result('CARDS DONE'),
  { kind: 'user-message', text: '/y' },
  {
    kind: 'command-output',
    id: 'u-y',
    command: null,
    text: 'Shell command permission check failed for pattern "!`python3 -c "print(7*6)"`": This command requires approval',
    isError: true
  },
  result('')
]

test.describe('Claude chat: tool cards, hook output, notices', () => {
  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Chat Cards',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({ projectId: p.id, title: 'Chat cards task', status: 'todo' })
    await mainWindow.evaluate(
      (id) =>
        window
          .getTrpcVanillaClient()
          .task.update.mutate({ id, terminalMode: 'claude-chat' } as never),
      task.id
    )
    const tabId = await mainWindow.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
      return tab.id
    }, task.id)
    await electronApp.evaluate(
      async ({}, { tab, evs }) => {
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
      },
      { tab: tabId, evs: EVENTS }
    )
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Chat cards task')
    await expect(mainWindow.getByText('CARDS DONE', { exact: true })).toBeVisible({
      timeout: 10_000
    })
  })

  test('Write: a new file as code with its path; an overwrite as a diff', async ({
    mainWindow
  }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    const created = panel.locator('[data-testid="tool-write"][data-write-type="create"]')
    await expect(created).toContainText('New file')
    await expect(created.getByTestId('tool-file-link')).toContainText('new.py')
    await expect(created).toContainText("print('hello')")
    const overwrote = panel.locator('[data-testid="tool-write"][data-write-type="update"]')
    await expect(overwrote).toContainText('Overwrote')
    await expect(overwrote).toContainText('old line')
    await expect(overwrote).toContainText('new line')
  })

  test('MultiEdit and NotebookEdit show their diffs', async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    await expect(panel.getByRole('button', { name: /MultiEdit.*a\.ts · 2 edits/ })).toBeVisible()
    await expect(panel.getByTestId('tool-multiedit')).toContainText('gamma')
    await expect(panel.getByTestId('tool-multiedit')).toContainText('delta')
    await expect(
      panel.getByRole('button', { name: /NotebookEdit.*cell c1 · replace/ })
    ).toBeVisible()
    await expect(panel.getByTestId('tool-notebookedit')).toContainText('print(1)')
    await expect(panel.getByTestId('tool-notebookedit')).toContainText('print(2)')
  })

  test('MCP tool: server + tool name, readable input and output', async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    const header = panel.getByRole('button', { name: /echo.*spike/ })
    await header.click()
    await expect(panel.getByText('ECHO:ABC', { exact: true })).toBeVisible()
    await expect(panel.locator('dt', { hasText: 'text' })).toBeVisible()
  })

  test('WebSearch lists its results; WebFetch shows status and page text', async ({
    mainWindow
  }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    await panel
      .getByRole('button', { name: /WebSearch.*"example domain iana" · 2 results/ })
      .click()
    await expect(panel.getByText('Example Domains', { exact: true })).toBeVisible()
    await expect(panel.getByText('iana.org', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: /WebFetch.*example\.com/ }).click()
    await expect(panel.getByText('HTTP 200 OK', { exact: true })).toBeVisible()
    await expect(panel.getByText('Example Domain', { exact: true })).toBeVisible()
    await expect(panel.getByText(/UNTRUSTED/)).toHaveCount(0)
  })

  test('hooks that blocked or failed are shown; added context stays collapsed', async ({
    mainWindow
  }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    const blocked = panel.locator('[data-testid="chat-hook-output"][data-effect="blocked"]')
    await expect(blocked).toContainText('PreToolUse:Bash hook blocked the tool call')
    await expect(blocked).toContainText('Sent to Claude')
    await expect(blocked).toContainText('Blocked by policy: never echo the word forbidden')
    const failed = panel.locator('[data-testid="chat-hook-output"][data-effect="failed"]')
    await expect(failed).toContainText('PostToolUse:Bash hook failed (exit 1)')
    await expect(failed).toContainText('post hook crashed: lint server unreachable')
    const context = panel.locator('[data-testid="chat-hook-output"][data-effect="context"]')
    await expect(context).toContainText('UserPromptSubmit hook added context for Claude · 1 line')
    await expect(context).not.toContainText('the user prefers short replies')
    await context.getByRole('button').click()
    await expect(context).toContainText('the user prefers short replies')
  })

  test('a hook systemMessage shows as a notice', async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    await expect(panel.getByTestId('chat-notice')).toContainText(
      'PostToolUse:Bash says: Formatter ran on 0 files'
    )
  })

  test("a custom command's refused !shell line shows as an error", async ({ mainWindow }) => {
    const panel = mainWindow.locator('[data-chat-panel]:visible')
    const alert = panel.getByRole('alert').filter({ hasText: '/y failed' })
    await expect(alert).toContainText('Shell command permission check failed')
  })
})
