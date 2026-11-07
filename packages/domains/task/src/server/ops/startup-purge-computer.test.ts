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
