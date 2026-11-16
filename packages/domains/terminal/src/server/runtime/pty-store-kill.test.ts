/**
 * Review M2: every "new conversation / new process" flow (Start fresh, reset the
 * conversation, `slay pty respawn`, a restart, changed flags) kills the tab's session
 * BEFORE its new start. When the hub tracks nothing there but the computer still runs
 * the tab's agent from a previous hub run, that kill tries to end it. Even if the
 * computer is offline or not listed yet, the next start must replace it instead of
 * taking it over (`adoptLive`). A plain restore (no kill) still takes it over.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createPtyOps as makePtyOps,
  setPtySpawnLookups,
  setUnattachedLaunchResolver
} from './pty-store'
import { createPty, killPty } from './pty-manager'
import type { PtySpawnLookups } from './pty-data-ops'
import { setPtyBackend, type PtyBackend, type UntrackedPtySession } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness'

const diag = vi.hoisted(() => vi.fn())
vi.mock('@slayzone/diagnostics/server', async (orig) => ({
  ...(await orig<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: diag
}))
vi.mock('./pty-manager', async (orig) => ({
  ...(await orig<typeof import('./pty-manager')>()),
  createPty: vi.fn(async () => ({ success: true })),
  killPty: vi.fn(() => false)
}))
vi.mock('../pty-host', async (orig) => ({
  ...(await orig<typeof import('../pty-host')>()),
  getPtyHostBridge: () => ({
    getFocusedWindow: () => ({ isDestroyed: () => false, webContents: { send: () => undefined } })
  })
}))

const db = {
  get: vi.fn(async () => ({ live: 1 })),
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => ({}) }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb

const openOps: Array<ReturnType<typeof makePtyOps>> = []
const createPtyOps = (...args: Parameters<typeof makePtyOps>) => {
  const ops = makePtyOps(...args)
  openOps.push(ops)
  return ops
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(killPty).mockReturnValue(false)
  vi.mocked(createPty).mockResolvedValue({ success: true })
  setPtySpawnLookups({
    getAgent: async () => null,
    getTaskProjectId: async () => null,
    resolveComputerId: async () => 'pc'
  } as unknown as PtySpawnLookups)
})
afterEach(() => {
  for (const ops of openOps.splice(0)) ops.dispose()
  vi.useRealTimers()
  setPtyBackend(null)
  setPtySpawnLookups(null)
  setUnattachedLaunchResolver(null)
})

test('whole cleanup deadline covers held launch resolution and every computer; late resolution cannot adopt', async () => {
  vi.useFakeTimers()
  let release!: (v: { ok: true; launch: { sessionId: string; cwd: string; mode: string } }) => void
  const held = new Promise<{ ok: true; launch: { sessionId: string; cwd: string; mode: string } }>(
    (r) => {
      release = r
    }
  )
  setUnattachedLaunchResolver(() => held)
  const lateStops: Array<(v: { stopped: boolean }) => void> = []
  const stop = vi.fn(
    () =>
      new Promise<{ stopped: boolean }>((r) => {
        lateStops.push(r)
      })
  )
  setPtyBackend({
    spawn: vi.fn(),
    killUntracked: stop,
    untrackedSessions: () =>
      ['a', 'b'].map((computerId) => ({
        computerId,
        sessionId: 'task-1:tab-1',
        spawnId: 'old',
        detection: true
      }))
  })
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  await vi.advanceTimersByTimeAsync(0)
  let answer: boolean | undefined
  const killing = ops.ptyKill('task-1:tab-1').then((v) => {
    answer = v
  })
  await vi.advanceTimersByTimeAsync(5_001)
  expect(answer).toBe(false)
  expect(stop).toHaveBeenCalledTimes(2)
  await killing
  await ops.ptyCreate({ sessionId: 'task-1:tab-1', cwd: '/repo' }, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
  const creates = vi.mocked(createPty).mock.calls.length
  const trackedKills = vi.mocked(killPty).mock.calls.length
  for (const finish of lateStops) finish({ stopped: true })
  release({ ok: true, launch: { sessionId: 'task-1:tab-1', cwd: '/repo', mode: 'claude-code' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(createPty).toHaveBeenCalledTimes(creates)
  expect(killPty).toHaveBeenCalledTimes(trackedKills)
})

test('an older create cannot consume a newer stop token', async () => {
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  const opts = { sessionId: 'task-1:tab-1', cwd: '/repo' }
  await ops.ptyKill(opts.sessionId)
  let finish!: (v: { success: boolean }) => void
  vi.mocked(createPty).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r
      })
  )
  const first = ops.ptyCreate(opts, win)
  await vi.waitFor(() => expect(createPty).toHaveBeenCalledOnce())
  await ops.ptyKill(opts.sessionId)
  finish({ success: true })
  await first
  await ops.ptyCreate(opts, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
  await ops.ptyCreate(opts, win)
  expect(vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver).not.toBe(false)
})

test('task disposal aborts active adoption identity after its visible row disappears', async () => {
  let listed: UntrackedPtySession[] = [
    { computerId: 'pc', sessionId: 'task-1:tab-1', spawnId: 'old', detection: true }
  ]
  const changes = new Set<() => void>()
  setPtyBackend({
    spawn: vi.fn(),
    untrackedSessions: () => listed,
    onUntrackedChange: (cb) => {
      changes.add(cb)
      return { dispose: () => changes.delete(cb) }
    }
  })
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'terminal' }
  }))
  let signal: AbortSignal | undefined
  vi.mocked(createPty).mockImplementationOnce(async (opts) => {
    signal = opts.attach?.signal
    listed = []
    for (const cb of changes) cb()
    return new Promise(() => undefined)
  })
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  await vi.waitFor(() => expect(signal).toBeDefined())
  expect(ops.unattachedList()).toEqual([])
  ops.ptyDisposeTask('task-1')
  expect(signal!.aborted).toBe(true)
})

test('stop cancels adoption during serialized preparation; fresh create does not wait and late prep cannot bind', async () => {
  vi.useFakeTimers()
  let release!: (v: null) => void
  const held = new Promise<null>((r) => {
    release = r
  })
  const getAgent = vi.fn().mockReturnValueOnce(held).mockResolvedValue(null)
  setPtySpawnLookups({
    getAgent,
    getTaskProjectId: async () => null,
    resolveComputerId: async () => 'pc'
  } as unknown as PtySpawnLookups)
  setUnattachedLaunchResolver(async ({ sessionId }) => ({
    ok: true,
    launch: { sessionId, cwd: '/repo', mode: 'claude-code' }
  }))
  setPtyBackend({
    spawn: vi.fn(),
    untrackedSessions: () => [
      { computerId: 'pc', sessionId: 'task-1:tab-1', spawnId: 'old', detection: true }
    ],
    killUntracked: async () => ({ stopped: false })
  })
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  await vi.advanceTimersByTimeAsync(0)
  expect(getAgent).toHaveBeenCalledOnce()
  let stopped: boolean | undefined
  const killing = ops.ptyKill('task-1:tab-1').then((v) => {
    stopped = v
  })
  await vi.advanceTimersByTimeAsync(5_001)
  expect(stopped).toBe(false)
  await killing
  let started = false
  const starting = ops.ptyCreate({ sessionId: 'task-1:tab-1', cwd: '/repo' }, win).then(() => {
    started = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(started).toBe(true)
  await starting
  release(null)
  await vi.advanceTimersByTimeAsync(0)
  expect(createPty).toHaveBeenCalledOnce()
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
})

test('confirmed tab/task deletion clears many tokens, including kill after tab deletion; valid offline token persists', async () => {
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  vi.mocked(db.get).mockResolvedValueOnce(undefined)
  await ops.ptyKill('task-1:closed-tab')
  await ops.ptyCreate({ sessionId: 'task-1:closed-tab', cwd: '/repo' }, win)
  expect(vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver).not.toBe(false)
  for (let n = 0; n < 100; n++) {
    const sessionId = `deleted-${n}:tab`
    await ops.ptyKill(sessionId)
    if (n % 2) ops.ptyDisposeSession(sessionId)
    else ops.ptyDisposeTask(`deleted-${n}`)
    await ops.ptyCreate({ sessionId, cwd: '/repo' }, win)
    expect(vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver).not.toBe(false)
  }
  await ops.ptyKill('valid:offline')
  await ops.ptyCreate({ sessionId: 'valid:offline', cwd: '/repo' }, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
})

test('real deletion lookup preserves lazy main and offline tabs, discards closed/deleted owners', async () => {
  const h = await createTestHarness()
  const ops = createPtyOps(h.slayDb, createFakeTaskSessionStore())
  try {
    await h.slayDb.run("INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#123456')")
    await h.slayDb.run("INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T')")
    await h.slayDb.run(
      "INSERT INTO terminal_tabs (id, task_id, mode, is_main) VALUES ('tab', 't', 'terminal', 0)"
    )
    const startAfterKill = async (sessionId: string) => {
      await ops.ptyKill(sessionId)
      await ops.ptyCreate({ sessionId, cwd: '/repo' }, win)
      return vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver
    }
    expect(await startAfterKill('t:t')).toBe(false)
    expect(await startAfterKill('t:tab')).toBe(false)
    await h.slayDb.run("DELETE FROM terminal_tabs WHERE id = 'tab'")
    expect(await startAfterKill('t:tab')).not.toBe(false)
    await h.slayDb.run("DELETE FROM tasks WHERE id = 't'")
    expect(await startAfterKill('t:t')).not.toBe(false)
  } finally {
    ops.dispose()
    h.cleanup()
  }
})

const win = { isDestroyed: () => false, webContents: { send: () => undefined } } as never

test('kill with an empty registry makes the next start replace; restore remains adoptable', async () => {
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  const opts = { sessionId: 'task-1:tab-1', cwd: '/repo' }
  expect(await ops.ptyKill(opts.sessionId)).toBe(false)
  await ops.ptyCreate(opts, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
  await ops.ptyCreate(opts, win)
  expect(vi.mocked(createPty).mock.calls.at(-1)?.[0].takeOver).not.toBe(false)
})

test('a failed create retains replacement intent and proactive adoption cannot consume it', async () => {
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  const opts = { sessionId: 'task-1:tab-1', cwd: '/repo' }
  await ops.ptyKill(opts.sessionId)
  expect(
    await ops.ptyCreate({ ...opts, attach: { computerId: 'pc', spawnId: 'old' } }, win)
  ).toMatchObject({ success: false, code: 'attach-refused' })
  expect(createPty).not.toHaveBeenCalled()
  vi.mocked(createPty).mockResolvedValueOnce({ success: false, error: 'offline' })
  await ops.ptyCreate(opts, win)
  await ops.ptyCreate(opts, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
})

test('offline untracked cleanup resolves false, records failure, and preserves replacement intent', async () => {
  setPtyBackend({
    spawn: vi.fn(),
    untrackedSessions: () => [
      { computerId: 'pc', sessionId: 'task-1:tab-1', spawnId: 'old', detection: false }
    ],
    killUntracked: async () => {
      throw new Error("computer 'pc' is not connected")
    }
  })
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  await vi.waitFor(() => expect(ops.unattachedList()).toHaveLength(1))
  await expect(ops.ptyKill('task-1:tab-1')).resolves.toBe(false)
  expect(diag).toHaveBeenCalledWith(expect.objectContaining({ event: 'pty.orphan_kill_failed' }))
  await ops.ptyCreate({ sessionId: 'task-1:tab-1', cwd: '/repo' }, win)
  expect(createPty).toHaveBeenLastCalledWith(expect.objectContaining({ takeOver: false }))
})

test('an untracked kill that lost to a tab adoption retries the now-tracked kill', async () => {
  setPtyBackend({
    spawn: vi.fn(),
    untrackedSessions: () => [
      { computerId: 'pc', sessionId: 'task-1:tab-1', spawnId: 'old', detection: false }
    ],
    killUntracked: async () => {
      vi.mocked(killPty).mockReturnValue(true)
      return { stopped: false }
    }
  })
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  await vi.waitFor(() => expect(ops.unattachedList()).toHaveLength(1))
  expect(await ops.ptyKill('task-1:tab-1')).toBe(true)
  expect(killPty).toHaveBeenCalledTimes(2)
})

test('a kill of a tab the hub does not track ends the agent the computer still runs there', async () => {
  let listed: UntrackedPtySession[] = [
    {
      computerId: 'pc',
      sessionId: 'task-1:tab-1',
      spawnId: 'run-1',
      detection: true,
      mode: 'claude-code'
    }
  ]
  const listeners = new Set<() => void>()
  const killed: string[] = []
  setPtyBackend({
    spawn: () => {
      throw new Error('never spawns')
    },
    untrackedSessions: () => listed,
    onUntrackedChange: (cb: () => void) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    },
    killUntracked: async (_c: string, sessionId: string, spawnId: string) => {
      killed.push(`${sessionId}#${spawnId}`)
      listed = []
      for (const cb of [...listeners]) cb()
      return { stopped: true }
    }
  } as unknown as PtyBackend)
  const ops = createPtyOps(db, createFakeTaskSessionStore())
  // (No launch resolver wired: the session stays listed, unattached.)
  await vi.waitFor(() => expect(ops.unattachedList()).toHaveLength(1))

  expect(await ops.ptyKill('task-1:tab-1')).toBe(true)
  expect(killed).toEqual(['task-1:tab-1#run-1'])
  expect(ops.unattachedList()).toEqual([])
  // Nothing anywhere under an unknown id: false, as before.
  expect(await ops.ptyKill('task-9:tab-9')).toBe(false)
})
