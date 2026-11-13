/**
 * Consistency rules of a task's folders (robustness plan §9, P0, 7e v211): the hub
 * holds no path, only whether one is set and which computer holds it.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkComputerChatConsistency, checkHubChatConsistency } from './hub-consistency'

test('a folder no computer holds, and none on its way, is reported', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title,has_worktree,worktree_computer_id)
        VALUES('held','p','H',1,'pc'),('staged','p','S',1,NULL),('lost','p','L',0,NULL);
      INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
        VALUES('task-path','staged','staged','{}',0)`)
    const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule)
    expect(await rules()).toEqual([])
    h.db.exec(`UPDATE tasks SET has_base_dir=1 WHERE id='lost'`)
    expect(await rules()).toEqual(['task-folder-without-holder'])
  } finally {
    h.cleanup()
  }
})

test('the hub flags and the holding computer agree, unless a change is staged', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title,has_worktree,has_base_dir,worktree_computer_id)
        VALUES('a','p','A',1,0,'pc'),('b','p','B',0,1,'pc')`)
    const held: Record<string, { worktreePath: string | null; baseDir: string | null }> = {
      a: { worktreePath: '/w/a', baseDir: null },
      b: { worktreePath: null, baseDir: '/b' }
    }
    const request = async (_computerId: string, req: unknown) => {
      const r = req as { kind: string; value?: { op?: string; taskIds?: string[] } }
      if (r.kind === 'taskPaths' && r.value?.op === 'get')
        return (r.value.taskIds ?? [])
          .filter((id) => held[id])
          .map((id) => ({ taskId: id, ...held[id] }))
      if (r.kind === 'task.lifecycles') return []
      if (r.kind === 'turns') return []
      return null
    }
    const drift = async () =>
      (await checkComputerChatConsistency(h.slayDb, request as never, 'pc'))
        .filter((v) => v.rule === 'task-path-flag-drift')
        .flatMap((v) => v.ids)
    expect(await drift()).toEqual([])
    held.a = { worktreePath: null, baseDir: null }
    expect(await drift()).toEqual(['a'])
    // On its way: not drift.
    h.db.exec(`INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
      VALUES('task-path','a','a','{}',0)`)
    expect(await drift()).toEqual([])
  } finally {
    h.cleanup()
  }
})
