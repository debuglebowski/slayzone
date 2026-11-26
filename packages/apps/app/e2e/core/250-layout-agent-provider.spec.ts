import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { layoutOf, openTaskWithLayout, panel, storedLayout, tab } from '../fixtures/task-layout'

// The agent provider per panel (docs/plans/panel-model.md step 12): one Agent panel
// type, its provider chosen on the panel — a caret ▾ on the active agent tab of a
// tab strip, or in the panel's own header when its group shows no strip. The main
// agent's provider is the task's agent (task.agent_id); another agent panel's is
// the mode of its own terminal (terminal_tabs.mode).

const SECOND = 'agent:bbbb2222'

/** The main agent and a second agent panel as tabs of one group. */
const TWO_AGENT_TABS = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal', SECOND] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

interface TabRow {
  id: string
  groupId: string
  mode: string
  position: number
}

async function agentOf(page: Page, taskId: string): Promise<string | undefined> {
  const t = (await page.evaluate(
    (id) => window.getTrpcVanillaClient().task.get.query({ id }),
    taskId
  )) as { agent_id?: string } | null
  return t?.agent_id
}

async function terminalRows(page: Page, taskId: string): Promise<TabRow[]> {
  return (await page.evaluate(
    (id) => window.getTrpcVanillaClient().taskTerminals.list.query({ taskId: id }),
    taskId
  )) as TabRow[]
}

async function groupsOf(page: Page, taskId: string, instanceId: string): Promise<string[]> {
  const l = await storedLayout(page, taskId)
  const settings = l?.instances[instanceId]?.settings as Record<string, unknown> | undefined
  return (settings?.terminalGroupIds as string[] | undefined) ?? []
}

async function pickProvider(page: Page, trigger: Locator, mode: string): Promise<void> {
  // A title-row tooltip left open by the last hover (⋯) may cover the trigger.
  await page.mouse.move(2, 2)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await trigger.click()
  await page
    .getByTestId('agent-provider-menu-content')
    .getByTestId(`agent-provider-option-${mode}`)
    .click()
  await expect(page.getByTestId('agent-provider-menu-content')).toBeHidden()
}

test.describe('Agent provider per panel', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Agent providers',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('the caret on the active agent tab: the main agent switches the task’s agent, another panel its own', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(
      page,
      projectId,
      `Provider ${++n}`,
      TWO_AGENT_TABS,
      ['terminal'],
      { agentId: 'terminal' }
    )
    const mainCaret = tab(page, 'terminal').getByTestId('agent-provider-menu')
    await expect(mainCaret).toHaveAttribute('data-provider', 'terminal')
    // Only the active tab carries it.
    await expect(tab(page, SECOND).getByTestId('agent-provider-menu')).toHaveCount(0)

    await pickProvider(page, mainCaret, 'codex')
    await expect.poll(() => agentOf(page, taskId)).toBe('codex')
    await expect(mainCaret).toHaveAttribute('data-provider', 'codex')
    await pickProvider(page, mainCaret, 'terminal')
    await expect.poll(() => agentOf(page, taskId)).toBe('terminal')

    // The second agent panel has no terminal yet: choosing its provider starts one.
    await tab(page, SECOND).click()
    const secondCaret = tab(page, SECOND).getByTestId('agent-provider-menu')
    await expect(secondCaret).toBeVisible()
    await pickProvider(page, secondCaret, 'terminal')
    await expect.poll(() => groupsOf(page, taskId, SECOND)).toHaveLength(1)
    const [groupId] = await groupsOf(page, taskId, SECOND)
    await expect
      .poll(async () => (await terminalRows(page, taskId)).find((r) => r.groupId === groupId)?.mode)
      .toBe('terminal')
    await expect(secondCaret).toHaveAttribute('data-provider', 'terminal')
    // The task's own agent is untouched.
    expect(await agentOf(page, taskId)).toBe('terminal')
  })

  test('a panel without a strip shows its provider in its header; changing it restarts its terminal in the new mode', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(
      page,
      projectId,
      `Provider ${++n}`,
      CLASSIC,
      ['terminal', 'settings'],
      { agentId: 'terminal' }
    )
    await page.locator('[data-testid="new-panel-menu"]:visible').click()
    await page.getByTestId('new-panel-agent').click()

    let agentId = ''
    await expect
      .poll(async () => {
        const l = await storedLayout(page, taskId)
        agentId = Object.keys(l?.instances ?? {}).find((id) => id.startsWith('agent:')) ?? ''
        return agentId ? (await groupsOf(page, taskId, agentId)).length : 0
      })
      .toBe(1)
    const [groupId] = await groupsOf(page, taskId, agentId)
    const header = panel(page, agentId).getByTestId('agent-provider-menu')
    await expect(header).toBeVisible()
    await expect(header).toHaveAttribute('data-provider', 'terminal')
    await expect(panel(page, agentId).locator('.xterm')).toBeVisible({ timeout: 15_000 })
    // Focus leaves ⋯ (its tooltip stays open while it holds focus, over the header).
    await panel(page, agentId).locator('.xterm').click()
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    const before = (await terminalRows(page, taskId)).find((r) => r.groupId === groupId)
    if (!before) throw new Error('no terminal for the panel')
    await pickProvider(page, header, 'codex')
    // Same terminal (tab row), now in the new mode — not closed by its session ending.
    await expect
      .poll(async () => (await terminalRows(page, taskId)).find((r) => r.id === before.id)?.mode)
      .toBe('codex')
    await expect(header).toHaveAttribute('data-provider', 'codex')
    expect(await agentOf(page, taskId)).toBe('terminal')
  })
})
