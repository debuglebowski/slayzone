import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { ensureMainTab } from '../../../domains/task-terminals/src/server/tabs-store'
import { createComputerChatRuntime } from '../../../domains/chat-runtime/src/server/computer-runtime'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import {
  fakeChild,
  emitLine,
  sj,
  until
} from '../../../domains/terminal/src/server/runtime/chat-transport-testkit'
import { createFakeClaude, reply } from '../../../shared/test-utils/fake-claude'

// Review probes only. Disposable SQLite, fake children, no live providers or homes.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

test.each([false, true])(
  'review: retrying an already-drained queue message cannot block later messages, newOperation=%s',
  async (newOperation) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'review-integration-queue-'))
    const child = fakeChild({ exitOnKill: true })
    const runtime = createComputerChatRuntime({
      stateDir: dir,
      hubScope: 'hub',
      computerId: 'pc',
      transport: {
        whichBinary: async () => '/review/fake/claude',
        spawn: () => {
          setImmediate(() => {
            child.emitter.emit('spawn')
            emitLine(child, sj.init('11111111-1111-4111-8111-111111111111'))
          })
          return child.child
        }
      }
    })
    const identity = { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
    const context = { taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: dir }
    const call = (method: string, args: unknown[], operationId: string) =>
      runtime.invoke({
        route: { id: identity.id, epoch: 1 },
        target: 'queue',
        method,
        args,
        operationId
      })
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
      await runtime.ops.start(context)
      await until(() => runtime.transport.getSessionTerminalState('tab') === 'idle')
      const message = ['tab', 'first', 'first', { id: 'stable-client-id' }]
      await call('push', message, 'attempt-1')
      await child.written((entry) => entry.type === 'user')
      expect(await runtime.queueOps.list('tab')).toEqual([])
      emitLine(child, sj.lifecycle('stable-client-id', 'started'))
      emitLine(child, sj.lifecycle('stable-client-id', 'completed'))
      emitLine(child, sj.success())
      await until(() => runtime.transport.getSessionTerminalState('tab') === 'idle')
      // Lost hub metadata/HTTP acknowledgement. Client id stays the same; the hub
      // generates a fresh operation id for each queue.push call.
      await call('push', message, newOperation ? 'attempt-2' : 'attempt-1')
      await call('push', ['tab', 'later', 'later', { id: 'later' }], 'attempt-3')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(await runtime.queueOps.list('tab')).toEqual([])
      expect(
        child.stdin.filter((entry) => entry.type === 'user').map((entry) => entry.uuid)
      ).toEqual(['stable-client-id', 'later'])
    } finally {
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test.each(['claude-chat', 'codex-chat'])(
  'review: changing main provider preserves history and admits selected %s',
  async (nextMode) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'review-integration-mode-'))
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      admission: {
        enqueue: () => {
          throw new Error('Review forbids provider starts')
        },
        cancel: () => true,
        prioritize: () => false,
        isQueued: () => false,
        stats: () => ({ queued: 0, active: 0, concurrency: 1 })
      },
      ctx: {
        config: {
          hubUrl: 'ws://review/computers',
          name: 'review',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
    try {
      h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
      h.db
        .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
        .run('task', 'p', 'Task', dir)
      await ensureMainTab(h.slayDb, 'task', 'claude-chat')
      const services = createComputerChatServices({
        db: h.slayDb,
        legacyData: {
          ...createDbChatDataOps(h.slayDb, taskSessionStore),
          buildMcpEnv: async () => ({})
        },
        attachments: { read: async () => Buffer.alloc(0) },
        request: async (_id, raw) => wire(await pc.request(wire(raw))),
        connected: () => true,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      await services.relay.ops.saveTabDraft('task', { text: 'existing draft', attachments: [] })
      const previous = await services.relay.ops.getTabState('task', { expectedMode: 'claude-chat' })
      const beforeGeneration = (await services.availability('task')).recoveryGeneration
      await ensureMainTab(h.slayDb, 'task', nextMode)
      await expect(
        services.relay.ops.hydrate({
          tabId: 'task',
          taskId: 'task',
          mode: nextMode,
          cwd: dir
        })
      ).resolves.toMatchObject({ mode: nextMode })
      expect(
        await services.relay.ops.getTabState('task', { expectedMode: nextMode })
      ).toMatchObject({
        draft: { text: 'existing draft' },
        ownership: expect.objectContaining({ epoch: 1 })
      })
      if (nextMode !== 'claude-chat') {
        const changedGeneration = (await services.availability('task')).recoveryGeneration
        expect(changedGeneration).not.toBe(beforeGeneration)
        await expect(
          services.relay.ops.saveTabDraft(
            'task',
            { text: 'late old draft', attachments: [] },
            {
              expectedMode: 'claude-chat',
              expectedOwnership: previous!.ownership
            }
          )
        ).rejects.toThrow(/changed/)
        expect(
          (await services.relay.ops.getTabState('task', { expectedMode: nextMode }))?.draft.text
        ).toBe('existing draft')
        await ensureMainTab(h.slayDb, 'task', 'claude-chat')
        await services.relay.ops.hydrate({
          tabId: 'task',
          taskId: 'task',
          mode: 'claude-chat',
          cwd: dir
        })
        const roundTripGeneration = (await services.availability('task')).recoveryGeneration
        expect(roundTripGeneration).not.toBe(changedGeneration)
        expect(roundTripGeneration).not.toBe(beforeGeneration)
        await expect(
          services.relay.ops.saveTabDraft(
            'task',
            { text: 'stale original provider', attachments: [] },
            {
              expectedMode: 'claude-chat',
              expectedOwnership: previous!.ownership
            }
          )
        ).rejects.toThrow(/ownership changed/)
      }
    } finally {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test.each([false, true])(
  'review: computer reconnect maintenance must expose persisted output, dropped=%s',
  async (dropped) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'review-integration-reconnect-'))
    const fake = createFakeClaude({ root: join(dir, 'fake') })
    const marker = 'answer-completed-while-computer-link-offline'
    fake.setScenario({ processes: [{ defaultTurn: [{ sleep: 500 }, ...reply(marker)] }] })
    let connected = true
    let failRecovery = false
    const notifications: unknown[] = []
    let services: ReturnType<typeof createComputerChatServices>
    const delivered: unknown[] = []
    const catchUps: Promise<void>[] = []
    const recoverySignals: Array<{ tabId: string; generation: string }> = []
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://review/computers',
          name: 'review',
          binOverrideDir: fake.binDir,
          allowedRoots: [dir],
          capabilities: ['proc']
        },
        dialer: {
          notify: (_method, raw) => {
            if (!connected) return false
            notifications.push(raw)
            const value = raw as { name: string; payload: unknown }
            if (value.name === 'chat-runtime')
              void services?.relay.receive('pc', wire(value.payload)).catch(() => {})
            return true
          }
        },
        log: () => {}
      }
    })
    try {
      h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
      h.db
        .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
        .run('task', 'p', 'Task', dir)
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
        )
        .run()
      services = createComputerChatServices({
        db: h.slayDb,
        legacyData: {
          ...createDbChatDataOps(h.slayDb, taskSessionStore),
          buildMcpEnv: async () => ({})
        },
        attachments: { read: async () => Buffer.alloc(0) },
        request: async (_id, raw) => {
          if (
            failRecovery &&
            raw &&
            typeof raw === 'object' &&
            'kind' in raw &&
            raw.kind === 'retention.configure'
          ) {
            failRecovery = false
            throw new Error('injected recovery failure')
          }
          return wire(await pc.request(wire(raw)))
        },
        connected: () => connected,
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      services.relay.events.on('event', (_tabId, event) => delivered.push(event))
      services.relay.events.on('replay-required', (tabId, generation) => {
        recoverySignals.push({ tabId, generation })
        // The UI responds to the metadata watermark by fetching its authorized
        // persisted replay. No missed content is written to a hub event journal.
        catchUps.push(
          services.relay.ops.getReplay(tabId, -1).then((replay) => {
            delivered.push(...replay.events.map((entry) => entry.event))
          })
        )
      })
      await services.relay.ops.hydrate({
        tabId: 'tab',
        taskId: 'task',
        mode: 'claude-chat',
        cwd: dir
      })
      expect((await services.availability('tab')).state).toBe('ready')
      const before = (await services.availability('tab')).recoveryGeneration
      expect(before).toBeTruthy()
      expect(recoverySignals).toEqual([])
      await services.relay.ops.send('tab', {
        id: 'request',
        content: [{ type: 'text', text: 'test' }]
      })
      connected = !dropped
      const owner = (await services.ownership.forTab('tab'))!
      const read = () =>
        pc.request({
          kind: 'invoke',
          value: {
            route: { id: owner.id, epoch: owner.epoch },
            target: 'ops',
            method: 'getReplay',
            args: ['tab', -1]
          }
        })
      await vi.waitFor(async () => expect(JSON.stringify(await read())).toContain(marker), {
        timeout: 15_000
      })
      if (dropped) expect(JSON.stringify(notifications)).not.toContain(marker)
      connected = true
      services.invalidateRecovery('pc')
      if (dropped) {
        failRecovery = true
        await expect(services.recoverComputer('pc')).rejects.toThrow('injected recovery failure')
        expect((await services.availability('tab')).recoveryGeneration).toBe(before)
        expect(recoverySignals).toEqual([])
      }
      await services.recoverComputer('pc')
      await services.relay.refreshSessions('pc')
      await Promise.all(catchUps)
      expect((await services.availability('tab')).state).toBe('ready')
      const after = (await services.availability('tab')).recoveryGeneration
      expect(after).not.toBe(before)
      expect(recoverySignals).toEqual([{ tabId: 'tab', generation: after }])
      expect(JSON.stringify(delivered)).toContain(marker)
      await services.recoverComputer('pc')
      expect((await services.availability('tab')).recoveryGeneration).toBe(after)
      expect(recoverySignals).toHaveLength(1)
    } finally {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
