/**
 * `hasLivePty` vs `hasPty` across a pty exit.
 *
 * On exit the session stays registered ~100ms (state 'dead') so trailing onData
 * can still drain to followers. `hasPty` must keep answering true for that
 * window (follow's drain relies on it), but nothing that DECIDES about the
 * session may treat it as alive: the renderer's respawn checks, and REST
 * write/start/wait, read `exists` → a write landing in the window went to the
 * dead process and was lost, and a Retry's own respawn raced it (e2e
 * 55-crash-recovery, ~1 in 3 runs under load).
 *
 * Fake pty + fake backend + stub db — nothing spawns.
 */
import { expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import { createPty, hasLivePty, hasPty, setDatabase } from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
setDatabase({
  get: async () => ({ project_id: 'proj-1' }),
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb)

/** `fireExit` emits output first, as a real shell that drew its prompt and then
 *  ran `exit 7` does — an exit with no output takes the fast-exit recovery path. */
function spawnWithExitHook(): { fireExit: (code: number) => void } {
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  let dataCb: ((d: string) => void) | undefined
  setPtyBackend({
    spawn: () =>
      ({
        pid: 4242,
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
        kill: () => undefined,
        resize: () => undefined
      }) as never
  } as PtyBackend)
  return {
    fireExit: (code) => {
      dataCb?.('$ ')
      exitCb?.({ exitCode: code })
    }
  }
}

test('a live session is both registered and live', async () => {
  spawnWithExitHook()
  const res = await createPty({
    win: fakeWin,
    sessionId: 'live:live',
    cwd: '/tmp',
    mode: 'terminal',
    computerId: 'computer-1'
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  expect(hasPty('live:live')).toBe(true)
  expect(hasLivePty('live:live')).toBe(true)
})

test('an exited session is not live, though it lingers registered for the drain', async () => {
  const { fireExit } = spawnWithExitHook()
  const res = await createPty({
    win: fakeWin,
    sessionId: 'exit:exit',
    cwd: '/tmp',
    mode: 'terminal'
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)

  fireExit(7)
  expect(hasPty('exit:exit'), 'still registered while trailing output drains').toBe(true)
  expect(hasLivePty('exit:exit'), 'an exited process is not live').toBe(false)

  await new Promise((r) => setTimeout(r, 200))
  expect(hasPty('exit:exit'), 'dropped after the drain window').toBe(false)
})

test('an unknown session is neither', () => {
  expect(hasPty('nope:nope')).toBe(false)
  expect(hasLivePty('nope:nope')).toBe(false)
})
