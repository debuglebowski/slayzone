import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatAvailability } from './hub-availability'

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
