import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// TaskHistoryPanel when its page-1 load fails. That load had no `.catch`: a failed
// load (hub briefly unreachable, server error) left "Loading history..." on screen
// forever. It now shows "Couldn't load history." with a Retry that re-runs it.
//
// The failure is a real server error, forced deterministically: the hub's
// `activity_events` table is renamed away through the e2e-only raw-SQL seam
// (`__db`, PLAYWRIGHT-gated `/api/dev/sql`), so `history.listForTask` throws
// "no such table". Renaming it back is what lets Retry succeed. The table is only
// away between opening the task and Retry — nothing writes history in that window.

const HIDDEN_TABLE = 'activity_events_e2e_hidden'

/** Raw SQL against the hub's database (the forwarder main installs for e2e). */
function hubSql(
  electronApp: ElectronApplication,
  method: 'get' | 'exec',
  sql: string
): Promise<unknown> {
  return electronApp.evaluate(
    async (_electron, args) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        get: (sql: string) => Promise<unknown>
        exec: (sql: string) => Promise<unknown>
      }
      return db[args.method](args.sql)
    },
    { method, sql }
  )
}

const hideHistoryTable = (electronApp: ElectronApplication) =>
  hubSql(electronApp, 'exec', `ALTER TABLE activity_events RENAME TO ${HIDDEN_TABLE}`)

/** Idempotent: a no-op unless the table is currently hidden. */
async function restoreHistoryTable(electronApp: ElectronApplication): Promise<void> {
  const hidden = await hubSql(
    electronApp,
    'get',
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${HIDDEN_TABLE}'`
  )
  if (hidden) {
    await hubSql(electronApp, 'exec', `ALTER TABLE ${HIDDEN_TABLE} RENAME TO activity_events`)
  }
}

/** The settings panel of the task on screen (hidden tabs are visibility:hidden). */
const settingsPanel = (page: Page) =>
  page.getByTestId('task-settings-panel').filter({ visible: true })
const viewActivity = (page: Page) =>
  settingsPanel(page).getByRole('button', { name: 'View activity' })

test.describe('TaskHistoryPanel when its load fails', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'History Load Error',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    taskId = (await s.createTask({ projectId: p.id, title: 'HLE task', status: 'todo' })).id
    await s.refreshData()
  })

  // Never leave the table hidden for a later test or spec, whatever failed.
  test.afterEach(async ({ electronApp }) => {
    await restoreHistoryTable(electronApp)
  })

  test('a failed first load shows the error with Retry; Retry loads the history', async ({
    electronApp,
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    await expect(viewActivity(mainWindow)).toBeVisible({ timeout: 10_000 })

    // The click mounts the history panel: its first load hits the missing table.
    await hideHistoryTable(electronApp)
    await viewActivity(mainWindow).click()
    const panel = settingsPanel(mainWindow)
    await expect(panel.getByTestId('task-history-load-error')).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByText("Couldn't load history.")).toBeVisible()
    await expect(panel.getByText('Loading history...')).toHaveCount(0)

    await restoreHistoryTable(electronApp)
    await panel.getByRole('button', { name: 'Retry' }).click()
    await expect(panel.getByText('Task created')).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByTestId('task-history-load-error')).toHaveCount(0)
  })
})
