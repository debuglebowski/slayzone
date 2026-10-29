/**
 * Chat colours come from the theme system, not from fixed Tailwind palette
 * classes: status icons, banners, the question / plan cards, avatars, diff lines
 * and the background-jobs banner all resolve through semantic tokens (success,
 * warning, info, agent, diff-*), so they follow the selected theme and the
 * terminal-panel override theme (TerminalContainer sets chrome vars on the chat
 * subtree).
 *
 * No agent subprocess: the history is seeded straight into `chat_events`, which
 * chat.hydrate loads without spawning (startup = manual). The render test also
 * attaches screenshots of every coloured row kind in light + dark.
 */
import type { Locator, Page, TestInfo } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskViaSearch } from '../fixtures/browser-view'

const TASK = 'Chat theme tokens task'
const EMPTY_TASK = 'Chat theme empty task'
const OVERRIDE_THEME = 'dracula'

const result = (overrides: Record<string, unknown>) => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1500,
  durationApiMs: 1200,
  numTurns: 1,
  totalCostUsd: 0.0123,
  stopReason: null,
  terminalReason: null,
  text: null,
  modelUsage: {},
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  },
  permissionDenials: [],
  ...overrides
})

/** One of every timeline row that carries a status / tone colour. */
const EVENTS: Record<string, unknown>[] = [
  { kind: 'user-message', text: 'theme-fixture-first-message' },
  {
    kind: 'assistant-thinking',
    messageId: 'm0',
    text: 'Thinking fixture',
    hasSignature: false
  },
  { kind: 'assistant-text', messageId: 'm1', text: 'Assistant reply fixture' },
  {
    kind: 'tool-call',
    id: 'read1',
    name: 'Read',
    input: { file_path: '/repo/src/a.ts' }
  },
  {
    kind: 'tool-result',
    toolUseId: 'read1',
    isError: false,
    rawContent: 'const a = 1',
    structured: null
  },
  {
    kind: 'tool-call',
    id: 'edit1',
    name: 'Edit',
    input: {
      file_path: '/repo/src/b.ts',
      old_string: 'seeded-old-string',
      new_string: 'seeded-new-string'
    }
  },
  {
    kind: 'tool-call',
    id: 'edit2',
    name: 'Edit',
    input: { file_path: '/repo/src/c.ts', old_string: 'x', new_string: 'y' }
  },
  {
    kind: 'tool-result',
    toolUseId: 'edit2',
    isError: false,
    rawContent: 'ok',
    structured: {
      filePath: '/repo/src/c.ts',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [' const keep = 0', '-const removed = 1', '+const added = 2']
        }
      ]
    }
  },
  {
    kind: 'tool-call',
    id: 'bash1',
    name: 'Bash',
    input: {
      command: 'sleep 600',
      run_in_background: true,
      description: 'Background fixture'
    }
  },
  {
    kind: 'tool-call',
    id: 'todo1',
    name: 'TodoWrite',
    input: {
      todos: [
        {
          content: 'Done todo',
          status: 'completed',
          activeForm: 'Doing done todo'
        },
        {
          content: 'Active todo',
          status: 'in_progress',
          activeForm: 'Doing active todo'
        },
        {
          content: 'Later todo',
          status: 'pending',
          activeForm: 'Doing later todo'
        }
      ]
    }
  },
  {
    kind: 'tool-result',
    toolUseId: 'todo1',
    isError: false,
    rawContent: 'ok',
    structured: null
  },
  {
    kind: 'tool-call',
    id: 'agent2',
    name: 'Agent',
    input: { description: 'Finished sub-agent fixture', prompt: 'p' }
  },
  {
    kind: 'sub-agent',
    phase: 'in-flight',
    toolUseId: 'agent2',
    description: 'Finished sub-agent fixture',
    raw: null
  },
  {
    kind: 'tool-result',
    toolUseId: 'agent2',
    isError: false,
    rawContent: 'ok',
    structured: null
  },
  {
    kind: 'tool-call',
    id: 'plan1',
    name: 'ExitPlanMode',
    input: { plan: '## Plan fixture\n\n- step one\n- step two' }
  },
  {
    kind: 'api-retry',
    attempt: 1,
    maxRetries: 5,
    delayMs: 1000,
    error: 'overloaded'
  },
  {
    kind: 'rate-limit',
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: null,
    overageStatus: null
  },
  { kind: 'stderr', text: 'stderr fixture line' },
  {
    kind: 'agent-plan',
    explanation: 'Plan explanation fixture',
    steps: [
      { step: 'Completed step', status: 'completed' },
      { step: 'Active step', status: 'inProgress' },
      { step: 'Pending step', status: 'pending' }
    ]
  },
  result({ permissionDenials: [{ tool_use_id: 'plan1' }] }),
  { kind: 'user-message', text: 'theme-fixture-interrupted-turn' },
  { kind: 'interrupted' },
  { kind: 'user-message', text: 'theme-fixture-failed-turn' },
  result({
    subtype: 'error_during_execution',
    isError: true,
    totalCostUsd: 0.0456
  }),
  { kind: 'user-message', text: 'theme-fixture-question-turn' },
  {
    kind: 'tool-call',
    id: 'agent1',
    name: 'Agent',
    input: { description: 'In-flight sub-agent fixture', prompt: 'p' }
  },
  {
    kind: 'sub-agent',
    phase: 'in-flight',
    toolUseId: 'agent1',
    description: 'In-flight sub-agent fixture',
    raw: null
  },
  {
    kind: 'tool-call',
    id: 'ask1',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Pick a colour fixture?',
          header: 'Colour',
          multiSelect: false,
          options: [
            { label: 'Option A', description: 'First option' },
            { label: 'Option B', description: 'Second option' }
          ]
        }
      ]
    }
  }
]

async function createChatTask(mainWindow: Page, projectId: string, title: string): Promise<string> {
  const task = await seed(mainWindow).createTask({
    projectId,
    title,
    status: 'todo'
  })
  await mainWindow.evaluate(
    (id) =>
      window
        .getTrpcVanillaClient()
        .task.update.mutate({ id, terminalMode: 'claude-chat' } as never),
    task.id
  )
  return mainWindow.evaluate(async (id) => {
    const tab = await window
      .getTrpcVanillaClient()
      .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
    return tab.id
  }, task.id)
}

/** The scroll container of the chat that shows `text`. */
function chatScroller(mainWindow: Page, text: string): Locator {
  return mainWindow
    .getByText(text, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")][1]')
}

/** Screenshot the chat viewport (incl. overlays like the jobs banner) in scroll slices. */
async function captureChat(
  mainWindow: Page,
  scroller: Locator,
  testInfo: TestInfo,
  name: string,
  { fromTop = true, maxSlices = 12 } = {}
): Promise<void> {
  if (fromTop) await scroller.evaluate((el) => (el.scrollTop = 0))
  for (let i = 0; i < maxSlices; i++) {
    await mainWindow.waitForTimeout(150)
    const box = await scroller.boundingBox()
    if (!box) throw new Error('chat scroller has no box')
    const path = testInfo.outputPath(`${name}-${i}.png`)
    await mainWindow.screenshot({
      path,
      clip: box,
      animations: 'disabled',
      caret: 'hide'
    })
    await testInfo.attach(`${name}-${i}`, { path, contentType: 'image/png' })
    const done = await scroller.evaluate((el) => {
      const before = el.scrollTop
      el.scrollTop = before + el.clientHeight - 48
      return el.scrollTop === before
    })
    if (done) break
  }
}

/** Computed `prop` of the element vs. `var(cssVar)` resolved at the same spot. */
async function resolved(
  target: Locator,
  prop: 'color' | 'background-color' | 'background-image',
  cssVar: string
): Promise<{ actual: string; expected: string; atRoot: string }> {
  return target.evaluate(
    (el, [p, v]) => {
      const probeAt = (parent: Element): string => {
        const probe = document.createElement('span')
        probe.style.setProperty('color', `var(${v})`)
        parent.appendChild(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      }
      return {
        actual: getComputedStyle(el).getPropertyValue(p),
        expected: probeAt(el.parentElement ?? el),
        atRoot: probeAt(document.body)
      }
    },
    [prop, cssVar] as const
  )
}

test.describe('Chat theme tokens', () => {
  let projectId = ''
  let startedDark = false

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    startedDark = await mainWindow.evaluate(() =>
      document.documentElement.classList.contains('dark')
    )
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().settings.set.mutate({
        key: 'terminal_agent_startup',
        value: 'manual'
      })
    )
    const p = await seed(mainWindow).createProject({
      name: 'Chat Theme',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    const tabId = await createChatTask(mainWindow, projectId, TASK)
    await createChatTask(mainWindow, projectId, EMPTY_TASK)
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
    await seed(mainWindow).refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_override_theme_id', value: '' })
    )
    await seed(mainWindow).setTheme(startedDark ? 'dark' : 'light')
  })

  test('renders every coloured row kind in light and dark', async ({ mainWindow }, testInfo) => {
    await openTaskViaSearch(mainWindow, EMPTY_TASK)
    await expect(mainWindow.getByText('Chat with Claude Code')).toBeVisible({
      timeout: 10_000
    })
    await openTaskViaSearch(mainWindow, TASK)
    const scroller = chatScroller(mainWindow, 'theme-fixture-first-message')
    await expect(scroller).toBeVisible({ timeout: 10_000 })
    for (const text of [
      'Assistant reply fixture',
      '+ seeded-new-string',
      'In-flight sub-agent fixture',
      'Pick a colour fixture?',
      'Approve plan?',
      'Turn interrupted',
      'stderr fixture line',
      'Plan explanation fixture',
      'BACKGROUND JOBS'
    ]) {
      await expect(mainWindow.getByText(text).first(), text).toBeVisible()
    }
    await expect(mainWindow.getByText(/API retry 1\/5/)).toBeVisible()
    await expect(mainWindow.getByText('rate limit: rejected')).toBeVisible()

    // Selected option: filled radio + tinted row.
    await scroller.getByText('Option A', { exact: true }).click()

    for (const theme of ['light', 'dark'] as const) {
      await seed(mainWindow).setTheme(theme)
      const dark = mainWindow.locator('html.dark')
      await (theme === 'dark' ? expect(dark).toBeAttached() : expect(dark).not.toBeAttached())
      await captureChat(mainWindow, scroller, testInfo, `chat-${theme}`)

      // Find-in-chat: <mark> hits + the active case-sensitive toggle.
      await scroller.click({ button: 'right', position: { x: 20, y: 20 } })
      await mainWindow.getByRole('menuitem', { name: /Find in chat/ }).click()
      await mainWindow.getByPlaceholder('Find in chat…').fill('fixture')
      await mainWindow.getByTitle('Case sensitive').click()
      await expect(scroller.locator('mark').first()).toBeVisible()
      await captureChat(mainWindow, scroller, testInfo, `search-${theme}`, {
        fromTop: false,
        maxSlices: 1
      })
      await mainWindow.getByTitle('Case sensitive').click()
      await mainWindow.getByTitle('Close (Escape)').click()

      await openTaskViaSearch(mainWindow, EMPTY_TASK)
      const empty = mainWindow
        .getByText('Chat with Claude Code', { exact: true })
        .locator('xpath=ancestor::div[contains(@class, "inset-0")][1]')
      await expect(empty).toBeVisible()
      await captureChat(mainWindow, empty, testInfo, `empty-${theme}`, {
        maxSlices: 1
      })
      await openTaskViaSearch(mainWindow, TASK)
      await expect(scroller).toBeVisible()
    }
  })

  test('colours follow the terminal override theme', async ({ mainWindow }, testInfo) => {
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().settings.set.mutate({
          key: 'terminal_override_theme_id',
          value: id
        }),
      OVERRIDE_THEME
    )
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await openTaskViaSearch(mainWindow, TASK)
    const scroller = chatScroller(mainWindow, 'theme-fixture-first-message')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    const checks: Array<[string, Locator, 'color' | 'background-color', string]> = [
      [
        'done icon',
        scroller.locator('button', { hasText: '$0.0123' }).locator('svg').first(),
        'color',
        '--success'
      ],
      ['retry banner text', scroller.getByText(/API retry 1\/5/), 'color', '--warning-foreground'],
      [
        'question header',
        scroller.locator('button', { hasText: 'Question' }).first(),
        'color',
        '--info-foreground'
      ],
      [
        'diff added line',
        scroller.getByText('+ seeded-new-string'),
        'color',
        '--diff-added-foreground'
      ],
      [
        'pending job dot',
        mainWindow.locator('li', { hasText: 'Starting' }).locator('span.rounded-full').first(),
        'background-color',
        '--info'
      ]
    ]
    for (const [label, target, prop, cssVar] of checks) {
      const r = await resolved(target, prop, cssVar)
      expect(r.actual, `${label} uses ${cssVar}`).toBe(r.expected)
      expect(r.expected, `${label}: override theme differs from app theme`).not.toBe(r.atRoot)
    }

    const avatar = scroller.locator('.bg-gradient-to-br').first()
    const gradient = await resolved(avatar, 'background-image', '--agent')
    expect(gradient.actual, 'agent avatar gradient uses --agent').toContain(gradient.expected)

    await captureChat(mainWindow, scroller, testInfo, `chat-${OVERRIDE_THEME}`)
  })
})
