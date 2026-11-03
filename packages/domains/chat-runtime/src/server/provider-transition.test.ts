import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import {
  createTestHarness,
  createSlayzoneDbAdapter
} from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatServices } from '../../../../apps/hub/src/computer-chat'
import { createChatRuntimeHandlers } from '../../../../apps/computer/src/handlers/chat-runtime'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { deleteTab } from '../../../task-terminals/src/server/tabs-store'
import { createComputerChatRuntime } from './computer-runtime'
import {
  fakeChild,
  emitLine,
  sj,
  until
} from '../../../terminal/src/server/runtime/chat-transport-testkit'
import type { ChatTabTransition } from '../shared'

async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'provider-transition-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare("INSERT INTO tasks(id,project_id,title,worktree_path) VALUES('task','p','Task',?)")
    .run(dir)
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    .run()
  const open = () =>
    createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      admission: {
        enqueue: () => {
          throw new Error('No provider starts')
        },
        cancel: () => true,
        prioritize: () => false,
        isQueued: () => false,
        stats: () => ({ queued: 0, active: 0, concurrency: 1 })
      },
      ctx: {
        config: {
          hubUrl: 'ws://test/computers',
          name: 'test',
          allowedRoots: [dir],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = open()
  let before: ((request: { kind: string }) => Promise<void>) | undefined
  let after: ((request: { kind: string }, result: unknown) => Promise<void>) | undefined
  let txnFault: 'before' | 'after' | undefined
  const db = {
    ...h.slayDb,
    batchTxn: async (ops: Parameters<typeof h.slayDb.batchTxn>[0]) => {
      const target = ops.some((op) =>
        op.sql.includes("UPDATE chat_provider_transitions SET state='complete'")
      )
      if (target && txnFault === 'before') {
        txnFault = undefined
        throw new Error('Interrupted before hub CAS')
      }
      const result = await h.slayDb.batchTxn(ops)
      if (target && txnFault === 'after') {
        txnFault = undefined
        throw new Error('Interrupted after hub CAS')
      }
      return result
    }
  }
  const services = (backend = db) =>
    createComputerChatServices({
      db: backend,
      legacyData: {
        ...createDbChatDataOps(backend, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: {
        read: async () => {
          throw new Error('No attachments')
        }
      },
      request: async (_id, raw) => {
        const input = JSON.parse(JSON.stringify(raw)) as { kind: string }
        await before?.(input)
        const result = await pc.request(input)
        await after?.(input, result)
        return result
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
  const initial = services()
  await initial.relay.ops.saveTabDraft('tab', {
    text: 'unsent old-provider draft',
    attachments: []
  })
  const original = (await initial.ownership.forTab('tab'))!
  return {
    ...h,
    dir,
    services,
    original,
    request: (raw: unknown) => pc.request(raw),
    change: () => h.db.prepare("UPDATE terminal_tabs SET mode='codex-chat' WHERE id='tab'").run(),
    before: (callback: typeof before) => {
      before = callback
    },
    after: (callback: typeof after) => {
      after = callback
    },
    faultTxn: (fault: typeof txnFault) => {
      txnFault = fault
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

test.each([
  'before-control',
  'lost-control-ack',
  'before-cas',
  'after-cas',
  'lost-bootstrap-ack'
] as const)(
  'provider transition recovers %s with one archive and retained draft',
  async (fault) => {
    const f = await fixture()
    try {
      f.change()
      if (fault === 'before-control')
        f.before(async (req) => {
          if (req.kind === 'conversation.transition') {
            f.before(undefined)
            throw new Error('Interrupted before control')
          }
        })
      if (fault === 'lost-control-ack')
        f.after(async (req) => {
          if (req.kind === 'conversation.transition') {
            f.after(undefined)
            throw new Error('Lost transition ACK')
          }
        })
      if (fault === 'before-cas') f.faultTxn('before')
      if (fault === 'after-cas') f.faultTxn('after')
      if (fault === 'lost-bootstrap-ack')
        f.after(async (req) => {
          if (req.kind === 'bootstrap') {
            f.after(undefined)
            throw new Error('Lost bootstrap ACK')
          }
        })
      await expect(f.services().relay.ensureTab('tab')).rejects.toThrow(/Interrupted|Lost/)
      await f.restart()
      const repaired = f.services()
      await repaired.recoverComputer('pc')
      const selected = await repaired.relay.ensureTab('tab')
      expect(selected).toMatchObject({ mode: 'codex-chat', epoch: 1, state: 'active' })
      const archived = (await repaired.ownership.forTask('task')).filter(
        (owner) => owner.id === f.original.id
      )
      expect(archived).toHaveLength(1)
      expect(archived[0]).toMatchObject({ mode: 'claude-chat', epoch: 2, state: 'active' })
      expect(archived[0].tabId).not.toBe('tab')
      expect(await repaired.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'unsent old-provider draft' }
      })
      expect(await repaired.relay.ops.getTabState(archived[0].tabId)).toMatchObject({
        draft: { text: 'unsent old-provider draft' }
      })
      await repaired.relay.ops.saveTabDraft('tab', { text: 'new selected edit', attachments: [] })
      await repaired.recoverComputer('pc', true)
      expect(await repaired.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'new selected edit' }
      })
      expect((await repaired.ownership.forTask('task')).length).toBe(2)
    } finally {
      await f.close()
    }
  }
)

test('closing original tab after computer rekey fences transition and reconnect without resurrection', async () => {
  const f = await fixture()
  try {
    f.change()
    f.after(async (req) => {
      if (req.kind === 'conversation.transition') {
        f.after(undefined)
        expect(await deleteTab(f.slayDb, 'tab')).toBe(true)
      }
    })
    await expect(f.services().relay.ensureTab('tab')).rejects.toThrow(/deleted|changed/i)
    await f.restart()
    const repaired = f.services()
    await expect(repaired.recoverComputer('pc')).resolves.toBeUndefined()
    expect(f.db.prepare("SELECT id FROM terminal_tabs WHERE task_id='task'").all()).toEqual([])
    expect(
      (await repaired.ownership.forTask('task')).every((owner) => owner.state === 'deleted')
    ).toBe(true)
    const inventory = (await f.request({ kind: 'inventory' })) as { state: string }[]
    expect(inventory.every((owner) => owner.state === 'deleted')).toBe(true)
  } finally {
    await f.close()
  }
})

test('concurrent provider ensures follow latest selection and archive each identity once', async () => {
  const f = await fixture()
  try {
    f.change()
    f.after(async (req) => {
      if (req.kind === 'conversation.transition') {
        f.after(undefined)
        f.db.prepare("UPDATE terminal_tabs SET mode='claude-chat' WHERE id='tab'").run()
      }
    })
    const services = f.services()
    const results = await Promise.all([
      services.relay.ensureTab('tab'),
      services.relay.ensureTab('tab'),
      services.relay.ensureTab('tab')
    ])
    expect(results.every((owner) => owner.mode === 'claude-chat')).toBe(true)
    const owners = await services.ownership.forTask('task')
    expect(owners).toHaveLength(3)
    expect(owners.filter((owner) => owner.id === f.original.id)).toHaveLength(1)
    expect(owners.filter((owner) => owner.tabId === 'tab')).toHaveLength(1)
    await services.recoverComputer('pc', true)
    expect(await services.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'unsent old-provider draft' }
    })
  } finally {
    await f.close()
  }
})

test('restoring hub snapshot before provider change recovers archival proof and selected history', async () => {
  const f = await fixture()
  const snapshot = new Database(f.db.serialize())
  try {
    f.change()
    const selected = await f.services().relay.ensureTab('tab')
    expect(selected.mode).toBe('codex-chat')
    await f.restart()
    const restored = f.services(createSlayzoneDbAdapter(snapshot))
    await restored.recoverComputer('pc')
    const owner = await restored.relay.ensureTab('tab')
    expect(owner.id).toBe(selected.id)
    expect(snapshot.prepare("SELECT mode FROM terminal_tabs WHERE id='tab'").get()).toEqual({
      mode: 'codex-chat'
    })
    const archive = (await restored.ownership.forTask('task')).find(
      (row) => row.id === f.original.id
    )!
    expect(await restored.relay.ops.getTabState(archive.tabId)).toMatchObject({
      draft: { text: 'unsent old-provider draft' }
    })
    expect(await restored.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'unsent old-provider draft' }
    })
    expect(await restored.ownership.forTask('task')).toHaveLength(2)
  } finally {
    snapshot.close()
    await f.close()
  }
})

test('paused task can finish provider metadata transition without reviving writer and restore remains usable', async () => {
  const f = await fixture()
  try {
    f.change()
    f.before(async (req) => {
      if (req.kind === 'conversation.transition') {
        f.before(undefined)
        f.db.prepare("UPDATE tasks SET deleted_at=datetime('now') WHERE id='task'").run()
        throw new Error('Interrupted before paused transition')
      }
    })
    await expect(f.services().relay.ensureTab('tab')).rejects.toThrow(/Interrupted/)
    await f.restart()
    const repaired = f.services()
    await expect(repaired.recoverComputer('pc')).resolves.toBeUndefined()
    await expect(
      repaired.relay.ops.saveTabDraft('tab', { text: 'blocked', attachments: [] })
    ).rejects.toThrow(/paused/i)
    f.db.prepare("UPDATE tasks SET deleted_at=NULL WHERE id='task'").run()
    await repaired.lifecycle.syncTask('task')
    await expect(
      repaired.relay.ops.saveTabDraft('tab', { text: 'restored', attachments: [] })
    ).resolves.toBeDefined()
  } finally {
    await f.close()
  }
})

test('stale provider queue intent is rejected before reserving or sending to selected provider', async () => {
  const f = await fixture()
  try {
    f.change()
    const repaired = f.services()
    await repaired.relay.ensureTab('tab')
    const controls: string[] = []
    f.before(async (req) => {
      controls.push(req.kind)
    })
    await expect(
      repaired.relay.queueOps.push('tab', 'not accepted', 'not accepted', {
        id: 'old-intent',
        expectedMode: 'claude-chat'
      })
    ).rejects.toThrow(/provider changed/i)
    expect(controls).not.toContain('invoke')
    expect(await repaired.relay.queueOps.list('tab')).toEqual([])
  } finally {
    await f.close()
  }
})

test('provider transition fences internal drain, keeps old queue archived, and duplicate control cannot stop selected provider', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'provider-transition-queue-'))
  const child = fakeChild({ exitOnKill: true })
  let starts = 0
  const runtime = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'hub',
    computerId: 'pc',
    transport: {
      whichBinary: async () => '/fake/claude',
      spawn: () => {
        starts++
        setImmediate(() => {
          child.emitter.emit('spawn')
          emitLine(child, sj.init('11111111-1111-4111-8111-111111111111'))
        })
        return child.child
      }
    }
  })
  const from = { id: 'old', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  const value: ChatTabTransition = {
    id: randomUUID(),
    from,
    to: { ...from, tabId: 'archive', epoch: 2 },
    next: { ...from, id: 'new', mode: 'codex-chat' }
  }
  const boot = (identity: typeof from) =>
    runtime.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  try {
    boot(from)
    await runtime.ops.start({ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: dir })
    await runtime.ops.send('tab', { id: 'running', content: [{ type: 'text', text: 'running' }] })
    await child.written((entry) => entry.type === 'user')
    emitLine(child, sj.lifecycle('running', 'started'))
    await runtime.queueOps.push('tab', 'later old-provider message', 'later old-provider message', {
      id: 'queued'
    })
    expect(await runtime.queueOps.list('tab')).toHaveLength(1)
    await runtime.transitionTab(value)
    expect(starts).toBe(1)
    expect((await runtime.queueOps.list('archive'))[0]).toMatchObject({
      id: 'queued',
      tabId: 'archive'
    })
    boot(value.next)
    await runtime.ops.hydrate({ taskId: 'task', tabId: 'tab', mode: 'codex-chat', cwd: dir })
    expect(runtime.transport.getSessionInfo('tab')?.mode).toBe('codex-chat')
    await runtime.transitionTab(value)
    expect(runtime.transport.getSessionInfo('tab')?.mode).toBe('codex-chat')
    expect(starts).toBe(1)
    expect(child.stdin.filter((entry) => entry.type === 'user')).toHaveLength(1)
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider transition fences a start already awaiting binary resolution', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'provider-transition-pending-start-'))
  let resolveBinary!: (value: string) => void
  let resolving!: () => void
  const began = new Promise<void>((resolve) => {
    resolving = resolve
  })
  const binary = new Promise<string>((resolve) => {
    resolveBinary = resolve
  })
  let starts = 0
  const runtime = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'hub',
    computerId: 'pc',
    transport: {
      whichBinary: async () => {
        resolving()
        return binary
      },
      spawn: () => {
        starts++
        throw new Error('Must not start superseded provider')
      }
    }
  })
  const from = { id: 'old', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  const value: ChatTabTransition = {
    id: randomUUID(),
    from,
    to: { ...from, tabId: 'archive', epoch: 2 },
    next: { ...from, id: 'new', mode: 'codex-chat' }
  }
  try {
    runtime.bootstrap({
      identity: from,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const starting = runtime.ops.start({
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      cwd: dir
    })
    const failed = expect(starting).rejects.toThrow(/transition|lifecycle/i)
    await began
    const changing = runtime.transitionTab(value)
    resolveBinary('/fake/claude')
    await failed
    await expect(changing).resolves.toEqual(value.to)
    expect(starts).toBe(0)
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
