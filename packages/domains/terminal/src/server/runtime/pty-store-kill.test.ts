/**
 * Review M2: every "new conversation / new process" flow (Start fresh, reset the
 * conversation, `slay pty respawn`, a restart, changed flags) kills the tab's session
 * BEFORE its new start. When the hub tracks nothing there but the computer still runs
 * the tab's agent from a previous hub run, that kill must end it — else the new start
 * takes the old agent over (`adoptLive`) and the user's fresh start silently keeps the
 * old conversation. A plain restore (no kill) still takes it over.
 */
import { afterEach, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { createPtyOps } from './pty-store'
import { setPtyBackend, type PtyBackend, type UntrackedPtySession } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'

vi.mock('@slayzone/diagnostics/server', async (orig) => ({
  ...(await orig<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: () => undefined
}))

const db = {
  get: async () => undefined,
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  prepare: () => ({ get: async () => undefined, all: async () => [], run: async () => ({}) }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb

afterEach(() => setPtyBackend(null))

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
