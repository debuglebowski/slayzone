import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatOwnershipStore, type HubChatOwnership } from './hub-ownership'
import type { ChatComputerRequest } from './migration'
import { createHubChatRelay } from './hub-relay'

test.each([false, true])(
  'history reads initialize new storage once and avoid repeated setup, existing=%s',
  async (existing) => {
    const h = await createTestHarness()
    try {
      h.db.exec(
        "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      const ownership = createChatOwnershipStore(h.slayDb)
      if (existing)
        await ownership.register({
          id: 'store',
          taskId: 'task',
          tabId: 'tab',
          mode: 'claude-chat',
          computerId: 'pc',
          epoch: 1
        })
      const bootstrap = vi.fn(async (owner: HubChatOwnership) => ({
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        projectId: 'p',
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }))
      const replay = { events: [], live: { afterSeq: -1, liveSeq: 0, events: [] } }
      const request = vi.fn<ChatComputerRequest>(async (_pc, raw) => {
        const p = raw as { kind: string; value: { identity: unknown; method: string } }
        if (p.kind === 'bootstrap') return { ok: true, identity: p.value.identity }
        if (p.kind === 'pendingMetadata') return []
        if (p.kind === 'invoke') {
          if (p.value.method === 'getReplay') return replay
          if (p.value.method === 'openTimeline') return { kind: 'full' }
          if (p.value.method === 'getMode') return 'auto'
        }
        throw new Error('Unexpected request')
      })
      const gate = vi.fn(async () => {})
      const relay = createHubChatRelay({
        db: h.slayDb,
        ownership,
        bootstrap,
        request,
        gate,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        migrate: async () => {
          throw new Error('No legacy content to migrate')
        },
        onSessionsChanged: () => {}
      })
      await expect(relay.ops.getReplay('tab', -1)).resolves.toEqual(replay)
      await expect(relay.ops.openTimeline('tab', 'test-version')).resolves.toEqual({ kind: 'full' })
      // No spawn configuration or extra bootstrap RPC is needed to read saved history.
      expect(bootstrap).toHaveBeenCalledTimes(existing ? 0 : 1)
      expect(gate).toHaveBeenCalledWith('pc', 'task')
      const owner = await ownership.forTab('tab')
      expect(owner).toMatchObject({ state: 'active', computerId: 'pc', epoch: 1 })

      // Configuration reads retain their fresh bootstrap rather than using a stale cache.
      await expect(relay.ops.getMode('task', 'claude-chat')).resolves.toBe('auto')
      expect(bootstrap).toHaveBeenCalledTimes(existing ? 1 : 2)

      await ownership.deleteConversation(owner!.id)
      const beforeDeletedRead = request.mock.calls.length
      await expect(relay.ops.getReplay('tab', -1)).rejects.toThrow(/deleted/i)
      expect(request.mock.calls).toHaveLength(beforeDeletedRead)
    } finally {
      h.cleanup()
    }
  }
)

test('a recorded session only refreshes the sessions list; session, settings and queue metadata are refused (v208)', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb),
      record = vi.fn((_taskId: string) => {})
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      onSessionsChanged: record,
      request: async () => null,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('Recovery must not bootstrap')
      },
      migrate: async () => {
        throw new Error('Recovery must not migrate')
      }
    })
    // The computer's ledger recorded a session: a best-effort signal, nothing copied.
    await relay.receive('pc', {
      type: 'sessions-changed',
      conversationId: 'c',
      epoch: 1,
      tabId: 'tab'
    })
    expect(record).toHaveBeenLastCalledWith('task')
    // All at position 1: a refused update never advances the cursor.
    for (const kind of ['conversation', 'provider-config', 'queue-item'])
      await expect(
        relay.reconcileMetadata('pc', {
          conversationId: 'c',
          taskId: 'task',
          tabId: 'tab',
          epoch: 1,
          kind: kind as never,
          sequence: 1,
          operationId: kind,
          storeId: 'store',
          value: { id: 'q', mode: 'claude-chat', conversationId: 'native' }
        })
      ).rejects.toThrow(/Unknown chat metadata kind/)
    expect(record).toHaveBeenCalledTimes(1)
  } finally {
    h.cleanup()
  }
})

test('state relay validates identity and waits for attention consumers with computer user-input metadata', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb),
      calls: unknown[] = [],
      requests: unknown[] = []
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request: async (_pc, value) => {
        requests.push(value)
        const request = value as { kind: string }
        if (['sessions', 'pendingMetadata'].includes(request.kind)) return []
        return null
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => ({
        identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      migrate: async () => {
        throw new Error('Unexpected migration')
      },
      onSessionsChanged: () => {},
      onState: async (...args) => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        calls.push(args)
      }
    })
    const state = {
      type: 'state',
      conversationId: 'c',
      epoch: 1,
      tabId: 'tab',
      sessionId: 'task:tab',
      newState: 'idle',
      oldState: 'running',
      hasUserInput: true,
      providerSessionId: 'native'
    }
    await relay.receive('pc', state)
    expect(calls).toEqual([['task:tab', 'idle', 'running', true]])
    await expect(relay.receive('pc', { ...state, sessionId: 'foreign:tab' })).rejects.toThrow(
      /state notification/i
    )
    await expect(
      relay.receive('pc', { ...state, newState: 'private arbitrary text' })
    ).rejects.toThrow(/state notification/i)
    expect(calls).toHaveLength(1)
    expect(relay.conversations.isLive('task', 'native')).toBe(true)
    await relay.conversations.release('task', 'native')
    expect(requests).toContainEqual({
      kind: 'invoke',
      value: {
        route: { id: 'c', epoch: 1 },
        target: 'ops',
        method: 'releaseConversation',
        args: ['tab', 'native'],
        operationId: expect.any(String)
      }
    })
    expect(relay.conversations.isLive('task', 'native')).toBe(false)
  } finally {
    h.cleanup()
  }
})

test('folder locators recover when child metadata arrives before its parent', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const relay = createHubChatRelay({
      onSessionsChanged: () => {},
      db: h.slayDb,
      ownership,
      request: async () => null,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('Metadata must not bootstrap')
      },
      migrate: async () => {
        throw new Error('Metadata must not migrate')
      }
    })
    for (const [sequence, value] of [
      { id: 'child', parentId: 'parent', order: 2 },
      { id: 'parent', parentId: null, order: 1 }
    ].entries()) {
      await relay.reconcileMetadata('pc', {
        conversationId: 'c',
        taskId: 'task',
        tabId: 'tab',
        epoch: 1,
        operationId: `folder-${sequence}`,
        sequence: sequence + 1,
        storeId: 'store',
        kind: 'folder-changed',
        value
      })
    }
    expect(
      h.db.prepare('SELECT folder_id FROM chat_folder_locations ORDER BY folder_id').all()
    ).toEqual([{ folder_id: 'child' }, { folder_id: 'parent' }])
    expect(h.db.prepare('SELECT parent_id FROM artifact_folders WHERE id=?').get('child')).toEqual({
      parent_id: 'parent'
    })
  } finally {
    h.cleanup()
  }
})

test('hub forwards drafts to original owner; reassignment cannot move history', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(tmpdir(), 'chat-relay-'))
  const pc = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc-a' })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc-a',
      epoch: 1
    })
    const request = vi.fn(async (computerId: string, p: unknown): Promise<unknown> => {
      expect(computerId).toBe('pc-a')
      const raw = p as { kind: string; value: unknown; id: string; operationId: string }
      if (raw.kind === 'bootstrap') {
        pc.bootstrap(raw.value as Parameters<typeof pc.bootstrap>[0])
        return { ok: true }
      }
      if (raw.kind === 'invoke') return pc.invoke(raw.value)
      if (raw.kind === 'pendingMetadata') return pc.local.pendingMetadata(500)
      if (raw.kind === 'ackMetadata') {
        const owner = pc.storage.conversation(raw.id)!
        pc.storage.removeRecord(
          raw.id,
          owner.identity.epoch,
          'settings',
          `metadata:${raw.operationId}`
        )
        return { ok: true }
      }
      if (raw.kind === 'metadata.snapshot') return pc.local.metadataSnapshot(raw.id)
      if (raw.kind === 'inspect') return pc.storage.conversation(raw.id)
      throw new Error(raw.kind)
    })
    const gate = vi.fn(async () => {})
    const relay = createHubChatRelay({
      onSessionsChanged: () => {},
      db: h.slayDb,
      ownership,
      request,
      resolveComputer: async () => 'pc-b',
      defaultComputer: async () => 'pc-a',
      gate,
      bootstrap: async (o) => ({
        identity: { id: o.id, taskId: o.taskId, tabId: o.tabId, mode: o.mode, epoch: o.epoch },
        projectId: 'p',
        cwd: '/project',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      migrate: async () => {
        throw new Error('Unexpected migration')
      }
    })
    await relay.invoke(
      'ops',
      'saveTabDraft',
      ['tab', { text: 'computer-only marker', attachments: [] }],
      'save-once'
    )
    await relay.invoke(
      'ops',
      'saveTabDraft',
      ['tab', { text: 'computer-only marker', attachments: [] }],
      'save-once'
    )
    expect(await relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'computer-only marker', rev: 1 }
    })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
    // Chat settings stay on the computer: the hub never gets a copy.
    await pc.local.data.writeChatModel('task', 'claude-chat', 'computer-model')
    // The terminal session id is the computer's ledger's too (robustness plan §9):
    // recorded there, never copied to the hub — not live, not on a full re-read.
    const terminal = (id: string) =>
      pc.local.data.recordConversation({
        taskId: 'task',
        mode: 'claude-code',
        conversationId: id,
        origin: 'slay-spawned-resume'
      })
    await terminal('old-session')
    await terminal('new-session')
    await relay.drainMetadata('pc-a')
    const config = () =>
      JSON.parse(
        (h.db.prepare('SELECT provider_config FROM tasks').get() as { provider_config: string })
          .provider_config ?? '{}'
      )
    expect(config()['claude-code']?.conversationId).toBeUndefined()
    expect(config()['claude-chat']?.chatModel).toBeUndefined()
    h.db.prepare('DELETE FROM chat_metadata_progress').run()
    await relay.drainMetadata('pc-a', true)
    expect(config()['claude-code']?.conversationId).toBeUndefined()
    expect(config()['claude-chat']?.chatModel).toBeUndefined()
    expect(await pc.local.data.getCurrentConversationId('task', 'claude-code')).toBe('new-session')
    expect(gate).toHaveBeenCalledWith('pc-a', 'task')
    expect((await ownership.forTab('tab'))?.computerId).toBe('pc-a')
    await expect(
      relay.invoke('ops', 'saveTabDraft', ['missing', { text: 'bad', attachments: [] }])
    ).rejects.toThrow(/tab/i)
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing a newly visible answer thread atomically fences its first owner registration', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('parent','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'parent-store',
      taskId: 'task',
      tabId: 'parent',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    let closed = false
    const closeVisibleChild = () => {
      if (closed || !h.db.prepare("SELECT 1 FROM terminal_tabs WHERE id='child'").get()) return
      closed = true
      h.db.prepare("DELETE FROM terminal_tabs WHERE id='child'").run()
    }
    const run = h.slayDb.run.bind(h.slayDb),
      batch = h.slayDb.batchTxn.bind(h.slayDb)
    h.slayDb.run = async (sql, params) => {
      const result = await run(sql, params)
      if (sql.includes('INSERT INTO terminal_tabs')) closeVisibleChild()
      return result
    }
    h.slayDb.batchTxn = async (operations) => {
      const result = await batch(operations)
      if (operations.some((op) => op.sql.includes('INSERT INTO terminal_tabs'))) closeVisibleChild()
      return result
    }
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request: async () => null,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      onSessionsChanged: () => {},
      bootstrap: async () => {
        throw new Error('No bootstrap expected')
      },
      migrate: async () => {
        throw new Error('No migration expected')
      }
    })
    await relay
      .reconcileMetadata('pc', {
        conversationId: 'child-store',
        taskId: 'task',
        tabId: 'child',
        epoch: 1,
        kind: 'thread-created',
        operationId: 'thread-introduction',
        sequence: 1,
        storeId: 'store',
        value: { parentTabId: 'parent', mode: 'claude-chat' }
      })
      .catch(() => {})
    expect(closed).toBe(true)
    expect(h.db.prepare("SELECT 1 FROM terminal_tabs WHERE id='child'").get()).toBeUndefined()
    expect(await ownership.get('child-store')).toMatchObject({ state: 'deleted', epoch: 2 })
  } finally {
    h.cleanup()
  }
})

test('direct link: an event-signal reports every saved event to hub consumers, ownership-checked', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb),
      calls: unknown[] = [],
      requests: unknown[] = []
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request: async (_pc, value) => {
        requests.push(value)
        const request = value as { kind: string }
        if (['sessions', 'pendingMetadata'].includes(request.kind)) return []
        return null
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => ({
        identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      migrate: async () => {
        throw new Error('Unexpected migration')
      },
      onSessionsChanged: () => {},
      onState: async (...args) => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        calls.push(args)
      }
    })
    const saved: unknown[] = []
    relay.events.on('saved', (tabId, summary) => saved.push({ tabId, summary }))
    const relayed: unknown[] = []
    relay.events.on('event', (...args) => relayed.push(args))
    const signal = {
      type: 'event-signal',
      conversationId: 'c',
      epoch: 1,
      tabId: 'tab',
      saved: { seq: 0, kind: 'user-message', id: 'u1' }
    }
    await relay.receive('pc', signal)
    expect(saved).toEqual([{ tabId: 'tab', summary: { seq: 0, kind: 'user-message', id: 'u1' } }])
    // Not a client event: nothing is relayed to clients from a signal.
    expect(relayed).toEqual([])
    // History progress follows it: the hub knows clients may have seq 0.
    expect(relay.history.behind('c', 0)).toBe(false)
    await expect(relay.receive('other-pc', signal)).rejects.toThrow(/ownership/i)
    await expect(relay.receive('pc', { ...signal, epoch: 2 })).rejects.toThrow(/ownership/i)
    expect(saved).toHaveLength(1)
  } finally {
    h.cleanup()
  }
})

test('a send behind its tab hydrate reaches the computer only after the hydrate answered', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'store',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const forwarded: string[] = []
    const request = vi.fn<ChatComputerRequest>(async (_pc, raw) => {
      const p = raw as { kind: string; value: { identity: unknown; method: string } }
      if (p.kind === 'bootstrap') return { ok: true, identity: p.value.identity }
      if (p.kind === 'pendingMetadata') return []
      if (p.kind === 'invoke') {
        forwarded.push(p.value.method)
        if (p.value.method === 'hydrate') return { tabId: 'tab' }
        if (p.value.method === 'send') return { id: 'm1', state: 'queued' }
      }
      throw new Error('Unexpected request')
    })
    // The hydrate's way through the hub is slower than the send's (here: held).
    let releaseHydrate!: () => void
    const hydrateHeld = new Promise<void>((resolve) => {
      releaseHydrate = resolve
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      bootstrap: async (owner) => ({
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        projectId: 'p',
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      request,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      migrate: async () => {
        throw new Error('No legacy content to migrate')
      },
      onSessionsChanged: () => {},
      beforeInvoke: async (_owner, method) => {
        if (method === 'hydrate') await hydrateHeld
      }
    })
    const hydrated = relay.ops.hydrate({
      tabId: 'tab',
      taskId: 'task',
      mode: 'claude-chat',
      cwd: '/tmp',
      providerFlagsOverride: null
    })
    const sent = relay.ops.send(
      'tab',
      { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
      'op-1'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(forwarded).toEqual([])
    releaseHydrate()
    await hydrated
    await expect(sent).resolves.toEqual({ id: 'm1', state: 'queued' })
    expect(forwarded).toEqual(['hydrate', 'send'])
  } finally {
    h.cleanup()
  }
})

test('a failed hydrate does not hold its tab send back', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'store',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const forwarded: string[] = []
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      bootstrap: async (owner) => ({
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch
        },
        projectId: 'p',
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      request: async (_pc, raw) => {
        const p = raw as { kind: string; value: { identity: unknown; method: string } }
        if (p.kind === 'bootstrap') return { ok: true, identity: p.value.identity }
        if (p.kind === 'pendingMetadata') return []
        if (p.kind === 'invoke') {
          forwarded.push(p.value.method)
          if (p.value.method === 'hydrate') throw new Error('hydrate failed')
          if (p.value.method === 'send') return { id: 'm1', state: 'queued' }
        }
        throw new Error('Unexpected request')
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      migrate: async () => {
        throw new Error('No legacy content to migrate')
      },
      onSessionsChanged: () => {}
    })
    const hydrated = relay.ops.hydrate({
      tabId: 'tab',
      taskId: 'task',
      mode: 'claude-chat',
      cwd: '/tmp',
      providerFlagsOverride: null
    })
    const sent = relay.ops.send(
      'tab',
      { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
      'op-1'
    )
    await expect(hydrated).rejects.toThrow('hydrate failed')
    await expect(sent).resolves.toEqual({ id: 'm1', state: 'queued' })
    expect(forwarded).toEqual(['hydrate', 'send'])
  } finally {
    h.cleanup()
  }
})

test('restore isolates a conversation whose metadata snapshot fails', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab-a','task','claude-chat',0),('tab-b','task','claude-chat',1)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    for (const [id, tabId] of [
      ['a', 'tab-a'],
      ['b', 'tab-b']
    ])
      await ownership.register({
        id,
        taskId: 'task',
        tabId,
        mode: 'claude-chat',
        computerId: 'pc',
        epoch: 1
      })
    const pending = [
      { conversationId: 'a', sequence: 1 },
      { conversationId: 'b', sequence: 1 }
    ].map((u) => ({
      ...u,
      taskId: 'task',
      tabId: `tab-${u.conversationId}`,
      epoch: 1,
      kind: 'activity' as const,
      operationId: `op-${u.conversationId}`,
      storeId: 'store',
      value: { at: 5 }
    }))
    const acked: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      onSessionsChanged: () => {},
      request: async (_pc, raw) => {
        const r = raw as { kind: string; id: string }
        if (r.kind === 'metadata.snapshot') {
          if (r.id === 'a') throw new Error('Artifact locator belongs to another owner')
          return {
            identity: { id: 'b', taskId: 'task', tabId: 'tab-b', epoch: 1 },
            counter: 0,
            storeId: 'store',
            pending: [],
            updates: []
          }
        }
        if (r.kind === 'pendingMetadata')
          return pending.filter((u) => !acked.includes(u.conversationId))
        if (r.kind === 'ackMetadata') {
          acked.push(r.id)
          return { ok: true }
        }
        throw new Error(r.kind)
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('Recovery must not bootstrap')
      },
      migrate: async () => {
        throw new Error('Recovery must not migrate')
      }
    })
    // One poisoned conversation must not block recovery of every other one.
    const restored = await relay.drainMetadata('pc', true)
    expect([...restored]).toEqual(['b'])
    expect(acked).toEqual(['b'])
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('conversation a'),
      expect.objectContaining({ message: expect.stringMatching(/another owner/) })
    )
    // The skipped update stays pending and applies on the next drain.
    await relay.drainMetadata('pc')
    expect(acked).toEqual(['b', 'a'])
    errors.mockRestore()
  } finally {
    h.cleanup()
  }
})

test('one chat whose migration is stuck never blocks the other chats of its task', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task');
      INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('clean','task','claude-chat',0),('stuck','task','claude-chat',1)`)
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'clean-chat',
      taskId: 'task',
      tabId: 'clean',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    // Legacy history whose migration keeps failing, and the task-wide authority
    // waiting on it; a deleted authority still delivering its removal too.
    await ownership.register({
      id: 'stuck-chat',
      taskId: 'task',
      tabId: 'stuck',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    await ownership.register({
      id: 'authority',
      taskId: 'task',
      tabId: 'task-content:task',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    h.db.exec("INSERT INTO chat_legacy_task_authority VALUES('task','authority')")
    const replay = { events: [], live: { afterSeq: -1, liveSeq: 0, events: [] } }
    const migrate = vi.fn(async (id: string) => {
      throw new Error(`migration of ${id} failed`)
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      bootstrap: async () => {
        throw new Error('unexpected bootstrap')
      },
      request: async (_pc, raw) => {
        const p = raw as { kind: string; value: { method: string } }
        if (p.kind === 'invoke' && p.value.method === 'getReplay') return replay
        if (p.kind === 'pendingMetadata') return []
        throw new Error('Unexpected request')
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      migrate,
      onSessionsChanged: () => {}
    })
    await expect(relay.ops.getReplay('clean', -1)).resolves.toEqual(replay)
    // The stuck chat reports its own failure, every time.
    await expect(relay.ops.getReplay('stuck', -1)).rejects.toThrow(/stuck-chat failed/)
    await expect(relay.ops.getReplay('clean', -1)).resolves.toEqual(replay)
    // Prompt history spans every chat of the task: it reports the stuck one.
    await expect(relay.ensurePromptTask('task')).rejects.toThrow(/failed/)
    // Every stuck chat was attempted, not only the first.
    expect(new Set(migrate.mock.calls.map(([id]) => id))).toEqual(
      new Set(['stuck-chat', 'authority'])
    )
  } finally {
    h.cleanup()
  }
})

test('a placeholder folder resolves once every chat that referenced it was re-read without it', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const child = {
      conversationId: 'c',
      taskId: 'task',
      tabId: 'tab',
      epoch: 1,
      operationId: 'child',
      sequence: 1,
      storeId: 'store',
      kind: 'folder-changed' as const,
      value: { id: 'child', parentId: 'lost-parent', order: 1 }
    }
    const relay = createHubChatRelay({
      onSessionsChanged: () => {},
      db: h.slayDb,
      ownership,
      // The computer never had the parent's own record (lost with its chat).
      request: async (_pc, raw) =>
        (raw as { kind: string }).kind === 'metadata.snapshot'
          ? {
              identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
              counter: 1,
              storeId: 'store',
              pending: [],
              updates: [child]
            }
          : null,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('Metadata must not bootstrap')
      },
      migrate: async () => {
        throw new Error('Metadata must not migrate')
      }
    })
    await relay.reconcileMetadata('pc', child)
    const placeholder = () =>
      h.db
        .prepare("SELECT folder_id FROM chat_folder_placeholders WHERE folder_id='lost-parent'")
        .get()
    expect(placeholder()).toEqual({ folder_id: 'lost-parent' })
    // Re-read in full without the parent's record: nobody can supply it.
    await relay.recoverMetadata('pc', 'c')
    expect(placeholder()).toBeUndefined()
    // A normal folder now: the child stays inside it.
    expect(h.db.prepare("SELECT parent_id FROM artifact_folders WHERE id='child'").get()).toEqual({
      parent_id: 'lost-parent'
    })
  } finally {
    h.cleanup()
  }
})
