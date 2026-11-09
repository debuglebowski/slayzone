/**
 * Final review round 5, R5-1: the 30-day Trash purge runs at boot, before any
 * computer is connected. Its worktree removal was refused, but the task rows were
 * deleted anyway, so the worktree folder and its git registration stayed behind for
 * good (the branch stayed checked out there). A row is now deleted only once its
 * worktree is gone from the computer that holds it: no computer yet → the row stays
 * and the purge runs again when one connects (`purgeExpiredTrash`). A computer that is
 * permanently gone (deleted or revoked) never blocks the purge: its rows go, and the
 * worktree it held is reported as left behind.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import {
  configureTaskRuntimeAdapters,
  getRuntimeAdapters,
  type WorktreeComputerState
} from './shared.js'
import { purgeExpiredTrash, purgeStaleAndOrphanedTasks } from './startup-purge.js'

type Harness = Awaited<ReturnType<typeof createTestHarness>>

let state: WorktreeComputerState
let removed: string[]
let removeFails: (() => Error) | null
const events: string[] = []

beforeEach(() => {
  state = 'ready'
  removed = []
  removeFails = null
  events.length = 0
  const base = getRuntimeAdapters()
  configureTaskRuntimeAdapters({
    getDataRoot: () => mkdtempSync(join(tmpdir(), 'purge-computer-')),
    recordDiagnosticEvent: (e) => void events.push(e.event),
    projectRootForTask: async () => '/repo/app',
    worktreeComputerState: async () => state,
    worktrees: {
      ...base.worktrees,
      hubPathExists: () => false,
      removeWorktree: async (_taskId, _root, worktreePath) => {
        if (removeFails) throw removeFails()
        removed.push(worktreePath)
        return { removed: true } as never
      }
    }
  })
})

function seedExpired(h: Harness, id: string, worktree: string | null): void {
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, `p-${id}`, '#000', '/repo/app', '[]')
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, worktree_path, deleted_at)
       VALUES (?, ?, 't', 'todo', ?, datetime('now', '-31 days'))`
    )
    .run(id, projectId, worktree)
}

const exists = (h: Harness, id: string): boolean =>
  h.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id) !== undefined

test('R5-1: boot with no computer keeps the row; on connect the worktree goes, then the row', async () => {
  const h = await createTestHarness()
  seedExpired(h, 'r51-wt', '/repo/app-wt/task-1')
  seedExpired(h, 'r51-plain', null)

  state = 'wait' // boot: no computer connected yet
  await purgeStaleAndOrphanedTasks(h.slayDb)
  expect(exists(h, 'r51-wt')).toBe(true)
  expect(removed).toEqual([])
  expect(exists(h, 'r51-plain')).toBe(false) // nothing on a computer: purged as before

  state = 'ready' // the computer connected
  await purgeExpiredTrash(h.slayDb)
  expect(removed).toEqual(['/repo/app-wt/task-1'])
  expect(exists(h, 'r51-wt')).toBe(false)
})

test('R5-1: a computer lost mid-removal keeps the row for the next connect', async () => {
  const h = await createTestHarness()
  seedExpired(h, 'r51-race', '/repo/app-wt/task-2')
  removeFails = () => {
    state = 'wait' // it disconnected while the request was in flight
    return new Error('computer disconnected')
  }
  await purgeExpiredTrash(h.slayDb)
  expect(exists(h, 'r51-race')).toBe(true)

  removeFails = null
  state = 'ready'
  await purgeExpiredTrash(h.slayDb)
  expect(removed).toEqual(['/repo/app-wt/task-2'])
  expect(exists(h, 'r51-race')).toBe(false)
})

test('R5-1: a computer that is gone for good never blocks the purge', async () => {
  const h = await createTestHarness()
  seedExpired(h, 'r51-gone', '/repo/app-wt/task-3')
  state = 'gone'
  await purgeStaleAndOrphanedTasks(h.slayDb)
  expect(exists(h, 'r51-gone')).toBe(false)
  expect(removed).toEqual([])
  expect(events).toContain('task.purge_worktree_left_behind')
})

test('R5-1: a removal the computer itself fails (not a lost computer) does not block', async () => {
  const h = await createTestHarness()
  seedExpired(h, 'r51-gitfail', '/repo/app-wt/task-4')
  removeFails = () => new Error('git worktree remove failed')
  await purgeExpiredTrash(h.slayDb)
  expect(exists(h, 'r51-gitfail')).toBe(false)
  expect(events).toContain('task.cleanup_worktree_failed')
})

// Subtasks of a purged task. Deleting a task moves only that task to Trash — its
// subtasks stay on the board, and restore brings back only that task. The purge's
// `DELETE FROM tasks` used to take every descendant with it (`parent_id … ON DELETE
// CASCADE`): live subtasks, subtasks still restorable from Trash, and expired ones
// whose own worktree removal was still waiting on their computer. A task the purge
// does not delete now survives: it moves up to the nearest ancestor that stays, else
// to the top level.

function seedTask(
  h: Harness,
  t: {
    id: string
    projectId: string
    parentId?: string | null
    worktree?: string | null
    /** SQLite datetime modifier relative to now, e.g. '-31 days'; omitted = live. */
    deletedAgo?: string
  }
): void {
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, parent_id, title, status, worktree_path, deleted_at)
       VALUES (?, ?, ?, 't', 'todo', ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`
    )
    .run(
      t.id,
      t.projectId,
      t.parentId ?? null,
      t.worktree ?? null,
      t.deletedAgo ?? null,
      t.deletedAgo ?? null
    )
}

function seedProjectRow(h: Harness): string {
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, `p-${projectId}`, '#000', '/repo/app', '[]')
  return projectId
}

const parentOf = (h: Harness, id: string): string | null | undefined =>
  (
    h.db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id) as
      | { parent_id: string | null }
      | undefined
  )?.parent_id

test('subtasks: a live subtask of an expired task survives the purge, now top-level', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, { id: 'sp-parent', projectId: p, deletedAgo: '-31 days' })
  seedTask(h, { id: 'sp-live', projectId: p, parentId: 'sp-parent' })
  seedTask(h, { id: 'sp-live-grandchild', projectId: p, parentId: 'sp-live' })

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'sp-parent')).toBe(false)
  expect(exists(h, 'sp-live')).toBe(true)
  expect(parentOf(h, 'sp-live')).toBeNull()
  // Untouched below the survivor.
  expect(parentOf(h, 'sp-live-grandchild')).toBe('sp-live')
})

test('subtasks: a survivor moves up to the nearest ancestor that stays', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, { id: 'sa-root', projectId: p })
  seedTask(h, { id: 'sa-mid', projectId: p, parentId: 'sa-root', deletedAgo: '-40 days' })
  seedTask(h, { id: 'sa-low', projectId: p, parentId: 'sa-mid', deletedAgo: '-31 days' })
  seedTask(h, { id: 'sa-live', projectId: p, parentId: 'sa-low' })
  seedTask(h, { id: 'sa-expired-leaf', projectId: p, parentId: 'sa-low', deletedAgo: '-35 days' })

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'sa-mid')).toBe(false)
  expect(exists(h, 'sa-low')).toBe(false)
  expect(exists(h, 'sa-expired-leaf')).toBe(false)
  expect(parentOf(h, 'sa-live')).toBe('sa-root')
})

test('subtasks: a subtask still restorable from Trash survives its expired parent', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, { id: 'st-parent', projectId: p, deletedAgo: '-31 days' })
  seedTask(h, { id: 'st-recent', projectId: p, parentId: 'st-parent', deletedAgo: '-2 days' })

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'st-parent')).toBe(false)
  expect(exists(h, 'st-recent')).toBe(true)
  expect(parentOf(h, 'st-recent')).toBeNull()
  // Still in Trash, still restorable.
  expect(
    (
      h.db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get('st-recent') as {
        deleted_at: string | null
      }
    ).deleted_at
  ).not.toBeNull()
})

test('subtasks: an expired subtask waiting on its computer is not deleted with its parent', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, { id: 'sw-parent', projectId: p, deletedAgo: '-31 days' })
  seedTask(h, {
    id: 'sw-child',
    projectId: p,
    parentId: 'sw-parent',
    worktree: '/repo/app-wt/child',
    deletedAgo: '-31 days'
  })
  state = 'wait' // the child's computer is not connected

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'sw-parent')).toBe(false)
  expect(exists(h, 'sw-child')).toBe(true)
  expect(removed).toEqual([])

  state = 'ready'
  await purgeExpiredTrash(h.slayDb)
  expect(removed).toEqual(['/repo/app-wt/child'])
  expect(exists(h, 'sw-child')).toBe(false)
})

test('subtasks: the worktree a live subtask shares with its purged parent stays', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, {
    id: 'ss-parent',
    projectId: p,
    worktree: '/repo/app-wt/shared',
    deletedAgo: '-31 days'
  })
  seedTask(h, {
    id: 'ss-live',
    projectId: p,
    parentId: 'ss-parent',
    worktree: '/repo/app-wt/shared'
  })

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'ss-parent')).toBe(false)
  expect(removed).toEqual([])
  expect(exists(h, 'ss-live')).toBe(true)
  expect(parentOf(h, 'ss-live')).toBeNull()
})

test('subtasks: the worktree a still-restorable subtask shares with its purged parent stays', async () => {
  const h = await createTestHarness()
  const p = seedProjectRow(h)
  seedTask(h, {
    id: 'sr-parent',
    projectId: p,
    worktree: '/repo/app-wt/shared-trash',
    deletedAgo: '-31 days'
  })
  seedTask(h, {
    id: 'sr-recent',
    projectId: p,
    parentId: 'sr-parent',
    worktree: '/repo/app-wt/shared-trash',
    deletedAgo: '-2 days'
  })

  await purgeExpiredTrash(h.slayDb)

  expect(exists(h, 'sr-parent')).toBe(false)
  // Trash keeps a task's files for 30 days — restoring it must find its worktree.
  expect(removed).toEqual([])
  expect(exists(h, 'sr-recent')).toBe(true)
})
