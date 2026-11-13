/**
 * Consistency rules for agent sessions (robustness plan §2 per-tab scope, §9 the
 * ledger lives on the computer): each planted drift is reported by its rule; a
 * well-formed store reports none.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkHubChatConsistency } from './hub-consistency'

test('session rules: a reset of another task’s tab, a session id held on the hub, an orphaned intent ack', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title,provider_config)
        VALUES('t1','p','One','{"claude-code":{"flags":"--x"}}'),('t2','p','Two','{}');
      INSERT INTO terminal_tabs(id,task_id,mode,is_main,created_at)
        VALUES('t1','t1','claude-code',1,'x'),('t2','t2','claude-code',1,'x'),('t2-deploy','t2','claude-code',0,'x');
      INSERT INTO session_resets(id,task_id,mode,tab_id,created_at) VALUES('ok','t1','*',NULL,1);
      INSERT INTO session_intent_acks(intent_id,task_id,computer_id) VALUES('ok','t1','pc')`)
    const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule).sort()
    expect(await rules()).toEqual([])

    h.db.exec(`INSERT INTO session_resets(id,task_id,mode,tab_id,created_at) VALUES('r','t1','claude-code','t2-deploy',4);
      UPDATE tasks SET provider_config='{"codex":{"conversationId":"leaked"}}' WHERE id='t2';
      INSERT INTO session_intent_acks(intent_id,task_id,computer_id) VALUES('gone','t1','pc')`)
    expect(await rules()).toEqual([
      'hub-session-id-held',
      'reset-tab-task-mismatch',
      'session-intent-ack-orphaned'
    ])
  } finally {
    h.cleanup()
  }
})
