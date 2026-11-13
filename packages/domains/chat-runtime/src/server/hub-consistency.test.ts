import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkHubChatConsistency } from './hub-consistency'
import { applyComputerRetirements } from './hub-retirements'

/** Each planted drift is reported by its rule; the repaired state reports none. */
test('ownership drift rules: retired computers, stale provider switches, orphaned placeholders', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
      INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state)
        VALUES('a','t','tab-a','claude-chat','gone',1,'active'),('b','t','tab-b','claude-chat','old',3,'active');
      INSERT INTO computer_retirements VALUES('gone',NULL,'deleted',0),('old','new','re-enrolled',0);
      INSERT INTO chat_deletion_targets VALUES('a','gone',1,0);
      INSERT INTO chat_provider_transitions VALUES('x','b','t','tab-b','arch','next','codex-chat','old',1,'reserved');
      INSERT INTO artifact_folders(id,task_id,name) VALUES('f','t','Chat files');
      INSERT INTO chat_folder_placeholders VALUES('f','t');`)
    const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule).sort()
    expect(await rules()).toEqual([
      'folder-placeholder-without-wait',
      'provider-transition-reserved-stale',
      'reenrolled-computer-still-named',
      'removed-computer-chat-not-unavailable',
      'retired-computer-pending-work'
    ])
    await applyComputerRetirements(h.slayDb)
    h.db.exec("DELETE FROM chat_folder_placeholders WHERE folder_id='f'")
    // Repointed to 'new' at epoch 3: the epoch-1 reservation is still stale
    // (superseded when its computer recovers); everything else is repaired.
    expect(await rules()).toEqual(['provider-transition-reserved-stale'])
  } finally {
    h.cleanup()
  }
})
