/**
 * WorktreeExecAdapters seam contract tests (hub/runner split, wave 1).
 * maybeAutoCreateWorktree + cleanupTaskFull must run every git/fs side effect
 * through the injected `runtimeAdapters.worktrees` seam. Fake adapters record
 * call order against an in-memory DB:
 *   - happy path: create → link (DB UPDATE) → copy → setup ordering
 *   - recovered-worktree branch: createWorktree throws but pathExists() is true
 *     → task still linked, copy/setup skipped
 *   - cleanupTaskFull shared-worktree guard: removal skipped while another live
 *     task references the same worktree; batchIds unblocks it
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import {
  cleanupTaskFull,
  configureTaskRuntimeAdapters,
  maybeAutoCreateWorktree,
  type WorktreeExecAdapters
} from './shared.js'

type Harness = Awaited<ReturnType<typeof createTestHarness>>

const seedProject = (
  h: Harness,
  pid: string,
  opts: { autoCreate?: number; copyBehavior?: string | null } = {}
): void => {
  h.db
    .prepare(
      `INSERT INTO projects (id, name, color, path, columns_config,
         auto_create_worktree_on_task_create, worktree_copy_behavior)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pid,
      'WtProj-' + pid.slice(0, 8),
      '#000',
      '/tmp/wt-proj-' + pid.slice(0, 8),
      JSON.stringify([]),
      opts.autoCreate ?? 1,
      opts.copyBehavior ?? null
    )
}

const seedTask = (h: Harness, id: string, pid: string, title: string): void => {
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, terminal_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'in_progress', 'claude-code', datetime('now'), datetime('now'))`
    )
    .run(id, pid, title)
}

const taskRow = (
  h: Harness,
  id: string
): { worktree_path: string | null; worktree_parent_branch: string | null } =>
  h.db.prepare('SELECT worktree_path, worktree_parent_branch FROM tasks WHERE id = ?').get(id) as {
    worktree_path: string | null
    worktree_parent_branch: string | null
  }

/** Full fake set (override contract: complete object). Mutating exec ops
 *  (create/remove/setup/copy/removeArtifactDir) record into `calls` so ordering
 *  and unexpected mutations surface; read-only probes (isGitRepo,
 *  getCurrentBranch, colors, pathExists) return fixed values and are NOT
 *  ordering-checked. */
const makeFakes = (
  calls: string[],
  overrides: Partial<WorktreeExecAdapters> = {}
): WorktreeExecAdapters => ({
  createWorktree: async () => {
    calls.push('create')
  },
  removeWorktree: async () => {
    calls.push('remove')
    return {}
  },
  runWorktreeSetupScript: async () => {
    calls.push('setup')
    return { ran: false }
  },
  copyIgnoredFiles: async () => {
    calls.push('copy')
  },
  getCurrentBranch: async () => 'main',
  isGitRepo: async () => true,
  getWorktreeColor: () => undefined,
  ensureProjectWorktreeColors: async () => new Map(),
  pathExists: () => false,
  removeArtifactDir: () => {
    calls.push('removeArtifactDir')
  },
  ...overrides
})

test('maybeAutoCreateWorktree: create → link → copy → setup ordering', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  seedProject(h, projectId, { copyBehavior: 'all' })
  seedTask(h, taskId, projectId, 'Order Test Task')

  const calls: string[] = []
  // Snapshot the DB link state at each exec boundary — fakes must not throw
  // (createWorktree/copyIgnoredFiles rejections are caught by design), so
  // record here and assert after the run.
  let linkAtCreate: string | null | undefined
  let linkAtCopy: string | null | undefined
  const fakes = makeFakes(calls, {
    createWorktree: async () => {
      linkAtCreate = taskRow(h, taskId).worktree_path
      calls.push('create')
    },
    copyIgnoredFiles: async () => {
      linkAtCopy = taskRow(h, taskId).worktree_path
      calls.push('copy')
    }
  })
  configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir(), worktrees: fakes })

  await maybeAutoCreateWorktree(h.slayDb, taskId, projectId, 'Order Test Task')

  expect(calls).toEqual(['create', 'copy', 'setup'])
  expect(linkAtCreate).toBeNull() // not yet linked when git ran
  expect(typeof linkAtCopy).toBe('string') // linked before copy
  const row = taskRow(h, taskId)
  expect(row.worktree_path).toBe(linkAtCopy)
  expect(row.worktree_parent_branch).toBe('main')
  h.cleanup()
})

test('maybeAutoCreateWorktree: create throws but dir exists → task still linked, copy/setup skipped', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  seedProject(h, projectId, { copyBehavior: 'all' })
  seedTask(h, taskId, projectId, 'Recovered Worktree Task')

  const calls: string[] = []
  const fakes = makeFakes(calls, {
    createWorktree: async () => {
      calls.push('create')
      throw new Error('post-checkout hook failed')
    },
    pathExists: (p) => {
      calls.push('pathExists:' + p)
      return true
    }
  })
  configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir(), worktrees: fakes })

  await maybeAutoCreateWorktree(h.slayDb, taskId, projectId, 'Recovered Worktree Task')

  const row = taskRow(h, taskId)
  expect(typeof row.worktree_path).toBe('string') // recovered link
  expect(row.worktree_parent_branch).toBe('main')
  expect(calls[0]).toBe('create')
  expect(calls.filter((c) => c === 'copy' || c === 'setup')).toHaveLength(0)
  h.cleanup()
})

test('maybeAutoCreateWorktree: create throws and dir missing → no link, no copy/setup', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  seedProject(h, projectId, { copyBehavior: 'all' })
  seedTask(h, taskId, projectId, 'Failed Worktree Task')

  const calls: string[] = []
  const fakes = makeFakes(calls, {
    createWorktree: async () => {
      calls.push('create')
      throw new Error('fatal: could not create work tree')
    }
    // pathExists stays false
  })
  configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir(), worktrees: fakes })

  await maybeAutoCreateWorktree(h.slayDb, taskId, projectId, 'Failed Worktree Task')

  expect(taskRow(h, taskId).worktree_path).toBeNull()
  expect(calls).toEqual(['create'])
  h.cleanup()
})

test('cleanupTaskFull: shared-worktree guard skips removal, batchIds unblocks it', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  const taskA = crypto.randomUUID()
  const taskB = crypto.randomUUID()
  seedProject(h, projectId)
  seedTask(h, taskA, projectId, 'Shared A')
  seedTask(h, taskB, projectId, 'Shared B')
  const sharedWt = '/tmp/wt/shared-' + taskA.slice(0, 8)
  h.db
    .prepare('UPDATE tasks SET worktree_path = ? WHERE id IN (?, ?)')
    .run(sharedWt, taskA, taskB)
  const projectPath = (
    h.db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string }
  ).path

  const dataRoot = mkdtempSync(join(tmpdir(), 'wt-exec-'))
  const removeCalls: Array<[string, string]> = []
  const calls: string[] = []
  const fakes = makeFakes(calls, {
    removeWorktree: async (projPath, wtPath) => {
      removeCalls.push([projPath, wtPath])
      return {}
    },
    // Artifacts dir "exists" → removeArtifactDir seam must fire (rmSync path).
    pathExists: () => true
  })
  configureTaskRuntimeAdapters({ getDataRoot: () => dataRoot, worktrees: fakes })

  // taskB still live and outside the batch → guard skips removal.
  await cleanupTaskFull(h.slayDb, taskA)
  expect(removeCalls).toHaveLength(0)
  expect(calls.filter((c) => c === 'removeArtifactDir')).toHaveLength(1)

  // Whole batch covers both referencing tasks → removal proceeds.
  await cleanupTaskFull(h.slayDb, taskA, [taskA, taskB])
  expect(removeCalls).toHaveLength(1)
  expect(removeCalls[0]).toEqual([projectPath, sharedWt])
  h.cleanup()
})
