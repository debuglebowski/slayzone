/**
 * Turns live in the checkout's computer (robustness plan §9, P0; hub v207): the
 * boundary's snapshot/dedupe/prune and the row, the list's rows and filter. The hub
 * sends one `record` / `list` there and keeps only the task's "last interaction"
 * and the task titles it owns. Works on a hub with processes switched off, as every
 * routed exec; with no computer a boundary is skipped quietly.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { listAgentTurnsForTask } from './list-turns'
import { recordTurnBoundary } from './turn-tracker'
import { setTurnGitRouting, type TurnGitRouting } from './turn-git-routing'

const h = await createTestHarness()
const db = h.slayDb
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p1', 'P', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, has_worktree) VALUES (?, ?, ?, 1)')
  .run('t1', 'p1', 'Task one')
h.db
  .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
  .run('tab1', 't1', 'claude-code', 0)

const sent: Array<{ computerId: string; kind: string; input: unknown }> = []
function route(over: Partial<TurnGitRouting> = {}): void {
  setTurnGitRouting({
    computerForTask: async () => 'c1',
    request: async () => {
      throw new Error('the hub runs no turn git op itself')
    },
    record: async (computerId, input) => {
      sent.push({ computerId, kind: 'record', input })
      return { recorded: true, id: 'r9', worktreePath: '/real/wt', createdAt: 1234 }
    },
    list: async (computerId, input) => {
      sent.push({ computerId, kind: 'list', input })
      return {
        worktreePath: '/real/wt',
        rows: [
          {
            id: 'r1',
            worktree_path: '/real/wt',
            task_id: 't1',
            terminal_tab_id: 'tab1',
            snapshot_sha: 'a',
            head_sha_at_snap: 'b',
            prompt_preview: 'hi',
            created_at: 1,
            prev_snapshot_sha: null
          },
          {
            id: 'r2',
            worktree_path: '/real/wt',
            task_id: null,
            terminal_tab_id: 'gone',
            snapshot_sha: 'c',
            head_sha_at_snap: 'b',
            prompt_preview: '',
            created_at: 2,
            prev_snapshot_sha: 'a'
          }
        ]
      }
    },
    ...over
  })
}

afterEach(() => {
  sent.length = 0
  setTurnGitRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

describe('turns on the computer', () => {
  test('list: rows come from the computer, the hub adds task titles', async () => {
    route()
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    // §9 7d: the list names only the task; its computer resolves the checkout.
    const out = await listAgentTurnsForTask(db, 't1')
    expect(sent).toEqual([
      { computerId: 'c1', kind: 'list', input: { taskId: 't1', projectId: 'p1' } }
    ])
    expect(out.map((r) => [r.id, r.task_title])).toEqual([
      ['r1', 'Task one'],
      ['r2', null]
    ])
  })

  test('record: one request with the task, tab, project (the computer resolves the checkout, §9 7c) and clean preview; last interaction bumped', async () => {
    route()
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await recordTurnBoundary(db, 'tab1', '  do\n\nit  ')
    expect(sent).toEqual([
      {
        computerId: 'c1',
        kind: 'record',
        input: { taskId: 't1', tabId: 'tab1', projectId: 'p1', promptPreview: 'do it' }
      }
    ])
    expect(h.db.prepare('SELECT last_interaction_at FROM tasks WHERE id=?').get('t1')).toEqual({
      last_interaction_at: 1234
    })
  })

  test('raw terminal input is never a preview', async () => {
    route()
    await recordTurnBoundary(db, 'tab1', 'ls\x1b[A')
    expect((sent[0].input as { promptPreview: string }).promptPreview).toBe('')
  })

  test('a boundary that recorded nothing leaves last interaction alone', async () => {
    h.db.prepare('UPDATE tasks SET last_interaction_at = NULL WHERE id = ?').run('t1')
    route({ record: async () => ({ recorded: false }) })
    await recordTurnBoundary(db, 'tab1', 'x')
    expect(h.db.prepare('SELECT last_interaction_at FROM tasks WHERE id=?').get('t1')).toEqual({
      last_interaction_at: null
    })
  })

  test('record with no computer on a processes-off hub: skipped quietly', async () => {
    route({
      computerForTask: async () => null,
      record: async () => {
        throw new Error('must not be asked')
      }
    })
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await expect(recordTurnBoundary(db, 'tab1', 'x')).resolves.toBeUndefined()
  })
})
