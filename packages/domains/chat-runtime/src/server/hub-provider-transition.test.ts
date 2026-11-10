import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createHubProviderTransitions } from './hub-provider-transition'

test('a reserved provider switch that ownership moved past is superseded, and the tab can switch again', async () => {
  const h = await createTestHarness()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
      INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
      INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','codex-chat',0)`)
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 3
    })
    // Reserved at epoch 1; a later migration committed epoch 3 since.
    h.db.exec(
      "INSERT INTO chat_provider_transitions VALUES('stale','c','t','tab','arch','next','codex-chat','pc',1,'reserved')"
    )
    const superseded: string[] = []
    const requests: unknown[] = []
    const transitions = createHubProviderTransitions({
      db: h.slayDb,
      ownership,
      onSuperseded: (info) => superseded.push(info.id),
      request: async (_pc, raw) => {
        requests.push(raw)
        return (raw as { value: { to: unknown } }).value.to
      }
    })
    await transitions.resume('pc')
    expect(superseded).toEqual(['stale'])
    expect(
      h.db.prepare("SELECT state FROM chat_provider_transitions WHERE id='stale'").get()
    ).toEqual({ state: 'superseded' })
    // A fresh switch from the current ownership goes through.
    await transitions.ensure((await ownership.get('c'))!, 'codex-chat')
    expect(requests).toHaveLength(1)
    expect(await ownership.forTab('tab')).toMatchObject({ mode: 'codex-chat' })
    expect(await ownership.get('c')).toMatchObject({ epoch: 4, state: 'active' })
  } finally {
    warn.mockRestore()
    h.cleanup()
  }
})
