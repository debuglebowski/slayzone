import { test, expect, seed, TEST_PROJECT_PATH, resetApp } from '../fixtures/electron'
import type { Page } from 'playwright'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

test.describe('Automations: catchup_on_start (IPC end-to-end)', () => {
  let dbPath = ''
  let projectId = ''

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)

    const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_DB_DIR!)
    dbPath = path.join(dbDir, 'slayzone.dev.sqlite')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CatchupProj', color: '#22c55e', path: TEST_PROJECT_PATH })
    projectId = p.id
    await s.refreshData()
  })

  function invoke<T = unknown>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
    return page.evaluate(
      ([ch, a]) => (window as unknown as Window).__testInvoke(ch, ...(a as unknown[])),
      [channel, args] as const
    ) as Promise<T>
  }

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
    ...(catchup_on_start !== undefined ? { catchup_on_start } : {}),
  })

  test('migration v124 applied: catchup_on_start defaults true', async ({ mainWindow }) => {
    const created = await invoke<{ id: string; catchup_on_start: boolean }>(
      mainWindow, 'db:automations:create', buildCronInput('default-catchup')
    )
    expect(created.catchup_on_start).toBe(true)
    expect(readRow(created.id)?.catchup_on_start).toBe(1)
  })

  test('create with catchup_on_start: false is honored', async ({ mainWindow }) => {
    const created = await invoke<{ id: string; catchup_on_start: boolean }>(
      mainWindow, 'db:automations:create', buildCronInput('opt-out', false)
    )
    expect(created.catchup_on_start).toBe(false)
    expect(readRow(created.id)?.catchup_on_start).toBe(0)
  })

  test('update flips catchup_on_start', async ({ mainWindow }) => {
    const created = await invoke<{ id: string; catchup_on_start: boolean }>(
      mainWindow, 'db:automations:create', buildCronInput('flip-target')
    )
    expect(created.catchup_on_start).toBe(true)

    await invoke(mainWindow, 'db:automations:update', { id: created.id, catchup_on_start: false })
    expect(readRow(created.id)?.catchup_on_start).toBe(0)

    await invoke(mainWindow, 'db:automations:update', { id: created.id, catchup_on_start: true })
    expect(readRow(created.id)?.catchup_on_start).toBe(1)
  })

  test('get returns parsed boolean', async ({ mainWindow }) => {
    const created = await invoke<{ id: string }>(
      mainWindow, 'db:automations:create', buildCronInput('get-test', false)
    )
    const fetched = await invoke<{ id: string; catchup_on_start: boolean }>(
      mainWindow, 'db:automations:get', created.id
    )
    expect(fetched.catchup_on_start).toBe(false)
  })
})
