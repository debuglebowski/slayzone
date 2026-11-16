import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { chatAvailabilityMessage, chatUnavailableDetail } from '@slayzone/terminal-contracts'
import { createChatAvailability } from './hub-availability'
import { applyComputerRetirements } from './hub-retirements'

/** What a chat on a removed computer reads (title-free text for older clients, and its code). */
const REMOVED = {
  state: 'unavailable',
  reason: chatUnavailableDetail('computer-removed'),
  reasonCode: 'computer-removed'
} as const

async function setup() {
  const h = await createTestHarness()
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
  )
  return { h, owners: createChatOwnershipStore(h.slayDb) }
}
test('availability follows the history owner after task reassignment, without reading computer content', async () => {
  const { h, owners } = await setup()
  try {
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'original',
      epoch: 1
    })
    let connected = false
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => {
        throw new Error('Must not relocate history')
      },
      connected: () => connected,
      hasLiveTask: async () => false
    })
    expect(await availability('tab')).toMatchObject({
      state: 'offline',
      computer: { id: 'original' }
    })
    connected = true
    expect(await availability('tab')).toMatchObject({
      state: 'ready',
      computer: { id: 'original' }
    })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 0 })
  } finally {
    h.cleanup()
  }
})
test('legacy migration explains a live-agent deferral and task pause', async () => {
  const { h, owners } = await setup()
  try {
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => 'pc',
      connected: () => true,
      hasLiveTask: async () => true
    })
    expect(await availability('tab')).toMatchObject({
      state: 'migrating',
      waitingForAgents: true,
      computer: { id: 'pc' }
    })
    h.db.prepare("UPDATE tasks SET deleted_at=datetime('now') WHERE id='t'").run()
    expect(await availability('tab')).toMatchObject({ state: 'paused' })
  } finally {
    h.cleanup()
  }
})
test('fresh unassigned tabs do not create storage or publish a guessed owner', async () => {
  const { h, owners } = await setup()
  try {
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => null,
      connected: () => false,
      hasLiveTask: async () => false
    })
    expect(await availability('tab')).toEqual({ state: 'unassigned', computer: null })
    expect(await owners.forTab('tab')).toBeNull()
  } finally {
    h.cleanup()
  }
})
test('authorization precedes reading the computer name or availability', async () => {
  const { h, owners } = await setup()
  try {
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'other-pc',
      epoch: 1
    })
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => null,
      connected: () => {
        throw new Error('Leaked computer state')
      },
      gate: async () => {
        throw new Error('Not your computer')
      },
      hasLiveTask: async () => false
    })
    await expect(availability('tab')).rejects.toThrow('Not your computer')
  } finally {
    h.cleanup()
  }
})

test('maintenance bridge exposes upgrade waiting instead of ready history and resumes afterward', async () => {
  const { h, owners } = await setup()
  try {
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    let ready = false
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => 'pc',
      connected: () => true,
      chatRuntimeReady: () => ready,
      hasLiveTask: async () => false
    })
    expect(await availability('tab')).toMatchObject({ state: 'upgrading', computer: { id: 'pc' } })
    ready = true
    expect(await availability('tab')).toMatchObject({ state: 'ready' })
  } finally {
    h.cleanup()
  }
})
test("a legacy chat's computer is its recorded one (backfilled), never read from the legacy table", async () => {
  const { h, owners } = await setup()
  try {
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    h.db.exec(
      "INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES ('ran-here','R','darwin','1','[]',1), ('stale','S','darwin','1','[]',1); INSERT INTO chat_legacy_tab_computers (tab_id, computer_id) VALUES ('tab','ran-here'); INSERT INTO chat_workspace_changes (id,tab_id,message_id,computer_id,root_path,status,created_at) VALUES ('w','tab','m','stale','/r','complete',1)"
    )
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => 'task-computer',
      connected: () => false,
      hasLiveTask: async () => false
    })
    expect((await availability('tab')).computer).toMatchObject({ id: 'ran-here' })
  } finally {
    h.cleanup()
  }
})
test.each([false, true])(
  'a chat whose computer was removed reads unavailable with the removal reason, never offline (retirement applied=%s)',
  async (applied) => {
    const { h, owners } = await setup()
    try {
      await owners.register({
        id: 'c',
        taskId: 't',
        tabId: 'tab',
        mode: 'claude-chat',
        computerId: 'gone',
        epoch: 1
      })
      h.db
        .prepare(
          "INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES('gone',NULL,'deleted',1)"
        )
        .run()
      if (applied) await applyComputerRetirements(h.slayDb)
      const availability = createChatAvailability({
        db: h.slayDb,
        ownership: owners,
        resolveComputer: async () => null,
        // A removed computer is never connected: that must not decide the answer.
        connected: () => false,
        hasLiveTask: async () => false
      })
      expect(await availability('tab')).toMatchObject({ ...REMOVED, computer: { id: 'gone' } })
    } finally {
      h.cleanup()
    }
  }
)
test('an offline owner whose chat another computer holds names that computer and the way out', async () => {
  const { h, owners } = await setup()
  try {
    h.db.exec(
      "INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('old-0000-id','ci-box','linux','1','{}',1),('new-1111-id','ci-box','linux','1','{}',2),('lap','laptop','linux','1','{}',3)"
    )
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'old-0000-id',
      epoch: 1
    })
    let holder: string | null = 'new-1111-id'
    const availability = createChatAvailability({
      db: h.slayDb,
      ownership: owners,
      resolveComputer: async () => null,
      connected: () => false,
      hasLiveTask: async () => false,
      heldBy: (conversationId, ownerId) =>
        conversationId === 'c' && ownerId === 'old-0000-id' ? holder : null
    })
    const status = await availability('tab')
    expect(status).toMatchObject({
      state: 'offline',
      computer: { id: 'old-0000-id', name: 'ci-box' },
      heldBy: { id: 'new-1111-id', name: 'ci-box' }
    })
    // Alike names: the message cannot tell them apart by name, so it says "another".
    expect(chatAvailabilityMessage(status)).toEqual({
      title: 'ci-box is offline',
      detail:
        'Another computer named ci-box holds this chat, possibly this one enrolled again. If so, replace the offline ci-box with it in Settings → Connections.'
    })
    holder = 'lap'
    expect(chatAvailabilityMessage(await availability('tab'))?.detail).toBe(
      'laptop holds this chat. If laptop is ci-box enrolled again, replace ci-box with it in Settings → Connections.'
    )
    holder = null
    expect(await availability('tab')).not.toHaveProperty('heldBy')
    // Removed for good: unavailable with the removal reason (it never connects again),
    // never "offline … replace it" — there is nothing left to replace.
    holder = 'new-1111-id'
    h.db.exec(
      "INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES('old-0000-id',NULL,'deleted',1)"
    )
    const removed = await availability('tab')
    expect(removed).toMatchObject(REMOVED)
    expect(removed).not.toHaveProperty('heldBy')
  } finally {
    h.cleanup()
  }
})

/** Availability of the one tab, its computers named by `connected`. */
function availabilityOf(
  h: Awaited<ReturnType<typeof setup>>['h'],
  owners: Awaited<ReturnType<typeof setup>>['owners'],
  o: {
    connected?: readonly string[]
    resolve?: string | null
    gate?: (computerId: string) => Promise<void>
  } = {}
) {
  return createChatAvailability({
    db: h.slayDb,
    ownership: owners,
    resolveComputer: async () => o.resolve ?? null,
    connected: (id) => (o.connected ?? []).includes(id),
    hasLiveTask: async () => false,
    ...(o.gate ? { gate: (id: string) => o.gate!(id) } : {})
  })
}
const retire = (
  h: Awaited<ReturnType<typeof setup>>['h'],
  rows: Array<[string, string | null, string]>
) => {
  for (const [id, successor, reason] of rows)
    h.db
      .prepare(
        'INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES(?,?,?,1)'
      )
      .run(id, successor, reason)
}
const chatOn = (owners: Awaited<ReturnType<typeof setup>>['owners'], computerId: string | null) =>
  owners.register({ id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', computerId, epoch: 1 })

test('A: a chat on a computer re-enrolled, then deleted (a chain), reads removed, never offline', async () => {
  const { h, owners } = await setup()
  try {
    await chatOn(owners, 'a')
    // a was re-enrolled as b, b then deleted; the hub has applied neither yet.
    retire(h, [
      ['a', 'b', 're-enrolled'],
      ['b', null, 'deleted']
    ])
    expect(await availabilityOf(h, owners)('tab')).toMatchObject({
      ...REMOVED,
      computer: { id: 'a' }
    })
  } finally {
    h.cleanup()
  }
})

test('A: a chat on a re-enrolled computer reads as its successor before the hub repoints it', async () => {
  const { h, owners } = await setup()
  try {
    await chatOn(owners, 'a')
    retire(h, [['a', 'b', 're-enrolled']])
    expect(await availabilityOf(h, owners, { connected: ['b'] })('tab')).toMatchObject({
      state: 'ready',
      computer: { id: 'b' }
    })
  } finally {
    h.cleanup()
  }
})

test.each(['legacy', 'copying'] as const)(
  'A: a %s chat bound for a removed computer reads as after its retirement: bound for none, placed again',
  async (state) => {
    const { h, owners } = await setup()
    try {
      await chatOn(owners, null)
      h.db
        .prepare(
          `UPDATE chat_ownership SET state=?, destination_computer_id='gone',
            migration_id=CASE WHEN ?='copying' THEN 'm' END WHERE id='c'`
        )
        .run(state, state)
      retire(h, [['gone', null, 'deleted']])
      const status = await availabilityOf(h, owners, { connected: ['pc'], resolve: 'pc' })('tab')
      expect(status).toMatchObject({ computer: { id: 'pc' } })
      expect(status.state).not.toBe('offline')
    } finally {
      h.cleanup()
    }
  }
)

test('A: an active chat is on its own computer, whatever destination a past move left', async () => {
  const { h, owners } = await setup()
  try {
    await chatOn(owners, 'pc')
    h.db.prepare("UPDATE chat_ownership SET destination_computer_id='gone' WHERE id='c'").run()
    retire(h, [['gone', null, 'deleted']])
    expect(await availabilityOf(h, owners, { connected: ['pc'] })('tab')).toMatchObject({
      state: 'ready',
      computer: { id: 'pc' }
    })
  } finally {
    h.cleanup()
  }
})

test("A: a removed computer is not asked to authorize (it is no one's): the removal is the answer", async () => {
  const { h, owners } = await setup()
  try {
    await chatOn(owners, 'gone')
    retire(h, [['gone', null, 'deleted']])
    const gate = async (id: string) => {
      // As placement's gate: a computer with no row is no one's.
      if (id === 'gone') throw new Error('no such computer, or it is not yours')
    }
    expect(await availabilityOf(h, owners, { gate })('tab')).toMatchObject(REMOVED)
  } finally {
    h.cleanup()
  }
})

test('A: a chat its live computer did not return carries that reason too', async () => {
  const { h, owners } = await setup()
  try {
    await chatOn(owners, 'pc')
    await owners.markUnavailable('c', 'pc', 1)
    expect(await availabilityOf(h, owners, { connected: ['pc'] })('tab')).toMatchObject({
      state: 'unavailable',
      reasonCode: 'not-returned',
      reason: chatUnavailableDetail('not-returned')
    })
  } finally {
    h.cleanup()
  }
})
