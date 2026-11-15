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
import { createPtyOps, setPtySpawnLookups } from './pty-store'
import { createPty, killPty } from './pty-manager'
import type { PtySpawnLookups } from './pty-data-ops'
import { setPtyBackend, type PtyBackend, type UntrackedPtySession } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'

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

const db = {
  get: async () => undefined,
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => ({}) }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb

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
  setPtyBackend(null)
  setPtySpawnLookups(null)
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
