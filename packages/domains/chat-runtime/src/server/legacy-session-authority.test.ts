import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { legacySessionAmbiguous, legacySessionAuthority } from './legacy-session-authority'

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
      expect(await legacySessionAuthority(h.slayDb, 'task', 'claude-chat', 'session')).toBe(
        recordedSession ? 'a' : null
      )
    } finally {
      h.cleanup()
    }
  }
)

// #172: no competing chat owner = unclaimed, not ambiguous.
test('a session no chat owner competes for stays unclaimed and clears a stale NULL', async () => {
  const h = await createTestHarness()
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    // Storage-only owner: no terminal tab, never a provider-session candidate.
    await createChatOwnershipStore(h.slayDb).register({
      id: 'content',
      taskId: 'task',
      tabId: 'task-content:task',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const rows = () =>
      h.db.prepare('SELECT conversation_id FROM chat_legacy_session_authority').all()
    expect(await legacySessionAuthority(h.slayDb, 'task', 'claude-code', 'session')).toBeNull()
    expect(rows()).toEqual([])
    h.db
      .prepare(
        "INSERT INTO chat_legacy_session_authority VALUES('task','claude-code','session',NULL)"
      )
      .run()
    expect(await legacySessionAmbiguous(h.slayDb, 'task', 'claude-code', 'session')).toBe(false)
    expect(rows()).toEqual([])
  } finally {
    h.cleanup()
  }
})

// Where a hub-era tab's agent ran is v196's record (chat_legacy_tab_computers), not
// the legacy chat_workspace_changes rows it was copied from — those are to be
// dropped. Reading them, the election lost every tab's computer once they go.
test("a hub-era tab's computer comes from v196's record, not the legacy table", async () => {
  const h = await createTestHarness()
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    const owners = createChatOwnershipStore(h.slayDb)
    for (const tab of ['a', 'b']) {
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES(?,'task','claude-chat',0,?)"
        )
        .run(tab, tab === 'a' ? '2026-01-01' : '2026-01-02')
      // Hub-era: no computer on the owner; only v196 says where it ran.
      h.db
        .prepare("INSERT INTO chat_legacy_tab_computers(tab_id,computer_id) VALUES(?, 'pc1')")
        .run(tab)
      await owners.register({
        id: tab,
        taskId: 'task',
        tabId: tab,
        mode: 'claude-chat',
        computerId: null,
        epoch: 1
      })
    }
    // Both ran on pc1: unambiguous, the older tab is elected.
    expect(await legacySessionAuthority(h.slayDb, 'task', 'claude-chat', 'session')).toBe('a')
  } finally {
    h.cleanup()
  }
})
