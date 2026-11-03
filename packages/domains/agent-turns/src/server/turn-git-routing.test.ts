/**
 * Turn snapshots live in the checkout, so their git runs on the computer that holds
 * it: the list's realpath + filter, and the boundary's snapshot/dedupe/prune. The
 * hub keeps only the rows. Works on a hub with processes switched off, as every
 * routed exec; with no computer the old hub-local path (and its refusal) stands.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { listAgentTurnsForWorktree } from './list-turns'
import { recordTurnBoundary } from './turn-tracker'
import { setTurnGitRouting } from './turn-git-routing'

const h = await createTestHarness()
const db = h.slayDb
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p1', 'P', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
  .run('t1', 'p1', 'T', '/remote/wt')
h.db
  .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
  .run('tab1', 't1', 'claude-code', 0)

const sent: Array<{ computerId: string; op: string; input: Record<string, unknown> }> = []
function route(answers: Record<string, unknown>): void {
  setTurnGitRouting({
    computerForPath: async () => 'c1',
    computerForTask: async () => 'c1',
    request: async (computerId, op, input) => {
      sent.push({ computerId, op, input: input as Record<string, unknown> })
      return answers[op] ?? null
    }
  })
}

afterEach(() => {
  sent.length = 0
  setTurnGitRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

describe('turns on the computer', () => {
  test('list: canonical + filter run there, the rows come from the hub', async () => {
    h.db
      .prepare(
        `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
         VALUES ('r1', '/remote/wt', 't1', 'tab1', 'aaa', 'bbb', 'hi', 1)`
      )
      .run()
    route({ canonical: '/remote/wt', filterTurns: [{ id: 'r1' }] })
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const out = await listAgentTurnsForWorktree(db, '/remote/wt')
    expect(out).toEqual([{ id: 'r1' }])
    expect(sent.map((s) => s.op)).toEqual(['canonical', 'filterTurns'])
    const rows = sent[1]?.input.rows as Array<{ id: string }> | undefined
    expect(rows?.map((r) => r.id)).toEqual(['r1'])
  })

  test('record: the snapshot is taken there and its row stored here', async () => {
    route({
      canonical: '/remote/wt',
      snapshot: { snapshotSha: 'ccc', headSha: 'ddd' },
      diffIsEmpty: false
    })
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await recordTurnBoundary(db, 'tab1', 'do it')
    expect(sent.map((s) => s.op).slice(0, 2)).toEqual(['canonical', 'snapshot'])
    const row = h.db
      .prepare(`SELECT snapshot_sha FROM agent_turns WHERE snapshot_sha = 'ccc'`)
      .get() as { snapshot_sha: string } | undefined
    expect(row?.snapshot_sha).toBe('ccc')
  })

  test('record with no computer on a processes-off hub: skipped quietly', async () => {
    setTurnGitRouting({
      computerForPath: async () => null,
      computerForTask: async () => null,
      request: async () => {
        throw new Error('must not be asked')
      }
    })
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    await expect(recordTurnBoundary(db, 'tab1', 'x')).resolves.toBeUndefined()
  })
})
