/**
 * Replacing a session (same id: agent switch, restart) must leave the NEW one
 * registered. The outgoing process exits while the replacement is still being
 * created; its exit's deferred cleanup (100 ms later, for trailing output) dropped
 * whatever held the id by then — the new session. `pty.exists` stayed false, and
 * the new process ran attached to nothing (e2e terminal/30 "Agent switch teardown"
 * under load).
 *
 * Fake backend + stub db — nothing spawns.
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import { createPty, hasPty, killPty, setDatabase } from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'
import { ptyEvents } from './pty-events'
import { createFakeTaskSessionStore } from './fake-task-session-store'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  createFakeTaskSessionStore()
)

/** Every spawned handle exits the moment it is killed, as a local SIGKILL does. */
function exitOnKillBackend(): { spawned: number; print: (data: string) => void } {
  let dataCb: ((d: string) => void) | undefined
  const state = { spawned: 0, print: (data: string) => dataCb?.(data) }
  setPtyBackend({
    spawn: () => {
      state.spawned++
      let exitCb: ((e: { exitCode: number }) => void) | undefined
      return {
        pid: 5000 + state.spawned,
        process: 'zsh',
        onData: (cb: (d: string) => void) => {
          dataCb = cb
          return { dispose: () => undefined }
        },
        onExit: (cb: (e: { exitCode: number }) => void) => {
          exitCb = cb
          return { dispose: () => undefined }
        },
        write: () => undefined,
        kill: () => exitCb?.({ exitCode: 137 }),
        resize: () => undefined
      } as never
    }
  } as PtyBackend)
  return state
}

const opened: string[] = []
afterEach(() => {
  for (const id of opened.splice(0)) killPty(id)
  ptyEvents.removeAllListeners()
})

const open = async (sessionId: string, mode: string): Promise<void> => {
  const res = await createPty({ win: fakeWin, sessionId, cwd: '/tmp', mode } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  opened.push(sessionId)
}

test('the replacement stays registered after the outgoing exit cleans up', async () => {
  const backend = exitOnKillBackend()
  await open('replace:switch', 'terminal')
  // A running shell (it printed): its exit is a real exit, not a failed start.
  backend.print('$ ')
  await open('replace:switch', 'codex')
  expect(hasPty('replace:switch')).toBe(true)
  // Past the outgoing exit's deferred cleanup.
  await new Promise((r) => setTimeout(r, 300))
  expect(hasPty('replace:switch')).toBe(true)
})
