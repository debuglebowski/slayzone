/**
 * Terminal cursor stability — verifies no unexpected cursor jumping or blank
 * lines when creating a new temporary task. A controlled ANSI agent avoids
 * depending on an installed CLI's login, onboarding, or changing banner layout.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  test,
  expect,
  seed,
  resetApp,
  clickProject,
  createIsolatedGitRepo
} from '../fixtures/electron'
import {
  getMainSessionId,
  waitForPtySession,
  getTerminalState,
  readFullBuffer
} from '../fixtures/terminal'

/** The renderer exposes the tab store on `window` for e2e only — just the slice
 *  this spec reads (see fixtures/context-manager.ts for the same pattern). */
type TabStoreWindow = {
  __slayzone_tabStore?: {
    getState: () => {
      tabs: Array<{ type: string; taskId?: string }>
      activeTabIndex: number
    }
  }
}

test.describe('Temporary task cursor stability', () => {
  let projectAbbrev: string
  let sessionId: string | undefined

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const repo = createIsolatedGitRepo('cursor-stability')
    writeFileSync(
      path.join(repo, 'cursor-fixture.cjs'),
      `process.stdout.write('\\x1b[2J\\x1b[HClaude Code fixture\\r\\n' + process.cwd() + '\\r\\n\\r\\n❯ ')
process.stdin.resume()
`
    )
    await mainWindow.evaluate(async () => {
      const c = window.getTrpcVanillaClient()
      await c.pty.agentsCreate.mutate({
        id: 'cursor-fixture',
        label: 'Cursor Fixture',
        type: 'claude-code',
        initialCommand: 'node cursor-fixture.cjs',
        resumeCommand: null,
        defaultFlags: '',
        enabled: true,
        order: 999
      })
      await c.settings.set.mutate({ key: 'default_agent_id', value: 'cursor-fixture' })
      await c.settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    })
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Cursor Stab',
      color: '#f97316',
      path: repo
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    // Agent definitions and startup settings are cached by the shared renderer.
    // Start its hooks after installing this fixture, before creating the scratch.
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root')
  })

  test.afterEach(async ({ mainWindow }, info) => {
    if (info.status === info.expectedStatus || !sessionId) return
    console.error(
      '[cursor-fixture]',
      JSON.stringify({
        terminal: await getTerminalState(mainWindow, sessionId),
        buffer: (await readFullBuffer(mainWindow, sessionId)).slice(-4_000)
      })
    )
  })

  test.afterAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('no extra blank lines between agent header and prompt', async ({ mainWindow }) => {
    // Select the project first (required for temp task creation)
    await clickProject(mainWindow, projectAbbrev)

    await mainWindow.getByLabel('New temporary task', { exact: true }).click()

    await expect
      .poll(
        async () => {
          return mainWindow.evaluate(() => {
            const store = (window as unknown as TabStoreWindow).__slayzone_tabStore
            if (!store) return null
            const { tabs, activeTabIndex } = store.getState()
            const activeTab = tabs[activeTabIndex]
            return activeTab?.type === 'task' ? activeTab.taskId : null
          })
        },
        { timeout: 10_000 }
      )
      .not.toBeNull()

    const taskId = await mainWindow.evaluate(() => {
      const store = (window as unknown as TabStoreWindow).__slayzone_tabStore
      if (!store) throw new Error('__slayzone_tabStore not exposed')
      const { tabs, activeTabIndex } = store.getState()
      return tabs[activeTabIndex].taskId as string
    })

    sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 10_000)

    // Wait for Claude Code prompt (❯ character)
    await expect
      .poll(
        async () => {
          const state = await getTerminalState(mainWindow, sessionId!)
          if (!state) return false
          return state.lines.some((l) => l.includes('❯'))
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    const state = await getTerminalState(mainWindow, sessionId)
    expect(state).toBeTruthy()
    expect(state!.lines.some((line) => line.includes('Claude Code fixture'))).toBe(true)

    // Find the prompt line and the last header line (directory path)
    const promptIdx = state!.lines.findIndex((l) => l.includes('❯'))
    const headerLines = state!.lines.slice(0, promptIdx)

    // Find last non-empty header line (the working directory line)
    const lastHeaderIdx = headerLines.reduce((last, l, i) => (l.trim() ? i : last), -1)

    // Between the last header line and prompt, there should be at most 1 blank line
    // (Claude Code renders: header, blank line, prompt). More indicates cursor jumped.
    const gap = promptIdx - lastHeaderIdx - 1
    expect(gap).toBeLessThanOrEqual(1)
  })
})
