/**
 * A chat agent's state changes reach clients on `pty.onStateChange`, exactly like a
 * terminal agent's: keyed by the chat session id (`${taskId}:${tabId}`), same
 * `{ sessionId, newState, oldState }` shape, through the owner gate.
 *
 * Before, a chat transition went only to the Electron window bridge (a stub on the
 * hub) and to the hub's own global listeners, so a client saw a chat agent's dot move
 * only when it next polled `pty.sessionList`.
 *
 * Wired the way composition.ts wires it: the pty router reads the shared `ptyEvents`
 * stream (`setPtyDeps`), the chat transport runs with its DEFAULT broadcasts (only the
 * process spawn is faked), and calls go through the real `appRouter` gate chain.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/chat-state-push.test.ts
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { appRouter, setAuthGate } from '@slayzone/api'
import { ptyEvents, setPtyDeps, type PtyDeps } from '@slayzone/terminal/server'
// The transport's test seams are not on the package barrel; reached by path so this is
// the SAME module instance the routers use (workspace symlinks resolve to this file).
import * as chat from '../../../domains/terminal/src/server/runtime/chat-transport-manager.js'

const FIXTURES = join(import.meta.dirname, '../../../domains/terminal/test/fixtures/claude-stream')

const h = await createTestHarness()
// As composition.ts: the `pty.*` subscriptions read the shared pty event stream.
setPtyDeps({ ops: {} as unknown as PtyDeps['ops'], events: ptyEvents })

type FakeChild = ChildProcess & { _stdout: PassThrough }
function fakeChild(): FakeChild {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: {
      write: (_s: string, cb?: (err?: Error | null) => void) => {
        cb?.()
        return true
      }
    },
    pid: 4242,
    kill: () => true,
    _stdout: stdout
  })
  return child as unknown as FakeChild
}

let child: FakeChild
beforeEach(() => {
  chat.__resetForTests()
  chat.resetTransportDeps()
  child = fakeChild()
  // Only the process is faked: broadcastStateChange / broadcastEvent stay the defaults.
  chat.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => child
  })
})
afterAll(() => {
  chat.__resetForTests()
  chat.resetTransportDeps()
  setAuthGate(() => false)
})

/** Hydrate + spawn a chat tab, then run one turn (running → idle). */
async function runOneTurn(taskId: string, tabId: string): Promise<void> {
  await chat.hydrateSession({
    tabId,
    taskId,
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  const ready = chat.ensureSpawned(tabId)
  for (let i = 0; i < 50 && !chat.__getSessionChildForTests(tabId); i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  ;(chat.__getSessionChildForTests(tabId) as unknown as EventEmitter).emit('spawn')
  await ready
  child._stdout.write(readFileSync(join(FIXTURES, 'bash.ndjson'), 'utf8'))
  await new Promise((r) => setTimeout(r, 50))
}

type StateEvent = { sessionId: string; newState: string; oldState: string }

async function subscribe(principal?: { userId: string }): Promise<{
  events: StateEvent[]
  stop: () => void
}> {
  const caller = appRouter.createCaller({
    db: h.slayDb,
    dataRoot: '',
    ...(principal
      ? { principal: { userId: principal.userId, role: 'user', orgId: null, scopes: ['full'] } }
      : {})
  } as never)
  const events: StateEvent[] = []
  const obs = (await caller.pty.onStateChange()) as unknown as {
    subscribe: (o: { next: (v: StateEvent) => void }) => { unsubscribe: () => void }
  }
  const sub = obs.subscribe({ next: (v) => events.push(v) })
  return { events, stop: () => sub.unsubscribe() }
}

function seedTask(ownerUserId: string | null): string {
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)')
    .run(projectId, `P-${projectId.slice(0, 4)}`, '#000', ownerUserId)
  const taskId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(taskId, projectId, 'T', 'inbox', 3, 0)
  return taskId
}

describe('chat agent state on pty.onStateChange', () => {
  test('a chat transition is delivered with the chat session id, same shape as a pty one', async () => {
    const taskId = seedTask(null)
    const tabId = 'chat-tab-1'
    const sub = await subscribe()
    await runOneTurn(taskId, tabId)
    sub.stop()

    const sessionId = `${taskId}:${tabId}`
    expect(sub.events.length).toBeGreaterThan(0)
    expect(sub.events.every((e) => e.sessionId === sessionId)).toBe(true)
    // Exactly the three fields a pty transition carries.
    expect(Object.keys(sub.events[0]).sort()).toEqual(['newState', 'oldState', 'sessionId'])
    const pairs = sub.events.map((e) => `${e.oldState}->${e.newState}`)
    // First start: the not-yet-spawned tab had no process, which a client reads as
    // `dead` (TerminalState has no `not-spawned`).
    expect(pairs[0]).toBe('dead->starting')
    expect(pairs).toContain('starting->idle')
    expect(pairs).toContain('idle->running')
    expect(pairs).toContain('running->idle')
    // Every state a client receives is a TerminalState.
    const terminalStates = ['starting', 'running', 'background', 'idle', 'error', 'dead']
    for (const e of sub.events) {
      expect(terminalStates).toContain(e.newState)
      expect(terminalStates).toContain(e.oldState)
    }
  })

  test('with login, the owner gate cuts chat transitions to the task owner', async () => {
    setAuthGate(() => true)
    try {
      const taskId = seedTask('owner-a')
      const owner = await subscribe({ userId: 'owner-a' })
      const stranger = await subscribe({ userId: 'stranger-b' })
      await runOneTurn(taskId, 'chat-tab-2')
      // Decisions are async (an access lookup per session); let them land.
      await new Promise((r) => setTimeout(r, 50))
      owner.stop()
      stranger.stop()

      expect(owner.events.length).toBeGreaterThan(0)
      expect(owner.events.every((e) => e.sessionId === `${taskId}:chat-tab-2`)).toBe(true)
      expect(stranger.events).toEqual([])
    } finally {
      setAuthGate(() => false)
    }
  })
})
