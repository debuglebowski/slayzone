/**
 * Idle-close wiring — the hub must run the whole feature, not just hold its config.
 *
 * The regression this pins: idle-close never fired after slice 9. `9023df2fe`
 * wired the config getter into the hub, but the SWEEP that reads it was still
 * started only by the Electron host, against a registry that owns no sessions —
 * so nothing ever armed a countdown. The browser panel's engagement touch had
 * the same orphaning: it ran in the host and touched nothing.
 *
 * So this drives the REAL `@slayzone/terminal/server` module globals: after
 * `wireIdleClose(db, browserEvents)` with idle-close enabled in the settings
 * table, an idle agent is warned on the hub's own sweep, and a browser `engaged`
 * event (relayed from the desktop) cancels the countdown.
 *
 * Plus a narrow source check that the composition root actually calls it.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/idle-close.test.ts
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { PtySessionWindow } from '@slayzone/terminal/server'
import {
  getState,
  noteSessionConversationId,
  ptyEvents,
  setPtyBackend,
  stopIdleChecker,
  transitionStateFromHook,
  type PtyBackend
} from '@slayzone/terminal/server'
// Not on the barrel (the hub spawns through pty-store); same module instance.
import { createPty } from '../../../domains/terminal/src/server/runtime/pty-manager.js'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { wireIdleClose } from './idle-close.js'

const h = await createTestHarness()
for (const [key, value] of [
  ['terminal_auto_close_idle', '1'],
  ['terminal_idle_close_value', '15'],
  ['terminal_idle_close_unit', 'seconds']
]) {
  h.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

setPtyBackend({
  spawn() {
    throw new Error('test sessions are adopted, never cold-spawned')
  },
  async adopt() {
    return {
      pid: 4242,
      process: 'zsh',
      // First output = the agent started (clears the startup deadline, settles idle).
      onData: (cb: (d: string) => void) => {
        queueMicrotask(() => cb('ready\r\n'))
        return { dispose() {} }
      },
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    } as never
  }
} as unknown as PtyBackend)

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {}, getURL: () => 'https://app' }
} as unknown as PtySessionWindow

afterAll(() => {
  stopIdleChecker()
  vi.useRealTimers()
})

test('an idle agent is warned on the hub sweep; browser engagement cancels it', async () => {
  // Fake time that still flows (createPty + the idle debounce run on it), so the
  // sweep wireIdleClose starts below is on the clock this test jumps.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const browserEvents = new EventEmitter()
  const idleClose = wireIdleClose(h.slayDb, browserEvents)
  await idleClose.ready

  const taskId = 'hubIdleA'
  const sid = `${taskId}:${taskId}`
  const res = await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-hub',
    initialCommand: 'claude {flags}',
    adoptPty: { warmId: 'warm-hub', computerId: 'computer-1' }
  })
  expect(res.success, `createPty failed: ${res.error}`).toBe(true)
  noteSessionConversationId(sid, 'conv-hub')
  transitionStateFromHook(sid, 'idle', 'Stop')
  const deadline = Date.now() + 3000
  while (getState(sid) !== 'idle') {
    if (Date.now() > deadline) throw new Error('session never went idle')
    await new Promise((r) => setTimeout(r, 5))
  }

  const warned: string[] = []
  const cancelled: string[] = []
  const hibernated: string[] = []
  ptyEvents.on('hibernate-warn', (s) => warned.push(s))
  ptyEvents.on('hibernate-cancelled', (s) => cancelled.push(s))
  ptyEvents.on('hibernated', (s) => hibernated.push(s))

  // 15 SECONDS (unit read from the settings table): quiet at 10s, warned at 20s.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(warned).toEqual([])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(warned).toEqual([sid])

  // The desktop relays browser-panel input as a bare-taskId `engaged` event.
  browserEvents.emit('engaged', { taskId })
  expect(cancelled).toEqual([sid])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(hibernated).toEqual([])
})

test('composition wires idle-close in the hub', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'composition.ts'), 'utf8')
  expect(src).toMatch(/\bwireIdleClose\(db,/)
})
