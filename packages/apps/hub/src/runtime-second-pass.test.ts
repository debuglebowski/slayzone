import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { defaultConversationRegistry } from '@slayzone/terminal/runtime'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'
import { createLocalChatData } from '../../../domains/chat-runtime/src/server/local-data'
import { createComputerChatRuntime } from '../../../domains/chat-runtime/src/server/computer-runtime'
import {
  fakeChild,
  emitLine,
  sj,
  until
} from '../../../domains/terminal/src/server/runtime/chat-transport-testkit'
import type { ChatAttachment } from '@slayzone/terminal-contracts'

// These tests use the real computer RPC parser, invocation receipts, SQLite and hub
// recovery. Only the transport link (latency/lost replies) and terminal holder are
// controlled. No provider process, live hub, account, home or user DB is touched.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-second-pass-'))
  const legacyData = {
    ...createDbChatDataOps(h.slayDb, taskSessionStore),
    buildMcpEnv: async () => ({})
  }
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
    .run('task', 'p', 'Task')

  const processStarts: string[] = []
  const open = () =>
    createFixtureChatRuntime({
      taskFolder: () => dir,
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      // Fail closed even if a test accidentally reaches an eager spawn.
      admission: {
        enqueue: (lane) => {
          processStarts.push(lane)
          throw new Error('Second-pass audit forbids provider starts')
        },
        cancel: () => true,
        prioritize: () => false,
        isQueued: () => false,
        stats: () => ({ queued: 0, active: 0, concurrency: 1 })
      },
      ctx: {
        config: {
          hubUrl: 'ws://hub/computers',
          name: 'test',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = open()
  let beforeRequest: (body: Record<string, unknown>) => Promise<void> = async () => {}
  let afterRequest: (body: Record<string, unknown>) => Promise<void> = async () => {}
  const bytes = Buffer.from('isolated attachment bytes')
  const services = (
    beforeInvoke?: Parameters<typeof createComputerChatServices>[0]['beforeInvoke']
  ) =>
    createComputerChatServices({
      db: h.slayDb,
      legacyData,
      attachments: { read: async () => bytes },
      request: async (_id, raw) => {
        const body = wire(raw) as Record<string, unknown>
        await beforeRequest(body)
        const result = wire(await pc.request(body))
        await afterRequest(body)
        return result
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false,
      beforeInvoke
    })

  return {
    ...h,
    dir,
    bytes,
    legacyData,
    services,
    processStarts,
    beforeRequest: (next: typeof beforeRequest) => {
      beforeRequest = next
    },
    afterRequest: (next: typeof afterRequest) => {
      afterRequest = next
    },
    request: (body: unknown) => pc.request(wire(body)).then(wire),
    addTab: (id: string, position = 0) => {
      h.db
        .prepare('INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,?,?)')
        .run(id, 'task', 'claude-chat', position)
    },
    seedOwner: async (
      hub: ReturnType<typeof services>,
      id: string,
      tabId: string,
      providerConfig: Record<string, unknown> = {}
    ) => {
      const identity = { id, taskId: 'task', tabId, mode: 'claude-chat', epoch: 1 }
      await pc.request({
        kind: 'bootstrap',
        value: {
          identity,
          projectId: 'p',
          cwd: dir,
          revision: 0,
          providerConfig,
          defaultFlags: null,
          env: {}
        }
      })
      await hub.ownership.register({ ...identity, computerId: 'pc' })
    },
    restart: async () => {
      await pc.close()
      pc = open()
    },
    close: async () => {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('second pass control: lost draft reply reuses its durable receipt after restart', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    const hub = f.services()
    await hub.relay.ops.getTabState('a')
    const owner = (await hub.ownership.forTab('a'))!
    const invoke = {
      kind: 'invoke',
      value: {
        route: { id: owner.id, epoch: owner.epoch },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'same-save-attempt',
        args: ['a', { text: 'saved despite lost reply', attachments: [] }]
      }
    }
    // The reply is intentionally discarded after the computer committed it.
    await f.request(invoke)
    await f.restart()
    expect(await f.request(invoke)).toEqual({ rev: 1 })
    expect(await f.services().relay.ops.getTabState('a')).toMatchObject({
      draft: { text: 'saved despite lost reply', rev: 1 }
    })
    await expect(
      f.request({
        ...invoke,
        value: { ...invoke.value, args: ['a', { text: 'conflicting input', attachments: [] }] }
      })
    ).rejects.toThrow(/different input/)
  } finally {
    await f.close()
  }
})

test('second pass control: distinct tab drafts and queue item routing survive restart', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    f.addTab('b', 1)
    const hub = f.services()
    await hub.relay.ops.saveTabDraft('a', { text: 'draft a', attachments: [] })
    await hub.relay.ops.saveTabDraft('b', { text: 'draft b', attachments: [] })
    await hub.relay.queueOps.push('a', 'one', 'one', { id: 'queued-a' })
    await hub.relay.queueOps.push('b', 'two', 'two', { id: 'queued-b' })
    await f.restart()
    const reopened = f.services()
    expect(await reopened.relay.ops.getTabState('a')).toMatchObject({ draft: { text: 'draft a' } })
    expect(await reopened.relay.ops.getTabState('b')).toMatchObject({ draft: { text: 'draft b' } })
    expect(
      await reopened.relay.queueOps.update(
        'queued-a',
        { send: 'edited', original: 'edited', content: [{ type: 'text', text: 'edited' }] },
        'a'
      )
    ).toBe(true)
    // Reached through its tab (v208): another tab finds nothing.
    expect(await reopened.relay.queueOps.remove('queued-b', 'a')).toBe(false)
    expect(await reopened.relay.queueOps.remove('queued-b', 'b')).toBe(true)
    expect(await reopened.relay.queueOps.list('a')).toMatchObject([
      { id: 'queued-a', send: 'edited' }
    ])
    expect(await reopened.relay.queueOps.list('b')).toEqual([])
    expect(f.processStarts).toEqual([])
  } finally {
    await f.close()
  }
})

test('second pass control: retrying a queue push after its reply was lost does not duplicate its client id', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    const hub = f.services()
    await hub.relay.ops.getTabState('a')
    let dropped = false
    f.afterRequest(async (body) => {
      const value = body.value as { target?: string; method?: string } | undefined
      if (
        body.kind === 'invoke' &&
        value?.target === 'queue' &&
        value.method === 'push' &&
        !dropped
      ) {
        dropped = true
        throw new Error('Reply lost after the push')
      }
    })
    await expect(
      hub.relay.queueOps.push('a', 'one', 'one', { id: 'stable-client-message' })
    ).rejects.toThrow('Reply lost after the push')
    f.afterRequest(async () => {})
    await f.restart()
    const reopened = f.services()
    await reopened.relay.queueOps.push('a', 'one', 'one', { id: 'stable-client-message' })
    expect(await reopened.relay.queueOps.list('a')).toMatchObject([
      { id: 'stable-client-message', send: 'one' }
    ])
    expect(await reopened.relay.queueOps.list('a')).toHaveLength(1)
    expect(f.processStarts).toEqual([])
  } finally {
    await f.close()
  }
})

test.each(['chatMode', 'chatModel', 'chatConversationId'] as const)(
  'second pass: reconnect must not roll back current %s from an unused sibling tab snapshot',
  async (key) => {
    const f = await fixture()
    try {
      f.addTab('a')
      f.addTab('z', 1)
      const oldValue =
        key === 'chatMode' ? 'normal' : key === 'chatModel' ? 'sonnet' : 'old-session'
      const newValue = key === 'chatMode' ? 'plan' : key === 'chatModel' ? 'opus' : 'new-session'
      f.db
        .prepare('UPDATE tasks SET provider_config=? WHERE id=?')
        .run(JSON.stringify({ 'claude-chat': { [key]: oldValue } }), 'task')
      const hub = f.services()
      await f.seedOwner(hub, 'a-root-storage', 'a', { [key]: oldValue })
      await f.seedOwner(hub, 'z-unused-storage', 'z', { [key]: oldValue })
      await hub.recoverComputer('pc')
      if (key === 'chatMode' || key === 'chatModel') {
        const context = { tabId: 'a', taskId: 'task', mode: 'claude-chat', cwd: f.dir }
        await hub.relay.ops.hydrate(context)
        if (key === 'chatMode') await hub.relay.ops.setMode({ ...context, chatMode: newValue })
        else await hub.relay.ops.setModel({ ...context, chatModel: newValue })
      } else {
        // This is the real data adapter used by onPersistSessionId. Exercise
        // confirmation directly; starting an authenticated provider is forbidden.
        const storage = openChatStorage({ stateDir: f.dir, hubScope: 'hub' })
        try {
          const local = createLocalChatData(storage)
          await local.data.recordConversation({
            taskId: 'task',
            mode: 'claude-chat',
            conversationId: newValue,
            origin: 'slay-spawned-fresh',
            legacyJsonField: 'chatConversationId'
          })
        } finally {
          storage.close()
        }
      }
      await hub.relay.drainMetadata('pc')
      // The computer holds the only copy (decision 2); the hub keeps none.
      const computerValue = async () =>
        (
          (await f.request({
            kind: 'taskData',
            taskId: 'task',
            request: { kind: 'providerConfig', mode: 'claude-chat' }
          })) as Record<string, unknown>
        )[key]
      expect(await computerValue()).toBe(newValue)
      expect((await f.legacyData.readProviderConfig('task', 'claude-chat'))[key]).toBeUndefined()
      await f.restart()
      const reopened = f.services()
      await reopened.recoverComputer('pc')
      expect(await computerValue()).toBe(newValue)
      expect((await f.legacyData.readProviderConfig('task', 'claude-chat'))[key]).toBeUndefined()
      expect(f.processStarts).toEqual([])
    } finally {
      await f.close()
    }
  }
)

test('second pass control: single-tab provider state is retained by reconnect metadata recovery', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    const hub = f.services()
    await f.seedOwner(hub, 'a-root-storage', 'a', { chatMode: 'normal' })
    await hub.relay.ops.hydrate({ tabId: 'a', taskId: 'task', mode: 'claude-chat', cwd: f.dir })
    await hub.relay.ops.setMode({
      tabId: 'a',
      taskId: 'task',
      mode: 'claude-chat',
      cwd: f.dir,
      chatMode: 'plan'
    })
    await f.restart()
    expect(await f.services().relay.ops.getMode('task', 'claude-chat')).toBe('plan')
    expect(f.processStarts).toEqual([])
  } finally {
    await f.close()
  }
})

test('second pass: selecting a live native conversation must await its terminal release before dispatch', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    // The terminal's session, on the computer's session ledger (robustness plan §9).
    await f.request({
      kind: 'ledger',
      value: {
        op: 'recordConversation',
        args: {
          taskId: 'task',
          mode: 'claude-code',
          conversationId: sessionId,
          origin: 'slay-spawned-resume'
        }
      }
    })
    const release = vi.fn(async () => {})
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: (task, session) => task === 'task' && session === sessionId,
      release
    })
    // The final callback is after the hub's native-session guard, before the
    // computer operation. Stop there so fixing the guard cannot spawn a CLI.
    const reachedDispatch = new Error('Reached safe provider boundary')
    const hub = f.services(async (_owner, method) => {
      if (method === 'switchConversation') throw reachedDispatch
    })
    let caught: unknown
    try {
      await hub.relay.ops.switchConversation({
        tabId: 'a',
        taskId: 'task',
        mode: 'claude-chat',
        cwd: f.dir,
        conversationId: sessionId,
        sourceMode: 'claude-code'
      })
    } catch (error) {
      caught = error
    }
    expect(release).toHaveBeenCalledWith('task', sessionId)
    expect(caught).toBe(reachedDispatch)
    expect(f.processStarts).toEqual([])
  } finally {
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: () => false,
      release: async () => {}
    })
    await f.close()
  }
})

test('a chat command reads its session id from the computer only while a terminal of the task runs one (v208)', async () => {
  const f = await fixture()
  const live: string[] = []
  try {
    f.addTab('a')
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: (_task, session) => live.includes(session),
      release: async () => {},
      liveConversations: () => [...live]
    })
    const hub = f.services()
    await f.seedOwner(hub, 'a-root-storage', 'a')
    const context = { tabId: 'a', taskId: 'task', mode: 'claude-chat', cwd: f.dir }
    await hub.relay.ops.hydrate(context)
    const reads: unknown[] = []
    f.beforeRequest(async (body) => {
      if (body.kind === 'taskData') reads.push(body)
    })
    await hub.relay.ops.setModel({ ...context, chatModel: 'opus' })
    expect(reads).toEqual([])
    live.push('terminal-session')
    await hub.relay.ops.setModel({ ...context, chatModel: 'sonnet' })
    expect(reads).toHaveLength(1)
    expect(f.processStarts).toEqual([])
  } finally {
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: () => false,
      release: async () => {}
    })
    await f.close()
  }
})

test('second pass control: continue-in-chat releases a live native conversation and persists handoff', async () => {
  const f = await fixture()
  try {
    f.addTab('a')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    // The terminal's session, on the computer's session ledger (robustness plan §9).
    await f.request({
      kind: 'ledger',
      value: {
        op: 'recordConversation',
        args: {
          taskId: 'task',
          mode: 'claude-code',
          conversationId: sessionId,
          origin: 'slay-spawned-resume'
        }
      }
    })
    const release = vi.fn(async () => {})
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: (task, session) => task === 'task' && session === sessionId,
      release
    })
    const hub = f.services()
    expect(
      await hub.relay.ops.continueInChat({
        tabId: 'a',
        taskId: 'task',
        mode: 'claude-chat',
        cwd: f.dir
      })
    ).toMatchObject({ sessionId })
    expect(release).toHaveBeenCalledWith('task', sessionId)
    // The chat's computer holds its session id (decision 2), not the hub.
    expect(
      await f.request({
        kind: 'taskData',
        taskId: 'task',
        request: { kind: 'providerConfig', mode: 'claude-chat' }
      })
    ).toMatchObject({ chatConversationId: sessionId })
    expect(f.processStarts).toEqual([])
  } finally {
    defaultConversationRegistry.registerConversationHolder('terminal', {
      isLive: () => false,
      release: async () => {}
    })
    await f.close()
  }
})

test('second pass preexisting: queue FIFO preserves first submission while its attachment is transferred', async () => {
  const f = await fixture()
  let releaseTransfer: () => void = () => {}
  try {
    f.addTab('a')
    const hub = f.services()
    await hub.relay.ops.getTabState('a')
    const { createArtifactStore } = await import('@slayzone/task-artifacts/server')
    const artifact = await createArtifactStore(f.dir).uploadArtifactBlob(f.slayDb, {
      taskId: 'task',
      title: 'context.txt',
      bytes: f.bytes
    })
    const attachment: ChatAttachment = {
      artifactId: artifact!.id,
      name: 'context.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: f.bytes.length
    }
    let transferStarted: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      transferStarted = resolve
    })
    const transfer = new Promise<void>((resolve) => {
      releaseTransfer = resolve
    })
    f.beforeRequest(async (body) => {
      if (body.kind === 'attachment.put') {
        transferStarted()
        await transfer
      }
    })
    const first = hub.relay.queueOps.push('a', 'first with file', 'first with file', {
      id: 'first',
      content: [
        { type: 'attachment', attachment },
        { type: 'text', text: 'first with file' }
      ]
    })
    await entered
    await hub.relay.queueOps.push('a', 'second text', 'second text', { id: 'second' })
    releaseTransfer()
    await first
    expect((await hub.relay.queueOps.list('a')).map((message) => message.id)).toEqual([
      'first',
      'second'
    ])
    expect(f.processStarts).toEqual([])
  } finally {
    releaseTransfer()
    await f.close()
  }
})

test('second pass: /btw answers remain ephemeral after durable command completion', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-second-pass-btw-'))
  const child = fakeChild({ exitOnKill: true })
  const answerMarker = 'ephemeral-side-answer-private-marker'
  child.answer('side_question', () => ({ success: { response: answerMarker } }))
  const runtime = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'hub',
    computerId: 'pc',
    transport: {
      whichBinary: async () => '/isolated/fake/claude',
      spawn: () => {
        setImmediate(() => child.emitter.emit('spawn'))
        return child.child
      }
    }
  })
  const identity = { id: 'storage', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  try {
    runtime.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    await runtime.ops.start({ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: dir })
    emitLine(child, sj.init('11111111-1111-4111-8111-111111111111'))
    await until(() => runtime.transport.getSessionTerminalState('tab') === 'idle')
    const request = {
      route: { id: identity.id, epoch: 1 },
      target: 'ops',
      method: 'askSideQuestion',
      operationId: 'btw-operation',
      args: [
        {
          taskId: 'task',
          tabId: 'tab',
          mode: 'claude-chat',
          cwd: dir,
          requestId: 'btw-control',
          question: 'Side question only',
          history: []
        }
      ]
    }
    expect(await runtime.invoke(wire(request))).toEqual({ text: answerMarker })
    expect(await runtime.invoke(wire(request))).toEqual({ text: answerMarker })
    expect(child.controlRequests('side_question')).toHaveLength(1)
    expect(runtime.storage.receipt(identity.id, 'btw-operation')).toMatchObject({
      state: 'delivered',
      result: null
    })
    await expect(
      runtime.invoke(
        wire({
          ...request,
          args: [{ ...request.args[0], question: 'A different side question' }]
        })
      )
    ).rejects.toThrow('Operation id reused with different input')
    expect(
      JSON.stringify({
        events: runtime.storage.read(identity.id, -1),
        records: runtime.storage.records(identity.id)
      })
    ).not.toContain(answerMarker)
    await runtime.close()
    const reopened = openChatStorage({ stateDir: dir, hubScope: 'hub' })
    try {
      expect(JSON.stringify(reopened.receipt(identity.id, 'btw-operation'))).not.toContain(
        answerMarker
      )
    } finally {
      reopened.close()
    }
    const next = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
    try {
      await expect(next.invoke(wire(request))).rejects.toThrow(
        'Ephemeral operation result is unavailable; operation was not repeated'
      )
      expect(child.controlRequests('side_question')).toHaveLength(1)
    } finally {
      await next.close()
    }
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function providerFixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-second-pass-provider-'))
  const fakes: ReturnType<typeof fakeChild>[] = []
  const nativeId = '11111111-1111-4111-8111-111111111111'
  const identity = { id: 'storage', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  const context = { taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: dir }
  const open = () => {
    const runtime = createComputerChatRuntime({
      stateDir: dir,
      hubScope: 'hub',
      computerId: 'pc',
      transport: {
        whichBinary: async () => '/isolated/fake/claude',
        spawn: () => {
          const child = fakeChild({ exitOnKill: true })
          fakes.push(child)
          setImmediate(() => {
            child.emitter.emit('spawn')
            emitLine(child, sj.init(nativeId))
          })
          return child.child
        }
      }
    })
    runtime.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    return runtime
  }
  let runtime = open()
  return {
    context,
    fakes,
    nativeId,
    get runtime() {
      return runtime
    },
    invoke: (target: 'ops' | 'queue', method: string, args: unknown[], operationId?: string) =>
      runtime.invoke(
        wire({ route: { id: identity.id, epoch: 1 }, target, method, args, operationId })
      ),
    restart: async () => {
      await runtime.close()
      runtime = open()
    },
    close: async () => {
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('second pass control: approval gates queue delivery and later messages remain FIFO', async () => {
  const f = providerFixture()
  try {
    await f.invoke('ops', 'start', [f.context], 'start')
    await until(() => f.runtime.transport.getSessionTerminalState('tab') === 'idle')
    const first = f.fakes[0]
    await f.invoke(
      'ops',
      'send',
      ['tab', { id: 'first', content: [{ type: 'text', text: 'first' }] }],
      'first-send'
    )
    await first.written((message) => message.type === 'user')
    emitLine(first, sj.lifecycle('first', 'started'))
    emitLine(first, sj.canUseTool('permission', 'tool'))
    await until(() => f.runtime.transport.isSessionAwaitingUserInput('tab'))
    await f.invoke('queue', 'push', ['tab', 'second', 'second', { id: 'second' }], 'queue-second')
    await f.invoke('queue', 'push', ['tab', 'third', 'third', { id: 'third' }], 'queue-third')
    expect(first.stdin.filter((message) => message.type === 'user')).toHaveLength(1)
    expect(
      await f.invoke(
        'ops',
        'respondPermission',
        [
          'tab',
          {
            requestId: 'permission',
            decision: { behavior: 'allow' }
          }
        ],
        'approve'
      )
    ).toBe(true)
    expect(first.stdin.filter((message) => message.type === 'user')).toHaveLength(1)
    emitLine(first, sj.lifecycle('first', 'completed'))
    emitLine(first, sj.success())
    await until(() => first.stdin.filter((message) => message.type === 'user').length === 2)
    expect(
      first.stdin.filter((message) => message.type === 'user').map((message) => message.uuid)
    ).toEqual(['first', 'second'])
    expect(await f.invoke('queue', 'list', ['tab'])).toMatchObject([{ id: 'third' }])
    emitLine(first, sj.lifecycle('second', 'started'))
    emitLine(first, sj.lifecycle('second', 'completed'))
    emitLine(first, sj.success())
    await until(() => first.stdin.filter((message) => message.type === 'user').length === 3)
    expect(
      first.stdin.filter((message) => message.type === 'user').map((message) => message.uuid)
    ).toEqual(['first', 'second', 'third'])
    expect(await f.invoke('queue', 'list', ['tab'])).toEqual([])
  } finally {
    await f.close()
  }
})

test('second pass control: queued conclusions never enter a different native conversation', async () => {
  const f = providerFixture()
  try {
    await f.invoke('ops', 'start', [f.context], 'start')
    await until(() => f.runtime.transport.getSessionTerminalState('tab') === 'idle')
    await f.invoke(
      'queue',
      'push',
      [
        'tab',
        'old conclusion',
        'old conclusion',
        {
          id: 'wrong-conversation',
          expectedConversationId: 'another-native-session'
        }
      ],
      'queue-old'
    )
    await f.invoke(
      'queue',
      'push',
      [
        'tab',
        'later conclusion',
        'later conclusion',
        {
          id: 'later',
          expectedConversationId: f.nativeId
        }
      ],
      'queue-later'
    )
    expect(f.fakes[0].stdin.filter((message) => message.type === 'user')).toEqual([])
    expect(await f.invoke('queue', 'list', ['tab'])).toMatchObject([
      { id: 'wrong-conversation' },
      { id: 'later' }
    ])
  } finally {
    await f.close()
  }
})

test('second pass control: failed provider delivery remains retryable after restart without duplicating the saved message', async () => {
  const f = providerFixture()
  try {
    await f.invoke('ops', 'start', [f.context], 'start')
    await until(() => f.runtime.transport.getSessionTerminalState('tab') === 'idle')
    const message = { id: 'retry-me', content: [{ type: 'text', text: 'preserve this prompt' }] }
    await f.invoke('ops', 'send', ['tab', message], 'original-attempt')
    await f.fakes[0].written((entry) => entry.type === 'user')
    f.fakes[0].exit(1)
    await until(() => f.runtime.transport.getSessionInfo('tab')?.ended === true)
    expect(f.runtime.storage.read('storage', -1).map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({ kind: 'user-message-delivery', id: 'retry-me', state: 'failed' })
    )
    await f.restart()
    await f.invoke('ops', 'hydrate', [f.context], 'rehydrate')
    await f.invoke('ops', 'send', ['tab', message], 'intentional-retry-attempt')
    await until(
      () => f.fakes.length === 2 && f.fakes[1].stdin.some((entry) => entry.type === 'user')
    )
    await f.invoke('ops', 'send', ['tab', message], 'intentional-retry-attempt')
    expect(f.fakes[1].stdin.filter((entry) => entry.type === 'user')).toHaveLength(1)
    expect(
      f.runtime.storage.read('storage', -1).filter((entry) => entry.event.kind === 'user-message')
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('queue ingress reserves first submission before a later call can finish a faster bootstrap', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    f.addTab('a')
    const hub = f.services()
    await hub.relay.ops.getTabState('a')
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    f.beforeRequest(async (body) => {
      if (body.kind === 'bootstrap' && !held) {
        held = true
        entered()
        await pending
      }
    })
    const first = hub.relay.queueOps.push('a', 'first', 'first', { id: 'first' })
    await ready
    const second = hub.relay.queueOps.push('a', 'second', 'second', { id: 'second' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    await Promise.all([first, second])
    expect((await hub.relay.queueOps.list('a')).map((m) => m.id)).toEqual(['first', 'second'])
    expect(f.processStarts).toEqual([])
  } finally {
    release?.()
    await f.close()
  }
})

test('queue clear cancels an earlier submission still waiting for its bootstrap', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    f.addTab('a')
    const hub = f.services()
    await hub.relay.ops.getTabState('a')
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    f.beforeRequest(async (body) => {
      if (body.kind === 'bootstrap' && !held) {
        held = true
        entered()
        await pending
      }
    })
    const first = hub.relay.queueOps
      .push('a', 'first', 'first', { id: 'first' })
      .catch(() => undefined)
    await ready
    const cleared = hub.relay.queueOps.clear('a')
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    await Promise.all([first, cleared])
    expect(await hub.relay.queueOps.list('a')).toEqual([])
    expect(f.processStarts).toEqual([])
  } finally {
    release?.()
    await f.close()
  }
})
