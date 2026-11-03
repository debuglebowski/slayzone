import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { legacySessionAuthority } from './legacy-session-authority'

test.each([false, true])(
  'legacy same-provider sessions require unambiguous computer provenance, recordedSession=%s',
  async (recordedSession) => {
    const h = await createTestHarness()
    try {
      h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
      h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
      for (const tab of ['a', 'b'])
        h.db
          .prepare(
            "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,'task','claude-chat',0)"
          )
          .run(tab)
      if (recordedSession)
        h.db.prepare("INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES('a',0,?,1)").run(
          JSON.stringify({
            kind: 'turn-init',
            sessionId: 'session',
            model: 'model',
            cwd: '/tmp',
            tools: []
          })
        )
      const owners = createChatOwnershipStore(h.slayDb)
      await owners.register({
        id: 'a',
        taskId: 'task',
        tabId: 'a',
        mode: 'claude-chat',
        computerId: 'pc1',
        epoch: 1
      })
      await owners.register({
        id: 'b',
        taskId: 'task',
        tabId: 'b',
        mode: 'claude-chat',
        computerId: 'pc2',
        epoch: 1
      })
      expect(await legacySessionAuthority(h.slayDb, 'task', 'claude-code', 'session')).toBe(
        recordedSession ? 'a' : null
      )
      if (recordedSession) {
        await owners.bindProvider('a', 'session', 'claude-code')
        await expect(owners.bindProvider('b', 'session', 'claude-code')).rejects.toThrow(
          /another storage owner/i
        )
      }
      expect(await legacySessionAuthority(h.slayDb, 'task', 'claude-chat', 'session')).toBe(
        recordedSession ? 'a' : null
      )
    } finally {
      h.cleanup()
    }
  }
)
