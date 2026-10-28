/**
 * The idle sweep (`checkInactiveSessions`) must run in whichever process owns the
 * sessions, with NO window.
 *
 * The regression this pins: the sweep was started only by the Electron host
 * (`startIdleChecker(mainWindow)` on ready-to-show) and bailed out of every tick
 * unless that cached window existed. Since slice 9 the sessions live in the hub,
 * which has no window and never started the sweep — so idle-close never armed,
 * and the silence-timer running→idle fallback (gemini, cursor, opencode, copilot,
 * qwen, shell) never fired either. Both are driven here with no window anywhere.
 *
 * Fake pty + stub db + fake timers — nothing spawns.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/domains/terminal/src/server/runtime/idle-sweep.test.ts
 */
import { afterEach, expect, test, vi } from 'vitest'
import type { PtySessionWindow } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createPty,
  getState,
  killPty,
  noteSessionConversationId,
  ptyEvents,
  setDatabase,
  setIdleCloseConfigGetter,
  startIdleChecker,
  stopIdleChecker,
  touchTaskMainSession,
  transitionStateFromHook
} from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'

// createPty still takes a target window (legacy redirect seam); the SWEEP must not.
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {}, getURL: () => 'https://app' }
} as unknown as PtySessionWindow

const stubDb = {
  get: async () => ({ project_id: 'proj-1' }),
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb
setDatabase(stubDb, createFakeTaskSessionStore())

const killed: string[] = []
function makeFakePty(sessionId: string): unknown {
  const exitCbs: Array<(e: { exitCode: number }) => void> = []
  return {
    pid: 4242,
    process: 'zsh',
    // First output = the agent started (clears the startup deadline, settles idle).
    onData: (cb: (d: string) => void) => {
      queueMicrotask(() => cb('ready\r\n'))
      return { dispose() {} }
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      exitCbs.push(cb)
      return { dispose() {} }
    },
    write: () => {},
    resize: () => {},
    // Exits like a real process, so the session leaves the registry.
    kill: () => {
      killed.push(sessionId)
      for (const cb of exitCbs) cb({ exitCode: 0 })
    }
  }
}
// Adoption (a computer-side rekey) registers the session without a cold spawn,
// so the agent's command templates never have to resolve.
setPtyBackend({
  spawn() {
    throw new Error('test sessions are adopted, never cold-spawned')
  },
  async adopt(_computerId: string, _warmId: string, sessionId: string) {
    return makeFakePty(sessionId) as never
  }
} as unknown as PtyBackend)

const until = async (cond: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A main-tab agent session, adopted, in `state`. Real timers (createPty and the
 *  100ms state debounce run on them); the caller switches to fake ones after. */
async function adoptSession(
  taskId: string,
  mode: string,
  state: 'idle' | 'running'
): Promise<string> {
  const sid = `${taskId}:${taskId}`
  const res = await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: mode as never,
    type: mode,
    conversationId: `conv-${taskId}`,
    initialCommand: 'agent {flags}',
    adoptPty: { warmId: `warm-${taskId}`, computerId: 'computer-1' }
  })
  expect(res.success, `createPty failed: ${res.error}`).toBe(true)
  noteSessionConversationId(sid, `conv-${taskId}`)
  transitionStateFromHook(sid, state, 'test')
  await until(() => getState(sid) === state, `${sid} → ${state}`)
  return sid
}

function recordEvents(): { warned: string[]; cancelled: string[]; hibernated: string[] } {
  const rec = { warned: [] as string[], cancelled: [] as string[], hibernated: [] as string[] }
  ptyEvents.on('hibernate-warn', (sid) => rec.warned.push(sid))
  ptyEvents.on('hibernate-cancelled', (sid) => rec.cancelled.push(sid))
  ptyEvents.on('hibernated', (sid) => rec.hibernated.push(sid))
  return rec
}

afterEach(async () => {
  stopIdleChecker()
  setIdleCloseConfigGetter(null)
  // Flush the kill path's trailing registry cleanup, scheduled on fake time.
  if (vi.isFakeTimers()) await vi.runAllTimersAsync()
  vi.useRealTimers()
  ptyEvents.removeAllListeners('hibernate-warn')
  ptyEvents.removeAllListeners('hibernate-cancelled')
  ptyEvents.removeAllListeners('hibernated')
})

test('windowless sweep: an idle resumable main agent is warned, then hibernated after the grace', async () => {
  const sid = await adoptSession('idleA', 'claude-code', 'idle')
  setIdleCloseConfigGetter(() => ({ enabled: true, idleMs: 15_000 }))
  const rec = recordEvents()

  vi.useFakeTimers()
  startIdleChecker()
  // Tick at 10s: inside the 15s idle window → nothing yet.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rec.warned).toEqual([])
  // Tick at 20s: past it → the cancellable countdown arms.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rec.warned).toEqual([sid])
  // Grace (10s) elapses with no engagement → hibernated + killed.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rec.hibernated).toEqual([sid])
  expect(killed).toContain(sid)
})

test('engagement during the grace (bare taskId, as the browser panel reports it) keeps the agent', async () => {
  const sid = await adoptSession('idleB', 'claude-code', 'idle')
  setIdleCloseConfigGetter(() => ({ enabled: true, idleMs: 15_000 }))
  const rec = recordEvents()

  vi.useFakeTimers()
  startIdleChecker()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(rec.warned).toEqual([sid])

  expect(touchTaskMainSession('idleB')).toBe(true)
  expect(rec.cancelled).toEqual([sid])
  // The cancelled grace never fires, and the fresh clock keeps the next tick quiet.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(rec.hibernated).toEqual([])
  expect(rec.warned).toEqual([sid])
  killPty(sid)
})

test('disabled idle-close never warns, however long the agent idles', async () => {
  const sid = await adoptSession('idleC', 'claude-code', 'idle')
  setIdleCloseConfigGetter(() => ({ enabled: false, idleMs: 15_000 }))
  const rec = recordEvents()

  vi.useFakeTimers()
  startIdleChecker()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(rec.warned).toEqual([])
  killPty(sid)
})

test('windowless sweep: the silence timer flips a running non-hook agent to idle', async () => {
  // gemini is not hook-driven: its running→idle comes ONLY from the silence timer
  // (idleTimeoutMs 2500), which lives in the same sweep.
  const sid = await adoptSession('silentA', 'gemini', 'running')

  vi.useFakeTimers()
  startIdleChecker()
  await vi.advanceTimersByTimeAsync(10_000 + 200) // one tick + the 100ms idle debounce
  expect(getState(sid)).toBe('idle')
  killPty(sid)
})
