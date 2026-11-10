import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatRecovery } from './hub-recovery'

test('restored hub adopts committed computer ownership; conflicting active owner is fenced', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    await owners.register({
      id: 'stale',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    const inventory = [
      {
        identity: { id: 'actual', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
        state: 'active',
        migrationId: 'move',
        migrationHash: 'a'.repeat(64),
        bootstrapRevision: 8
      }
    ]
    const failures: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => inventory,
      onConversationFailure: (pc, id, error) => failures.push(`${pc}:${id}:${error.message}`)
    })
    await recovery.reconcile('pc')
    expect(await owners.forTab('tab')).toMatchObject({
      id: 'actual',
      computerId: 'pc',
      epoch: 2,
      cleanupPending: true,
      settingsRevision: 8
    })
    await recovery.reconcile('pc')
    expect(failures).toEqual([])
    // Another computer claiming the same tab is fenced for that conversation
    // only: the pass completes and the committed owner stays.
    await recovery.reconcile('other')
    expect(failures).toEqual([expect.stringMatching(/^other:actual:.*(conflict|another)/i)])
    expect(await owners.forTab('tab')).toMatchObject({ computerId: 'pc' })
    errors.mockRestore()
  } finally {
    h.cleanup()
  }
})

test('computer deletion survives restoring a hub snapshot with active task metadata', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
    )
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [
        {
          identity: {
            id: 'task-tombstone:t',
            taskId: 't',
            tabId: 'task-tombstone:t',
            mode: 'claude-chat',
            epoch: 2
          },
          state: 'deleted',
          migrationId: null,
          migrationHash: null,
          bootstrapRevision: 0
        }
      ]
    })
    await recovery.reconcile('pc')
    expect(h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='t'").get()).toEqual({
      state: 'deleted'
    })
  } finally {
    h.cleanup()
  }
})

test('computer inventory cannot apply lifecycle or deletion before task authorization', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
    )
    for (const entry of [
      { id: 'task-tombstone:t', tabId: 'task-tombstone:t', state: 'deleted' },
      {
        id: 'conversation',
        tabId: 'tab',
        state: 'active',
        lifecycle: { state: 'deleted', revision: 99 }
      }
    ]) {
      const failures: string[] = []
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const recovery = createChatRecovery({
        db: h.slayDb,
        onConversationFailure: (_pc, id, error) => failures.push(`${id}:${error.message}`),
        gate: async () => {
          throw new Error('Not your task')
        },
        request: async () => [
          {
            ...entry,
            identity: {
              id: entry.id,
              taskId: 't',
              tabId: entry.tabId,
              mode: 'claude-chat',
              epoch: 2
            },
            migrationId: null,
            migrationHash: null,
            bootstrapRevision: 0
          }
        ]
      })
      // Refused for that entry alone; nothing of it is applied.
      await recovery.reconcile('unrelated-pc')
      expect(failures).toEqual([`${entry.id}:Not your task`])
      errors.mockRestore()
      expect(h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='t'").get()).toEqual(
        { state: 'active' }
      )
      expect(h.db.prepare('SELECT count(*) AS n FROM chat_task_computers').get()).toEqual({ n: 0 })
    }
  } finally {
    h.cleanup()
  }
})

test('prompt-only phantom repair preserves a tab the user converted to a native terminal', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES('prompt-history:t','t','Chat','claude-code',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    const identity = {
      id: 'prompt-store',
      taskId: 't',
      tabId: 'prompt-history:t',
      mode: 'claude-chat',
      epoch: 1
    }
    await owners.register({ ...identity, computerId: 'pc' })
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [
        {
          identity,
          state: 'active',
          migrationId: null,
          migrationHash: null,
          bootstrapRevision: 1,
          hasConversationContent: false
        }
      ]
    })
    await recovery.reconcile('pc')
    expect(
      h.db.prepare("SELECT id,mode FROM terminal_tabs WHERE id='prompt-history:t'").get()
    ).toEqual({ id: 'prompt-history:t', mode: 'claude-code' })
    expect(await owners.forTab('prompt-history:t')).toMatchObject({
      id: 'prompt-store',
      state: 'active'
    })
  } finally {
    h.cleanup()
  }
})

test.each(['empty', 'draft', 'native'] as const)(
  'task-content recovery repairs an unbound generated prompt alias without removing %s history',
  async (content) => {
    const h = await createTestHarness()
    try {
      h.db.exec(
        "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
      )
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES('prompt-history:t','t','Chat',?,0)"
        )
        .run(content === 'native' ? 'claude-code' : 'claude-chat')
      if (content === 'draft')
        h.db
          .prepare(
            "INSERT INTO chat_tab_state(tab_id,draft_text,draft_attachments,rev,updated_at) VALUES('prompt-history:t','retained legacy draft','[]',1,1)"
          )
          .run()
      const identity = {
        id: 'task-content-owner',
        taskId: 't',
        tabId: 'task-content:t',
        mode: 'claude-chat',
        epoch: 2
      }
      const owners = createChatOwnershipStore(h.slayDb)
      await owners.register({ ...identity, computerId: 'pc' })
      const recovery = createChatRecovery({
        db: h.slayDb,
        request: async () => [
          {
            identity,
            state: 'active',
            migrationId: 'move',
            migrationHash: 'a'.repeat(64),
            bootstrapRevision: 1,
            hasConversationContent: false,
            inbox: true
          }
        ]
      })
      await recovery.reconcile('pc')
      const tab = h.db.prepare("SELECT id FROM terminal_tabs WHERE id='prompt-history:t'").get()
      if (content === 'empty') {
        expect(tab).toBeUndefined()
        expect(await owners.forTab('prompt-history:t')).toBeNull()
      } else {
        expect(tab).toEqual({ id: 'prompt-history:t' })
        expect(await owners.forTab('prompt-history:t')).toBeNull()
      }
      if (content === 'draft')
        expect(
          h.db
            .prepare("SELECT draft_text FROM chat_tab_state WHERE tab_id='prompt-history:t'")
            .get()
        ).toEqual({ draft_text: 'retained legacy draft' })
    } finally {
      h.cleanup()
    }
  }
)

/** One task 't' with a chat tab 'tab' whose live chat 'live' is held by computer 'pc'. */
async function liveChatFixture() {
  const h = await createTestHarness()
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
  )
  const owners = createChatOwnershipStore(h.slayDb)
  await owners.register({
    id: 'live',
    taskId: 't',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  const deleted = (id: string, epoch = 1, migrationId: string | null = null) => ({
    identity: { id, taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch },
    state: 'deleted' as const,
    migrationId,
    migrationHash: null,
    bootstrapRevision: 0
  })
  return { h, owners, deleted }
}

test('a deletion report for a chat the hub does not know never deletes the live chat of its tab', async () => {
  // Provider switched away and back: the tab's old conversation was deleted on
  // the computer, then forgotten by the hub. Its tombstone still names the tab.
  const { h, owners, deleted } = await liveChatFixture()
  try {
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [deleted('old', 3)]
    })
    await recovery.reconcile('pc')
    await recovery.reconcile('pc')
    expect(await owners.forTab('tab')).toMatchObject({ id: 'live', state: 'active' })
    // The tombstone is kept on its own, bound to no tab.
    expect(await owners.get('old')).toMatchObject({ state: 'deleted', cleanupPending: false })
  } finally {
    h.cleanup()
  }
})

test('a computer that does not hold a chat cannot delete it', async () => {
  const { h, owners, deleted } = await liveChatFixture()
  try {
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [deleted('live', 1)]
    })
    await recovery.reconcile('stale-pc')
    expect(await owners.forTab('tab')).toMatchObject({ id: 'live', state: 'active' })
    // Its holder's deletion applies.
    await recovery.reconcile('pc')
    expect(await owners.get('live')).toMatchObject({ state: 'deleted' })
  } finally {
    h.cleanup()
  }
})

test('a stale migration locator is replaced by the deletion of its migrated copy', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    await owners.register({
      id: 'locator',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    await owners.beginMigration('locator', {
      expectedComputerId: null,
      expectedEpoch: 1,
      migrationId: 'move',
      destinationComputerId: 'pc'
    })
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [
        {
          identity: { id: 'copy', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
          state: 'deleted',
          migrationId: 'move',
          migrationHash: null,
          bootstrapRevision: 0
        }
      ]
    })
    await recovery.reconcile('pc')
    expect(await owners.get('locator')).toMatchObject({ state: 'deleted' })
  } finally {
    h.cleanup()
  }
})

test('a chat the hub deleted is queued for deletion on a computer that still holds it', async () => {
  const { h, owners } = await liveChatFixture()
  try {
    await owners.deleteConversation('live')
    await owners.acknowledgeDeletion('live', 'pc', 2)
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [
        {
          identity: { id: 'live', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
          state: 'active',
          migrationId: null,
          migrationHash: null,
          bootstrapRevision: 0
        }
      ]
    })
    await recovery.reconcile('other-pc')
    expect(await owners.pendingDeletions('other-pc')).toEqual([
      { conversationId: 'live', epoch: 2 }
    ])
  } finally {
    h.cleanup()
  }
})
