import { test, expect, seed, TEST_PROJECT_PATH, resetApp } from '../fixtures/electron'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

type AutomationRow = {
  id: string
  catchup_on_start: boolean
}

test.describe('Automations: catchup_on_start (tRPC end-to-end)', () => {
  let dbPath = ''
  let projectId = ''

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)

    const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_STORE_DIR!)
    dbPath = path.join(dbDir, 'slayzone.dev.sqlite')

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'CatchupProj',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    await s.refreshData()
  })

  function readRow(id: string): { id: string; catchup_on_start: number } | undefined {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT id, catchup_on_start FROM automations WHERE id = ?').get(id) as
      | { id: string; catchup_on_start: number }
      | undefined
    db.close()
    return row
  }

  const buildCronInput = (name: string, catchup_on_start?: boolean) => ({
    project_id: projectId,
    name,
    trigger_config: { type: 'cron', params: { expression: '*/5 * * * *' } },
    actions: [{ type: 'run_command', params: { command: 'echo test' } }],
    ...(catchup_on_start !== undefined ? { catchup_on_start } : {})
  })

  const createAutomation = (page: import('@playwright/test').Page, input: ReturnType<typeof buildCronInput>) =>
    page.evaluate((payload) => window.getTrpcVanillaClient().automations.create.mutate(payload), input) as Promise<AutomationRow>

  const updateAutomation = (
    page: import('@playwright/test').Page,
    input: { id: string; catchup_on_start: boolean }
  ) =>
    page.evaluate(
      (payload) => window.getTrpcVanillaClient().automations.update.mutate(payload),
      input
    ) as Promise<AutomationRow | null>

  const getAutomation = (page: import('@playwright/test').Page, id: string) =>
    page.evaluate(
      (automationId) => window.getTrpcVanillaClient().automations.get.query({ id: automationId }),
      id
    ) as Promise<AutomationRow | null>

  test('migration v124 applied: catchup_on_start defaults true', async ({ mainWindow }) => {
    const created = await createAutomation(mainWindow, buildCronInput('default-catchup'))
    expect(created.catchup_on_start).toBe(true)
    expect(readRow(created.id)?.catchup_on_start).toBe(1)
  })

  test('create with catchup_on_start: false is honored', async ({ mainWindow }) => {
    const created = await createAutomation(mainWindow, buildCronInput('opt-out', false))
    expect(created.catchup_on_start).toBe(false)
    expect(readRow(created.id)?.catchup_on_start).toBe(0)
  })

  test('update flips catchup_on_start', async ({ mainWindow }) => {
    const created = await createAutomation(mainWindow, buildCronInput('flip-target'))
    expect(created.catchup_on_start).toBe(true)

    await updateAutomation(mainWindow, { id: created.id, catchup_on_start: false })
    expect(readRow(created.id)?.catchup_on_start).toBe(0)

    await updateAutomation(mainWindow, { id: created.id, catchup_on_start: true })
    expect(readRow(created.id)?.catchup_on_start).toBe(1)
  })

  test('get returns parsed boolean', async ({ mainWindow }) => {
    const created = await createAutomation(mainWindow, buildCronInput('get-test', false))
    const fetched = await getAutomation(mainWindow, created.id)
    expect(fetched?.catchup_on_start).toBe(false)
  })
})
