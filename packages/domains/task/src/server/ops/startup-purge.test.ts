/**
 * purgeStaleAndOrphanedTasks contract tests. Ports the coverage from the legacy
 * IPC-handler test (task/src/electron/handlers-temp-cleanup.test.ts), which
 * exercised the same logic via the now-dead registerTaskHandlers startup block.
 * The purge is async (worker-thread DB), so we AWAIT it directly here — the old
 * test read survivors synchronously right after handler registration and raced
 * the fire-and-forget purge.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import { purgeStaleAndOrphanedTasks } from './startup-purge.js'
import { configureTaskRuntimeAdapters } from './shared.js'

// cleanupTaskFull (invoked by the purge) resolves the data root via the task
// runtime adapter — point it at a temp dir so cleanup doesn't throw.
configureTaskRuntimeAdapters({ getDataRoot: () => mkdtempSync(join(tmpdir(), 'purge-')) })

const STALE_OPEN_ID = 'stale-open-temp'
const STALE_ORPHAN_ID = 'stale-orphan-temp'
const FRESH_ID = 'fresh-temp'
const REGULAR_STALE_ID = 'stale-regular'

const seedProject = (h: Awaited<ReturnType<typeof createTestHarness>>, pid: string, name: string): void => {
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(pid, name, '#000', '/tmp/' + name, JSON.stringify([]))
}
const survivingIds = (h: Awaited<ReturnType<typeof createTestHarness>>): Set<string> =>
  new Set((h.db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as { id: string }[]).map((r) => r.id))

test('purge: open stale temp survives, orphan stale temp purged, fresh + regular untouched', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  seedProject(h, projectId, 'CleanupProj')
  const insertTask = h.db.prepare(`
    INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
    VALUES (?, ?, ?, 'in_progress', 'claude-code', ?, datetime('now', ?), datetime('now', ?))
  `)
  insertTask.run(STALE_OPEN_ID, projectId, 'Open Scratch', 1, '-3 days', '-3 days')
  insertTask.run(STALE_ORPHAN_ID, projectId, 'Orphan Scratch', 1, '-3 days', '-3 days')
  insertTask.run(FRESH_ID, projectId, 'Fresh Scratch', 1, '-1 hour', '-1 hour')
  insertTask.run(REGULAR_STALE_ID, projectId, 'Regular Old', 0, '-3 days', '-3 days')

  const viewState = {
    tabs: [{ type: 'home' }, { type: 'task', taskId: STALE_OPEN_ID, title: 'Open Scratch' }],
    activeTabIndex: 1,
    selectedProjectId: projectId
  }
  h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('viewState', JSON.stringify(viewState))

  await purgeStaleAndOrphanedTasks(h.slayDb)

  const ids = survivingIds(h)
  expect(ids.has(STALE_OPEN_ID)).toBe(true)
  expect(ids.has(FRESH_ID)).toBe(true)
  expect(ids.has(REGULAR_STALE_ID)).toBe(true)
  expect(ids.has(STALE_ORPHAN_ID)).toBe(false)
})

test('purge: corrupt viewState falls back to time-only purge', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  seedProject(h, projectId, 'CleanupProj2')
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))`)
    .run('orphan-corrupt-vs', projectId, 'Orphan')
  h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('viewState', '{not valid json')

  await purgeStaleAndOrphanedTasks(h.slayDb)
  expect(survivingIds(h).has('orphan-corrupt-vs')).toBe(false)
})

test('purge: missing viewState still purges orphans by time gate', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  seedProject(h, projectId, 'CleanupProj3')
  h.db
    .prepare(`INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))`)
    .run('orphan-no-vs', projectId, 'Orphan')

  await purgeStaleAndOrphanedTasks(h.slayDb)
  expect(survivingIds(h).has('orphan-no-vs')).toBe(false)
})
