/**
 * A session's terminal size as the hub knows it: what it was spawned at, then every
 * resize a client sent (`pty.resize`). A client that must NOT resize the agent's
 * terminal (the phone, beside a desktop showing the same session) renders at this
 * size, so it reads it at attach (`getPtySize`) and follows changes (`resize` event).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/domains/terminal/src/server/runtime/pty-size.test.ts
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import { setPtyBackend, type PtyBackend, type PtyExit, type PtyHandle } from './pty-backend'
import { createPty, getPtySize, killPty, ptyEvents, resizePty, setDatabase } from './pty-manager'

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

function fakeHandle(): PtyHandle & { resized: Array<[number, number]> } {
  const exits: Array<(e: PtyExit) => void> = []
  return {
    pid: 4242,
    process: 'fake-sh',
    resized: [],
    onData: () => ({ dispose() {} }),
    onExit(cb) {
      exits.push(cb)
      return { dispose() {} }
    },
    write() {},
    resize(c, r) {
      this.resized.push([c, r])
    },
    kill() {
      for (const cb of exits) cb({ exitCode: 0 })
    }
  }
}

let spawnedCols: number | null = null
const backend: PtyBackend = {
  spawn(spec) {
    spawnedCols = spec.options.cols
    return fakeHandle()
  }
}

const resizes: Array<[string, number, number]> = []
const onResize = (sid: string, cols: number, rows: number): void => {
  resizes.push([sid, cols, rows])
}

afterEach(() => {
  ptyEvents.off('resize', onResize)
  resizes.length = 0
  setPtyBackend(null)
})

test('a session reports the size it was spawned at', async () => {
  setPtyBackend(backend)
  const sid = 'sizeTaskA:sizeTaskA'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    cols: 132,
    rows: 41
  })
  expect(spawnedCols).toBe(132)
  expect(getPtySize(sid)).toEqual({ cols: 132, rows: 41 })
  killPty(sid)
})

test('a resize updates the size and is announced once per change', async () => {
  setPtyBackend(backend)
  const sid = 'sizeTaskB:sizeTaskB'
  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })
  // Unsized spawns use the runtime default.
  expect(getPtySize(sid)).toEqual({ cols: 80, rows: 24 })

  ptyEvents.on('resize', onResize)
  expect(resizePty(sid, 120, 40)).toBe(true)
  expect(getPtySize(sid)).toEqual({ cols: 120, rows: 40 })
  // The same size again (a desktop re-fit): nothing changed, nothing announced.
  resizePty(sid, 120, 40)
  // Out-of-range sizes are clamped before they reach the pty; the clamped size is the size.
  resizePty(sid, 9999, 0)
  expect(getPtySize(sid)).toEqual({ cols: 500, rows: 1 })
  expect(resizes).toEqual([
    [sid, 120, 40],
    [sid, 500, 1]
  ])
  killPty(sid)
})

test('an unknown session has no size', () => {
  expect(getPtySize('nobody:nobody')).toBeNull()
})
