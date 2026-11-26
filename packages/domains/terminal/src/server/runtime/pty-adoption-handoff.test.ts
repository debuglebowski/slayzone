import { afterEach, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createRoutingPtyBackend,
  type RoutingGateway,
  type ComputerGatewayEvents
} from '@slayzone/computer-transport/server'
import { TypedEventEmitter } from '@slayzone/computer-transport/shared'
import { configurePtyHost } from '../pty-host'
import { createPtyOps, setPtySpawnLookups, setUnattachedLaunchResolver } from './pty-store'
import { setPtyBackend, type PtyHandle } from './pty-backend'
import { hasLivePty, hasPty, killPty, writePty } from './pty-manager'
import { createFakeTaskSessionStore } from './fake-task-session-store'

vi.mock('@slayzone/diagnostics/server', async (original) => ({
  ...(await original<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: () => undefined
}))

const sid = 'task-1:tab-1'
const other = 'task-2:tab-2'
const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  killPty(sid)
  killPty(other)
  await vi.waitFor(() => expect(hasPty(sid) || hasPty(other)).toBe(false))
  setPtyBackend(null)
  setPtySpawnLookups(null)
  setUnattachedLaunchResolver(null)
})

async function fixture() {
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const computer = {
    computerId: 'pc',
    authMode: 'hello' as const,
    directAddress: null,
    peerLoopback: false,
    directRtc: false,
    connectedAt: 0,
    lastSeenAt: 0,
    epoch: 'e1'
  }
  const processes = new Map([[sid, { spawnId: 'old', pid: 42 }]])
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let offline = false
  let killGate: Promise<void> | undefined
  const gateway = {
    events,
    listComputers: () => [computer],
    request: async (_computer: string, method: string, raw: unknown) => {
      const p = (raw ?? {}) as Record<string, unknown>
      calls.push({ method, params: p })
      if (offline) throw new Error('computer offline')
      const id = p.sessionId as string
      if (method === 'pty.list')
        return {
          sessions: [...processes].map(([sessionId, process]) => ({
            sessionId,
            ...process,
            seq: 5,
            detection: true,
            mode: 'terminal'
          })),
          exited: []
        }
      if (method === 'pty.adopt') {
        const process = processes.get(id)
        if (!process || process.spawnId !== p.fromSpawnId) throw new Error('not live')
        process.spawnId = p.spawnId as string
        return { pid: process.pid, seq: 5, detection: true }
      }
      if (method === 'pty.spawn') {
        processes.set(id, { spawnId: p.spawnId as string, pid: 99 })
        return { pid: 99, detection: true }
      }
      if (method === 'pty.kill') {
        if (killGate) await killGate
        const process = processes.get(id)
        const killed = !!process && process.spawnId === p.spawnId
        if (killed) {
          processes.delete(id)
          events.emit('pty.exit', {
            computerId: 'pc',
            sessionId: id,
            spawnId: process.spawnId,
            exitCode: 0
          })
        }
        return { ok: true, killed }
      }
      return { ok: true }
    }
  } as unknown as RoutingGateway
  const backend = createRoutingPtyBackend({
    gateway,
    resolveComputerId: (spec) => spec.computerId,
    ownerGone: async () => null
  })
  const window = {
    isDestroyed: () => false,
    webContents: { send: () => undefined, getURL: () => '' }
  }
  configurePtyHost({
    getAllWindows: () => [window],
    getFocusedWindow: () => window,
    isDarkTheme: () => true,
    bus: { on: () => undefined }
  })
  setPtySpawnLookups({
    getAgent: async () => null,
    getTaskProjectId: async () => null,
    resolveComputerId: async () => 'pc',
    resolveProjectComputerId: async () => 'pc',
    getProjectRoot: async () => '/repo'
  })
  const db = {
    get: async () => ({ live: 1 }),
    all: async () => [],
    run: async () => ({}),
    prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => ({}) }),
    batchTxn: async () => []
  } as unknown as SlayzoneDb
  setPtyBackend(backend)
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  cleanups.push(() => ops.dispose())
  const reattach = backend.reattach!.bind(backend)
  let delivery: (handle: PtyHandle, signal: AbortSignal) => void = () => undefined
  backend.reattach = async (...args) => {
    const handle = await reattach(...args)
    delivery(handle, args[3].signal!)
    return handle
  }
  const connect = () => events.emit('computer-connected', { computer })
  connect()
  await vi.waitFor(() => expect(ops.unattachedList()[0]?.status).toBe('unattached'))
  return {
    backend,
    ops,
    calls,
    processes,
    connect,
    offline: () => {
      offline = true
    },
    online: () => {
      offline = false
    },
    deliver: (fn: typeof delivery) => {
      delivery = fn
    },
    holdKill: (work: Promise<void>) => {
      killGate = work
    }
  }
}

test('successful transport handoff aborted before manager registration releases the exact provisional process', async () => {
  const h = await fixture()
  // Use the actual registry-owned controller, via canonical Stop, at the delivery boundary.
  h.deliver(() => {
    void h.ops.ptyKill(sid)
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  await h.ops.unattachedAttach('pc', sid)
  await vi.waitFor(() => expect(h.processes.has(sid)).toBe(false))
  expect(hasLivePty(sid)).toBe(false)
  h.connect()
  await vi.waitFor(() => expect(h.ops.unattachedList()).toEqual([]))
  const adopted = h.calls.find((c) => c.method === 'pty.adopt')!.params.spawnId
  expect(h.calls.filter((c) => c.method === 'pty.kill').map((c) => c.params.spawnId)).toEqual([
    adopted
  ])
})

test('ordinary restore commits the handoff, keeps pid/output routing and never resizes or kills', async () => {
  const h = await fixture()
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  await expect(h.ops.unattachedAttach('pc', sid)).resolves.toEqual({ ok: true })
  expect(hasLivePty(sid)).toBe(true)
  expect(h.processes.get(sid)?.pid).toBe(42)
  h.connect()
  await vi.waitFor(() => expect(h.ops.unattachedList()).toEqual([]))
  await expect(writePty(sid, 'restored')).resolves.toBe(true)
  await new Promise((r) => setTimeout(r, 0))
  expect(h.calls.filter((c) => ['pty.spawn', 'pty.kill', 'pty.resize'].includes(c.method))).toEqual(
    []
  )
  expect(h.calls.filter((c) => c.method === 'pty.write').at(-1)?.params.spawnId).toBe(
    h.processes.get(sid)?.spawnId
  )
})

test('abandoned successful handoff stays visible when cleanup is offline, reconnect Stop reaches it', async () => {
  const h = await fixture()
  h.deliver(() => {
    h.offline()
    setUnattachedLaunchResolver(async () => ({ ok: false, reason: 'launch-unresolved' }))
    h.ops.ptyDisposeSession(sid)
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  await h.ops.unattachedAttach('pc', sid)
  expect(hasLivePty(sid)).toBe(false)
  setUnattachedLaunchResolver(async () => ({ ok: false, reason: 'launch-unresolved' }))
  await vi.waitFor(() => expect(h.ops.unattachedList()).toHaveLength(1))
  h.online()
  h.connect()
  await vi.waitFor(() =>
    expect(h.ops.unattachedList()[0]?.spawnId).toBe(h.processes.get(sid)?.spawnId)
  )
  await expect(h.ops.unattachedKill('pc', sid)).resolves.toEqual({ ok: true })
  expect(h.processes.has(sid)).toBe(false)
})

test('consumer delivery failure releases a successful provisional adoption without a received handle', async () => {
  const h = await fixture()
  h.deliver(() => {
    throw new Error('consumer delivery failed')
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  const result = await h.ops.unattachedAttach('pc', sid)
  expect(result.ok).toBe(false)
  await vi.waitFor(() => expect(h.processes.has(sid)).toBe(false))
  expect(hasLivePty(sid)).toBe(false)
})

test('failed manager registration rolls back only its own lease and manager entry', async () => {
  const h = await fixture()
  expect(
    (await h.ops.ptyCreate({ sessionId: other, cwd: '/repo', mode: 'terminal' })).success
  ).toBe(true)
  h.deliver((handle) => {
    const commit = handle.adoption!.commit.bind(handle.adoption)
    handle.adoption!.commit = (register) =>
      commit(() => {
        register()
        throw new Error('registration failed')
      })
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  await h.ops.unattachedAttach('pc', sid)
  await vi.waitFor(() => expect(h.processes.has(sid)).toBe(false))
  expect(hasLivePty(sid)).toBe(false)
  expect(hasLivePty(other)).toBe(true)
})

test.each(['before-delivery', 'before-commit', 'during-commit', 'after-commit'] as const)(
  'task disposal cancels hidden adoption at %s and keeps unrelated task alive',
  async (boundary) => {
    const h = await fixture()
    let cancelledAtBoundary: boolean | undefined
    let commitResult: boolean | undefined
    expect(
      (await h.ops.ptyCreate({ sessionId: other, cwd: '/repo', mode: 'terminal' })).success
    ).toBe(true)
    h.deliver((handle, signal) => {
      expect(h.ops.unattachedList()).toEqual([])
      if (boundary === 'before-delivery') {
        h.ops.ptyDisposeTask('task-1')
        cancelledAtBoundary = signal.aborted
      } else {
        const lease = handle.adoption!
        expect(lease).toBeDefined()
        const commit = lease.commit.bind(lease)
        lease.commit = (register) => {
          if (boundary === 'before-commit') h.ops.ptyDisposeTask('task-1')
          const accepted = commit(
            boundary === 'during-commit'
              ? () => {
                  register()
                  h.ops.ptyDisposeTask('task-1')
                }
              : register
          )
          commitResult = accepted
          if (boundary === 'after-commit') h.ops.ptyDisposeTask('task-1')
          cancelledAtBoundary = signal.aborted
          return accepted
        }
      }
    })
    setUnattachedLaunchResolver(async ({ sessionId }) => ({
      ok: true,
      launch: { sessionId, cwd: '/repo', mode: 'terminal' }
    }))
    await h.ops.unattachedAttach('pc', sid)
    expect(cancelledAtBoundary).toBe(true)
    if (boundary === 'during-commit') expect(commitResult).toBe(false)
    await vi.waitFor(() => expect(hasLivePty(sid)).toBe(false))
    await vi.waitFor(() => expect(h.processes.has(sid)).toBe(false))
    expect(hasLivePty(other)).toBe(true)
    await expect(writePty(other, 'still alive')).resolves.toBe(true)
  }
)

test('late provisional release cannot stop or remove a newer manager registration', async () => {
  const h = await fixture()
  let finish!: () => void
  h.holdKill(
    new Promise<void>((r) => {
      finish = r
    })
  )
  h.deliver(() => {
    void h.ops.ptyKill(sid)
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  await h.ops.unattachedAttach('pc', sid)
  let started = false
  const creating = h.ops
    .ptyCreate({ sessionId: sid, cwd: '/repo', mode: 'terminal' })
    .then((result) => {
      started = result.success
    })
  try {
    await vi.waitFor(() => expect(started).toBe(true))
    const fresh = h.processes.get(sid)!.spawnId
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.processes.get(sid)?.spawnId).toBe(fresh)
    expect(hasLivePty(sid)).toBe(true)
    await expect(writePty(sid, 'fresh')).resolves.toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.calls.filter((c) => c.method === 'pty.write').at(-1)?.params.spawnId).toBe(fresh)
    expect(
      h.calls.filter((c) => c.method === 'pty.kill').every((c) => c.params.spawnId !== fresh)
    ).toBe(true)
  } finally {
    finish()
    await creating
  }
})
