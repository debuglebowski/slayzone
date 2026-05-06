/**
 * agent-turns db unit tests (worktree-scoped, v119+)
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/agent-turns/src/server/db.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import {
  insertTurn,
  deleteTurn,
  getTurn,
  getLatestTurnForWorktree,
  listTurnsForWorktree,
  findTurnsToPrune,
} from './db.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
const otherTaskId = crypto.randomUUID()
const wt = '/tmp/wt-A'
const otherWt = '/tmp/wt-B'

h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(taskId, projectId, 'T1')
h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(otherTaskId, projectId, 'T2')

function mk(over: Partial<Parameters<typeof insertTurn>[1]> = {}) {
  return {
    id: over.id ?? crypto.randomUUID(),
    worktree_path: over.worktree_path ?? wt,
    task_id: 'task_id' in over ? over.task_id! : taskId,
    terminal_tab_id: over.terminal_tab_id ?? 'tab-A',
    snapshot_sha: over.snapshot_sha ?? `sha-${Math.random().toString(36).slice(2, 10)}`,
    prompt_preview: over.prompt_preview ?? 'hello',
    created_at: over.created_at ?? Date.now(),
  }
}

await describe('insertTurn / getTurn', () => {
  test('inserts row with worktree_path and nullable task_id', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    const t = mk()
    insertTurn(h.db, t)
    const row = getTurn(h.db, t.id)
    expect(row !== null).toBe(true)
    expect(row!.worktree_path).toBe(wt)
    expect(row!.task_id).toBe(taskId)
  })

  test('task_id can be null', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    const t = mk({ task_id: null })
    insertTurn(h.db, t)
    expect(getTurn(h.db, t.id)!.task_id).toBeNull()
  })
})

await describe('deleteTurn', () => {
  test('removes row', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    const t = mk()
    insertTurn(h.db, t)
    deleteTurn(h.db, t.id)
    expect(getTurn(h.db, t.id)).toBeNull()
  })
})

await describe('getLatestTurnForWorktree', () => {
  test('null when no rows', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    expect(getLatestTurnForWorktree(h.db, wt)).toBeNull()
  })

  test('returns most recent by created_at, scoped to worktree', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    insertTurn(h.db, mk({ created_at: 100, snapshot_sha: 'a' }))
    insertTurn(h.db, mk({ created_at: 200, snapshot_sha: 'b' }))
    insertTurn(h.db, mk({ worktree_path: otherWt, created_at: 999, snapshot_sha: 'other-newer' }))
    expect(getLatestTurnForWorktree(h.db, wt)!.snapshot_sha).toBe('b')
    expect(getLatestTurnForWorktree(h.db, otherWt)!.snapshot_sha).toBe('other-newer')
  })
})

await describe('listTurnsForWorktree — paired with prev_snapshot_sha', () => {
  test('rows oldest first w/ prev computed', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    insertTurn(h.db, mk({ created_at: 100, snapshot_sha: 's1' }))
    insertTurn(h.db, mk({ created_at: 200, snapshot_sha: 's2' }))
    insertTurn(h.db, mk({ created_at: 300, snapshot_sha: 's3' }))
    const list = listTurnsForWorktree(h.db, wt)
    expect(list).toHaveLength(3)
    expect(list[0].prev_snapshot_sha).toBeNull()
    expect(list[1].prev_snapshot_sha).toBe('s1')
    expect(list[2].prev_snapshot_sha).toBe('s2')
  })

  test('mixes turns from different tasks but same worktree', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    insertTurn(h.db, mk({ task_id: taskId, created_at: 100 }))
    insertTurn(h.db, mk({ task_id: otherTaskId, created_at: 200 }))
    const list = listTurnsForWorktree(h.db, wt)
    expect(list).toHaveLength(2)
    expect(list[0].task_id).toBe(taskId)
    expect(list[1].task_id).toBe(otherTaskId)
  })

  test('joins task_title for tooltip; null for orphan/no-task rows', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    insertTurn(h.db, mk({ task_id: taskId, created_at: 1 }))
    insertTurn(h.db, mk({ task_id: otherTaskId, created_at: 2 }))
    insertTurn(h.db, mk({ task_id: null, created_at: 3 }))
    const list = listTurnsForWorktree(h.db, wt)
    expect(list[0].task_title).toBe('T1')
    expect(list[1].task_title).toBe('T2')
    expect(list[2].task_title).toBeNull()
  })
})

await describe('findTurnsToPrune — per worktree', () => {
  test('returns oldest excess only for the queried worktree', () => {
    h.db.prepare('DELETE FROM agent_turns').run()
    const aIds: string[] = []
    for (let i = 0; i < 53; i++) {
      const t = mk({ created_at: i })
      insertTurn(h.db, t)
      aIds.push(t.id)
    }
    // Other worktree shouldn't pollute count
    for (let i = 0; i < 60; i++) {
      insertTurn(h.db, mk({ worktree_path: otherWt, created_at: i }))
    }
    const stale = findTurnsToPrune(h.db, wt)
    expect(stale).toHaveLength(3)
    expect(stale[0]).toBe(aIds[0])
  })
})

h.cleanup()
