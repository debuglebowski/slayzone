/**
 * Stale-temp-task cleanup contract tests
 * Covers the bugfix for "temp tasks lost on slay upgrade":
 * cleanup must spare stale temp tasks that are still present in the persisted
 * tab list (viewState), and only purge true orphans.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 pnpm electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/task/src/main/handlers-temp-cleanup.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers } from './handlers.js'

const projectId = crypto.randomUUID()

const STALE_OPEN_ID = 'stale-open-temp'
const STALE_ORPHAN_ID = 'stale-orphan-temp'
const FRESH_ID = 'fresh-temp'
const REGULAR_STALE_ID = 'stale-regular'

await describe('temp-task cleanup honours persisted viewState', () => {
  test('open stale temp survives, orphan stale temp purged, fresh + regular untouched', async () => {
    const h = await createTestHarness()

    h.db.prepare(
      'INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)'
    ).run(projectId, 'CleanupProj', '#000', '/tmp/cleanup-test', JSON.stringify([]))

    const insertTask = h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', 'claude-code', ?, datetime('now', ?), datetime('now', ?))
    `)
    insertTask.run(STALE_OPEN_ID, projectId, 'Open Scratch', 1, '-3 days', '-3 days')
    insertTask.run(STALE_ORPHAN_ID, projectId, 'Orphan Scratch', 1, '-3 days', '-3 days')
    insertTask.run(FRESH_ID, projectId, 'Fresh Scratch', 1, '-1 hour', '-1 hour')
    insertTask.run(REGULAR_STALE_ID, projectId, 'Regular Old', 0, '-3 days', '-3 days')

    const viewState = {
      tabs: [
        { type: 'home' },
        { type: 'task', taskId: STALE_OPEN_ID, title: 'Open Scratch' }
      ],
      activeTabIndex: 1,
      selectedProjectId: projectId
    }
    h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('viewState', JSON.stringify(viewState))

    registerTaskHandlers(h.ipcMain as never, h.db)

    const surviving = h.db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as { id: string }[]
    const ids = new Set(surviving.map((r) => r.id))

    expect(ids.has(STALE_OPEN_ID)).toBe(true)
    expect(ids.has(FRESH_ID)).toBe(true)
    expect(ids.has(REGULAR_STALE_ID)).toBe(true)
    expect(ids.has(STALE_ORPHAN_ID)).toBe(false)

    h.cleanup()
  })

  test('corrupt viewState falls back to time-only purge', async () => {
    const h = await createTestHarness()

    h.db.prepare(
      'INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)'
    ).run(projectId, 'CleanupProj2', '#000', '/tmp/cleanup-test2', JSON.stringify([]))

    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))
    `).run('orphan-corrupt-vs', projectId, 'Orphan')

    h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('viewState', '{not valid json')

    registerTaskHandlers(h.ipcMain as never, h.db)

    const surviving = h.db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as { id: string }[]
    expect(surviving.find((r) => r.id === 'orphan-corrupt-vs')).toBeUndefined()

    h.cleanup()
  })

  test('missing viewState still purges orphans by time gate', async () => {
    const h = await createTestHarness()

    h.db.prepare(
      'INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)'
    ).run(projectId, 'CleanupProj3', '#000', '/tmp/cleanup-test3', JSON.stringify([]))

    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))
    `).run('orphan-no-vs', projectId, 'Orphan')

    registerTaskHandlers(h.ipcMain as never, h.db)

    const surviving = h.db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as { id: string }[]
    expect(surviving.find((r) => r.id === 'orphan-no-vs')).toBeUndefined()

    h.cleanup()
  })
})
