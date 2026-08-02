/**
 * Exec-boundary contract: the hub must remain fully functional with ZERO runners.
 *
 * Codifies docs/exec-boundary.md. Every hub-owned call is driven through a
 * WorktreeExecAdapters whose ROUTABLE methods all throw — simulating enforcement
 * with no runner available — and asserts the hub-owned paths still complete.
 *
 * Written because the boundary was previously discovered by watching e2e fail four
 * times: artifact-dir probes, the task-create git probe, and the boot-time purge
 * each broke once routed. A table in a doc does not prevent that; this does.
 */
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import {
  cleanupTaskFull,
  configureTaskRuntimeAdapters,
  maybeAutoCreateWorktree,
  type WorktreeExecAdapters
} from './shared.js'

type Harness = Awaited<ReturnType<typeof createTestHarness>>

const noRunner = (what: string) => (): never => {
  const err = new Error(`No runner available to run ${what}`)
  err.name = 'NoRunnerAvailableError'
  throw err
}

/** Adapters where every ROUTED method fails, and only hub-owned ones work. */
const zeroRunnerAdapters = (hubCalls: string[]): WorktreeExecAdapters => ({
  createWorktree: async () => noRunner('worktree create')(),
  removeWorktree: async () => noRunner('worktree remove')(),
  runWorktreeSetupScript: async () => noRunner('setup script')(),
  copyIgnoredFiles: async () => noRunner('copy ignored')(),
  getCurrentBranch: async () => noRunner('branch read')(),
  isGitRepo: async () => noRunner('git repo probe')(),
  pathExists: () => noRunner('path probe')(),
  // Hub-owned: must be reachable with no runner.
  getWorktreeColor: () => {
    hubCalls.push('getWorktreeColor')
    return '#abcdef'
  },
  ensureProjectWorktreeColors: async () => {
    hubCalls.push('ensureProjectWorktreeColors')
    return new Map()
  },
  hubPathExists: () => {
    hubCalls.push('hubPathExists')
    return true
  },
  removeArtifactDir: () => {
    hubCalls.push('removeArtifactDir')
  }
})

const seedProject = (h: Harness, pid: string): void => {
  h.db
    .prepare(
      `INSERT INTO projects (id, name, color, path, columns_config,
         auto_create_worktree_on_task_create) VALUES (?, ?, ?, ?, ?, 1)`
    )
    .run(pid, 'P-' + pid.slice(0, 6), '#000', '/tmp/p-' + pid.slice(0, 6), JSON.stringify([]))
}
const seedTask = (h: Harness, id: string, pid: string): void => {
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, terminal_mode, created_at, updated_at)
       VALUES (?, ?, 'T', 'in_progress', 'claude-code', datetime('now'), datetime('now'))`
    )
    .run(id, pid)
}

test('zero runners: task CREATE succeeds, worktree is skipped not fatal', async () => {
  const h = await createTestHarness()
  const pid = crypto.randomUUID()
  const tid = crypto.randomUUID()
  seedProject(h, pid)
  seedTask(h, tid, pid)
  configureTaskRuntimeAdapters({
    getDataRoot: () => tmpdir(),
    worktrees: zeroRunnerAdapters([])
  })

  // Must NOT throw: auto-create is best-effort and runs before any agent exists.
  await maybeAutoCreateWorktree(h.slayDb, tid, pid, 'T')
  const row = h.db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(tid) as {
    worktree_path: string | null
  }
  expect(row.worktree_path).toBeNull()
  h.cleanup()
})

test('zero runners: task ARCHIVE cleanup still removes hub artifacts', async () => {
  const h = await createTestHarness()
  const pid = crypto.randomUUID()
  const tid = crypto.randomUUID()
  seedProject(h, pid)
  seedTask(h, tid, pid)
  const hubCalls: string[] = []
  configureTaskRuntimeAdapters({
    getDataRoot: () => tmpdir(),
    worktrees: zeroRunnerAdapters(hubCalls)
  })

  // Must NOT throw even though every routable method does.
  await cleanupTaskFull(h.slayDb, tid)
  // The hub-owned artifact path ran: that is the call that broke archiving when it
  // was wrongly routed.
  expect(hubCalls).toContain('hubPathExists')
  expect(hubCalls).toContain('removeArtifactDir')
  h.cleanup()
})

test('zero runners: cleanup of a task WITH a worktree still completes', async () => {
  const h = await createTestHarness()
  const pid = crypto.randomUUID()
  const tid = crypto.randomUUID()
  seedProject(h, pid)
  seedTask(h, tid, pid)
  h.db.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run('/tmp/wt-x', tid)
  configureTaskRuntimeAdapters({
    getDataRoot: () => tmpdir(),
    worktrees: zeroRunnerAdapters([])
  })

  // removeWorktree IS routed and throws here; cleanup wraps it, so archiving a task
  // never depends on a runner being present.
  await cleanupTaskFull(h.slayDb, tid)
  h.cleanup()
})
