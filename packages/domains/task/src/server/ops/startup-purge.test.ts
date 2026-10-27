/**
 * purgeStaleAndOrphanedTasks contract tests. Ports the coverage from the legacy
 * IPC-handler test (task/src/electron/handlers-temp-cleanup.test.ts), which
 * exercised the same logic via the now-dead registerTaskHandlers startup block.
 * The purge is async (worker-thread DB), so we AWAIT it directly here — the old
 * test read survivors synchronously right after handler registration and raced
 * the fire-and-forget purge.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { purgeStaleAndOrphanedTasks } from './startup-purge.js'
import { configureTaskRuntimeAdapters } from './shared.js'

// cleanupTaskFull (invoked by the purge) resolves the data root via the task
// runtime adapter — point it at a temp dir so cleanup doesn't throw.
configureTaskRuntimeAdapters({ getDataRoot: () => mkdtempSync(join(tmpdir(), 'purge-')) })

const STALE_OPEN_ID = 'stale-open-temp'
const STALE_ORPHAN_ID = 'stale-orphan-temp'
const FRESH_ID = 'fresh-temp'
const REGULAR_STALE_ID = 'stale-regular'

const seedProject = (
  h: Awaited<ReturnType<typeof createTestHarness>>,
  pid: string,
  name: string
): void => {
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(pid, name, '#000', '/tmp/' + name, JSON.stringify([]))
}
const survivingIds = (h: Awaited<ReturnType<typeof createTestHarness>>): Set<string> =>
  new Set(
    (h.db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as { id: string }[]).map(
      (r) => r.id
    )
  )

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
  h.db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('viewState', JSON.stringify(viewState))

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
  h.db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('viewState', '{not valid json')

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

// T-16 (G-09): on a hub with login, `viewState` is per user (`user_settings`), and
// the purge must honour EVERY user's open tabs — not just one global row, which let
// user A's tabs decide which of user B's temporary tasks were deleted.
test("purge: user B's open tabs keep B's temp tasks alive when A's viewState does not list them", async () => {
  const h = await createTestHarness()
  const projectA = crypto.randomUUID()
  const projectB = crypto.randomUUID()
  seedProject(h, projectA, 'ProjA')
  seedProject(h, projectB, 'ProjB')
  h.db.prepare('UPDATE projects SET owner_user_id = ? WHERE id = ?').run('user-a', projectA)
  h.db.prepare('UPDATE projects SET owner_user_id = ? WHERE id = ?').run('user-b', projectB)
  const insertTemp = h.db.prepare(`
    INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
    VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))
  `)
  insertTemp.run('a-open', projectA, 'A open scratch')
  insertTemp.run('b-open', projectB, 'B open scratch')
  insertTemp.run('b-orphan', projectB, 'B closed scratch')

  const viewState = (taskId: string, projectId: string): string =>
    JSON.stringify({
      tabs: [{ type: 'home' }, { type: 'task', taskId, title: 'x' }],
      activeTabIndex: 1,
      selectedProjectId: projectId
    })
  const putUserViewState = h.db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'viewState', ?)`
  )
  putUserViewState.run('user-a', viewState('a-open', projectA))
  putUserViewState.run('user-b', viewState('b-open', projectB))

  await purgeStaleAndOrphanedTasks(h.slayDb)

  const ids = survivingIds(h)
  expect(ids.has('a-open')).toBe(true)
  // A's view state does not list it; B's does — so it survives.
  expect(ids.has('b-open')).toBe(true)
  // Open in nobody's tabs: still purged by the time gate.
  expect(ids.has('b-orphan')).toBe(false)
})

test("purge: one user's corrupt viewState protects nothing but does not void the others", async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  seedProject(h, projectId, 'ProjMixed')
  const insertTemp = h.db.prepare(`
    INSERT INTO tasks (id, project_id, title, status, terminal_mode, is_temporary, created_at, updated_at)
    VALUES (?, ?, ?, 'in_progress', 'claude-code', 1, datetime('now', '-3 days'), datetime('now', '-3 days'))
  `)
  insertTemp.run('kept-by-global', projectId, 'Global tab')
  insertTemp.run('kept-by-b', projectId, 'B tab')
  insertTemp.run('orphan', projectId, 'Nobody')
  // A hub that ran without login before: the global row still counts.
  h.db
    .prepare(`INSERT INTO settings (key, value) VALUES ('viewState', ?)`)
    .run(JSON.stringify({ tabs: [{ type: 'task', taskId: 'kept-by-global', title: 'x' }] }))
  h.db
    .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES ('user-a', 'viewState', ?)`)
    .run('{not valid json')
  h.db
    .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES ('user-b', 'viewState', ?)`)
    .run(JSON.stringify({ tabs: [{ type: 'task', taskId: 'kept-by-b', title: 'x' }] }))

  await purgeStaleAndOrphanedTasks(h.slayDb)

  const ids = survivingIds(h)
  expect(ids.has('kept-by-global')).toBe(true)
  expect(ids.has('kept-by-b')).toBe(true)
  expect(ids.has('orphan')).toBe(false)
})
