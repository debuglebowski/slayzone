/**
 * Consistency rules for computer-only data still waiting on the hub (robustness plan
 * §9, v204): each planted drift is reported by its rule; well-formed rows report none.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkHubChatConsistency } from './hub-consistency'

test('handoff drift rules: erased task, missing task, a re-enrolled computer still named', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title,computer_id) VALUES('t1','p','One','pc'),('t2','p','Two',NULL);
      INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
        VALUES('k','a','t1','{}',0),('k','b','t2','{}',0)`)
    const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule).sort()
    expect(await rules()).toEqual([])

    // Rows that outlived their task's erasure (the sweep missed them).
    h.db.exec(`INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
        VALUES('k','c','erased','{}',0);
      INSERT INTO content_erasure_jobs(id,scope,manifest,db_erased) VALUES('j','{}','{}',1);
      INSERT INTO content_erasure_tasks(task_id,job_id) VALUES('erased','j');
      INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
        VALUES('k','d','purged','{}',0);
      INSERT INTO computer_retirements VALUES('pc','pc-new','re-enrolled',0);`)
    expect(await rules()).toEqual([
      'handoff-for-erased-task',
      'handoff-for-missing-task',
      'handoff-target-retired'
    ])
  } finally {
    h.cleanup()
  }
})
