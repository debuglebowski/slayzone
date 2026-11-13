/**
 * Chat settings live only on the chat's computer (robustness plan §9, decision 2):
 * a hub copy of them for a chat a computer owns is drift. Starting values of a chat
 * no computer holds yet (legacy, storage-only owners) are not.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkHubChatConsistency } from './hub-consistency'

test('hub-chat-settings-for-owned-chat flags only computer-owned chats', async () => {
  const h = await createTestHarness()
  try {
    const config = (entry: Record<string, unknown>) =>
      JSON.stringify({ 'claude-chat': entry, 'claude-code': { flags: '' } })
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000')`)
    const task = h.db.prepare(
      'INSERT INTO tasks(id,project_id,title,provider_config) VALUES(?,?,?,?)'
    )
    task.run('owned', 'p', 'Owned', config({ flags: '--f' }))
    task.run('legacy', 'p', 'Legacy', config({ chatModel: 'seed' }))
    task.run('store', 'p', 'Store', config({ chatModel: 'seed' }))
    const owner = h.db.prepare(
      'INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state) VALUES(?,?,?,?,?,1,?)'
    )
    owner.run('o1', 'owned', 'owned', 'claude-chat', 'pc', 'active')
    owner.run('o2', 'legacy', 'legacy', 'claude-chat', null, 'legacy')
    owner.run('o3', 'store', 'task-content:store', 'claude-chat', 'pc', 'active')
    const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule)
    expect(await rules()).toEqual([])

    for (const key of ['chatModel', 'chatConversationId', 'chatFastMode']) {
      h.db
        .prepare('UPDATE tasks SET provider_config=? WHERE id=?')
        .run(config({ flags: '--f', [key]: key === 'chatFastMode' ? false : 'x' }), 'owned')
      const found = await checkHubChatConsistency(h.slayDb)
      expect(found.map((v) => [v.rule, v.ids])).toEqual([
        ['hub-chat-settings-for-owned-chat', ['owned:claude-chat']]
      ])
    }
  } finally {
    h.cleanup()
  }
})
