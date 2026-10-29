/**
 * Integration test for chat:reset IPC handler.
 *
 * Uses Electron's bundled Node so better-sqlite3's native module matches. Wires
 * registerChatHandlers against a mock ipcMain + createTestHarness's migrated
 * in-memory sqlite + faked transport
 * spawn, then drives the `chat:reset` channel end-to-end. Asserts the three
 * properties that make reset correct:
 *   - new spawn does NOT use --resume (ignores stored chatConversationId)
 *   - DB chatConversationId is cleared
 *   - persisted chat_events for the tab are wiped
 */
import { expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type Database from 'better-sqlite3'
import { createChatOps, registerChatHandlers } from './chat-handlers'
import { createDbChatDataOps } from './chat-data-ops'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import * as mgr from './chat-transport-manager'
import { persistChatEvent } from '../chat-events-store'
import {
  createSlayzoneDbAdapter,
  createTestHarness
} from '../../../../../shared/test-utils/ipc-harness.js'

function makeFakeChild(): ChildProcess {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = { write: () => true }
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    kill: () => true
  }) as unknown as ChildProcess
}

interface MockIpcMain {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

function createMockIpcMain(): MockIpcMain {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for ${channel}`)
      // chat-handlers register(_, ...args) — pass null event placeholder.
      return handler(null, ...args)
    }
  }
}

/** The composition root's local-DB chat data ops; task's ledger store is a fake
 * (terminal tests cannot import the task package). */
function localChatOpts(db: Database.Database) {
  return {
    dataOps: createDbChatDataOps(createSlayzoneDbAdapter(db), createFakeTaskSessionStore())
  }
}

/** Real migrated schema (FK pragmas on) — the handlers read projects/tasks/
 * terminal_tabs/chat_events/chat_queue, so fixtures go through the full chain. */
async function setupDb(): Promise<Database.Database> {
  return (await createTestHarness()).db
}

function seedTask(
  db: Database.Database,
  taskId: string,
  providerConfig: string | null,
  tabId?: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, color) VALUES ('proj-1', 'P', '#000')"
  ).run()
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?, 'proj-1', 'T', ?)"
  ).run(taskId, providerConfig ?? '{}')
  if (tabId) {
    db.prepare(
      "INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, 'claude-chat', 0)"
    ).run(tabId, taskId)
  }
}

test('chat:reset spawns fresh (no --resume) even when DB has stored chatConversationId', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()

  const db = await setupDb()
  const taskId = 'task-reset-1'
  const tabId = 'tab-reset-1'
  const mode = 'claude-chat'

  seedTask(db, taskId, JSON.stringify({ [mode]: { chatConversationId: 'old-stored-sid' } }), tabId)

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      spawnArgsLog.push(args)
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  // Pre-seed: eager start that DOES --resume the stored id (mirrors what
  // happens when the user explicitly clicks Restart, or sends their first
  // message in a tab with a stored conversationId).
  await ipc.invoke('chat:start', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnArgsLog.length).toBe(1)
  expect(spawnArgsLog[0].includes('--resume')).toBeTruthy()

  // Persist some chat events for this tab.
  await persistChatEvent(createSlayzoneDbAdapter(db), tabId, 0, {
    kind: 'turn-init',
    sessionId: 'old-stored-sid',
    model: 'opus',
    cwd: '/tmp',
    tools: []
  })
  await persistChatEvent(createSlayzoneDbAdapter(db), tabId, 1, {
    kind: 'assistant-text',
    messageId: 'm',
    text: 'hi'
  })
  const evCountBefore = db
    .prepare('SELECT COUNT(*) AS c FROM chat_events WHERE tab_id = ?')
    .get(tabId) as { c: number }
  expect(evCountBefore.c).toBe(2)

  // Now reset. Reset is lazy — wipes DB + skeleton-only; does NOT spawn.
  const resetInfo = (await ipc.invoke('chat:reset', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })) as { sessionId: string; pid: number | null; ended: boolean }

  // Reset does NOT trigger a fresh spawn — still 1 spawn (the pre-seed).
  expect(spawnArgsLog.length).toBe(1)
  // Skeleton returned: no live pid, ended sentinel still false (skeleton, not exited).
  expect(resetInfo.pid).toBe(null)

  // Explicit eager start triggers the spawn. THIS spawn is fresh (no --resume).
  const info = (await ipc.invoke('chat:start', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })) as { sessionId: string }
  expect(spawnArgsLog.length).toBe(2)
  expect(spawnArgsLog[1].includes('--resume')).toBeFalsy()
  expect(spawnArgsLog[1].includes('--session-id')).toBeTruthy()

  // Returned session info has a fresh sessionId, not the stored one.
  expect(info.sessionId === 'old-stored-sid').toBe(false)

  // DB chatConversationId is cleared (so future hydrate/start don't re-resume).
  const cfgRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
    | { provider_config: string }
    | undefined
  const cfg = JSON.parse(cfgRow!.provider_config) as Record<
    string,
    { chatConversationId?: string | null }
  >
  expect(cfg[mode]?.chatConversationId).toBe(null)

  // Persisted events for this tab are wiped.
  const evCountAfter = db
    .prepare('SELECT COUNT(*) AS c FROM chat_events WHERE tab_id = ?')
    .get(tabId) as { c: number }
  expect(evCountAfter.c).toBe(0)
})

test('chat:reset still wipes events + clears conv id when no live session exists', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()

  const db = await setupDb()
  const taskId = 'task-reset-2'
  const tabId = 'tab-reset-2'
  const mode = 'claude-chat'

  seedTask(db, taskId, JSON.stringify({ [mode]: { chatConversationId: 'stale-sid' } }), tabId)
  await persistChatEvent(createSlayzoneDbAdapter(db), tabId, 0, {
    kind: 'turn-init',
    sessionId: 'stale-sid',
    model: 'opus',
    cwd: '/tmp',
    tools: []
  })

  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => makeFakeChild(),
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  // Reset on a tab whose session is NOT in the in-memory map (e.g. after app restart
  // before any panel mount). Must not throw; must still clear DB state. Reset is
  // lazy now, so no spawn happens.
  await ipc.invoke('chat:reset', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })

  const cfgRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as {
    provider_config: string
  }
  const cfg = JSON.parse(cfgRow.provider_config) as Record<
    string,
    { chatConversationId?: string | null }
  >
  expect(cfg[mode]?.chatConversationId).toBe(null)

  const evCount = db
    .prepare('SELECT COUNT(*) AS c FROM chat_events WHERE tab_id = ?')
    .get(tabId) as { c: number }
  expect(evCount.c).toBe(0)
})

test('chat:getModel falls back to account default (or DEFAULT_CHAT_MODEL=opus) when nothing stored', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-1'
  const mode = 'claude-chat'
  seedTask(db, taskId, null)

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  // Resolution reads `~/.claude/settings.json` on the host. Result is one of
  // the three concrete aliases — never `'default'`. We assert the union, not
  // a specific value, so the test stays portable across machines.
  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(['opus', 'sonnet', 'haiku'].includes(got)).toBe(true)
})

test('chat:getModel returns stored value', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-2'
  const mode = 'claude-chat'
  seedTask(db, taskId, JSON.stringify({ [mode]: { chatModel: 'opus' } }))

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(got).toBe('opus')
})

test('chat:getModel falls back to account default for unknown / legacy stored value', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-3'
  const mode = 'claude-chat'
  // Includes legacy `'default'` from before the option was removed — must
  // coerce to a concrete model rather than echo back.
  seedTask(db, taskId, JSON.stringify({ [mode]: { chatModel: 'default' } }))

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(['opus', 'sonnet', 'haiku'].includes(got)).toBe(true)
})

test('chat:setModel persists to provider_config + respawns with --model flag', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-4'
  const tabId = 'tab-model-4'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      spawnArgsLog.push(args)
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  // Initial eager start — no model stored. We always emit --model now, picking
  // the account default from `~/.claude/settings.json` (or DEFAULT_CHAT_MODEL).
  await ipc.invoke('chat:start', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnArgsLog.length).toBe(1)
  const firstIdx = spawnArgsLog[0].indexOf('--model')
  expect(firstIdx >= 0).toBe(true)
  expect(['opus', 'sonnet', 'haiku'].includes(spawnArgsLog[0][firstIdx + 1])).toBe(true)

  // setModel → kill+respawn with --model sonnet.
  await ipc.invoke('chat:setModel', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    chatModel: 'sonnet'
  })
  expect(spawnArgsLog.length).toBe(2)
  const second = spawnArgsLog[1]
  const idx = second.indexOf('--model')
  expect(idx >= 0).toBe(true)
  expect(second[idx + 1]).toBe('sonnet')

  // DB persisted.
  const cfgRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
    | { provider_config: string }
    | undefined
  const cfg = JSON.parse(cfgRow!.provider_config) as Record<string, { chatModel?: string }>
  expect(cfg[mode]?.chatModel).toBe('sonnet')
})

test('chat:setModel rejects invalid model id', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-5'
  const tabId = 'tab-model-5'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => makeFakeChild(),
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  let threw = false
  try {
    await ipc.invoke('chat:setModel', {
      tabId,
      taskId,
      mode,
      cwd: '/tmp',
      chatModel: 'gpt-5'
    })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
})

test('chat:start reads stored chatModel and adds --model on cold spawn', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-6'
  const tabId = 'tab-model-6'
  const mode = 'claude-chat'
  seedTask(db, taskId, JSON.stringify({ [mode]: { chatModel: 'haiku' } }), tabId)

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      spawnArgsLog.push(args)
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  await ipc.invoke('chat:start', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnArgsLog.length).toBe(1)
  const args = spawnArgsLog[0]
  const idx = args.indexOf('--model')
  expect(idx >= 0).toBe(true)
  expect(args[idx + 1]).toBe('haiku')
})

test('explicit providerFlagsOverride suppresses --model injection', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-model-7'
  const tabId = 'tab-model-7'
  const mode = 'claude-chat'
  // Stored chatModel = sonnet; override should still win.
  seedTask(db, taskId, JSON.stringify({ [mode]: { chatModel: 'sonnet' } }), tabId)

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      spawnArgsLog.push(args)
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  await ipc.invoke('chat:start', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: '--allow-dangerously-skip-permissions'
  })
  expect(spawnArgsLog.length).toBe(1)
  expect(spawnArgsLog[0].includes('--model')).toBeFalsy()
})

test('chat:hydrate does NOT spawn a subprocess', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-lazy-1'
  const tabId = 'tab-lazy-1'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  const spawnCount = { n: 0 }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount.n++
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  const info = (await ipc.invoke('chat:hydrate', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })) as { pid: number | null; ended: boolean }

  // Hydrate returns a skeleton: no live pid, ended is false (skeleton, not exited).
  expect(spawnCount.n).toBe(0)
  expect(info.pid).toBe(null)
})

test('chat:send triggers lazy spawn on a hydrated session', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-lazy-2'
  const tabId = 'tab-lazy-2'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  const spawnCount = { n: 0 }
  let lastChild: ChildProcess | null = null
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount.n++
      lastChild = makeFakeChild()
      return lastChild
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  await ipc.invoke('chat:hydrate', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnCount.n).toBe(0)

  // Capture the kernel-spawn signal that promotes 'starting' → 'idle'. Fired
  // synchronously by ensureSpawned after wiring handlers; we re-emit here so
  // the spawned-flag check is meaningful (the fake spawn never auto-fires).
  const sent = (await ipc.invoke('chat:send', tabId, 'hello')) as boolean
  expect(spawnCount.n).toBe(1)
  expect(sent).toBe(true)
})

test('chat:hydrate twice is idempotent — only one skeleton, zero spawns', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-lazy-3'
  const tabId = 'tab-lazy-3'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  const spawnCount = { n: 0 }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount.n++
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  await ipc.invoke('chat:hydrate', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  await ipc.invoke('chat:hydrate', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnCount.n).toBe(0)
})

test('chat:reset wipes DB and leaves the new session lazy (no spawn)', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-lazy-4'
  const tabId = 'tab-lazy-4'
  const mode = 'claude-chat'
  seedTask(db, taskId, JSON.stringify({ [mode]: { chatConversationId: 'old-sid' } }), tabId)
  await persistChatEvent(createSlayzoneDbAdapter(db), tabId, 0, {
    kind: 'turn-init',
    sessionId: 'old-sid',
    model: 'opus',
    cwd: '/tmp',
    tools: []
  })

  const spawnCount = { n: 0 }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount.n++
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  await ipc.invoke('chat:reset', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })

  // No spawn on reset.
  expect(spawnCount.n).toBe(0)
  // Persisted history wiped.
  const ev = db.prepare('SELECT COUNT(*) AS c FROM chat_events WHERE tab_id = ?').get(tabId) as {
    c: number
  }
  expect(ev.c).toBe(0)
  // Conversation id cleared.
  const cfgRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as {
    provider_config: string
  }
  const cfg = JSON.parse(cfgRow.provider_config) as Record<
    string,
    { chatConversationId?: string | null }
  >
  expect(cfg[mode]?.chatConversationId).toBe(null)
})

test('chat:setMode pre-spawn persists DB without spawning', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  const taskId = 'task-lazy-5'
  const tabId = 'tab-lazy-5'
  const mode = 'claude-chat'
  seedTask(db, taskId, null, tabId)

  const spawnCount = { n: 0 }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount.n++
      return makeFakeChild()
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(
    ipc as unknown as Parameters<typeof registerChatHandlers>[0],
    createSlayzoneDbAdapter(db),
    localChatOpts(db)
  )

  // Hydrate skeleton.
  await ipc.invoke('chat:hydrate', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  expect(spawnCount.n).toBe(0)

  // setMode on a not-spawned skeleton: DB write only, no respawn.
  await ipc.invoke('chat:setMode', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    chatMode: 'plan'
  })
  expect(spawnCount.n).toBe(0)

  const cfgRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as {
    provider_config: string
  }
  const cfg = JSON.parse(cfgRow.provider_config) as Record<string, { chatMode?: string }>
  expect(cfg[mode]?.chatMode).toBe('plan')
})

/** Poll until `read()` returns a non-null value (persistEvent side effects are fire-and-forget). */
async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 2000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await read()
    if (v !== null || Date.now() > deadline) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a turn-init slash command list is stored for the project and served before the next spawn', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  seedTask(db, 'task-cli-1', null, 'tab-cli-1')
  // Second task of the same project, no session of its own yet.
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, provider_config) VALUES ('task-cli-2', 'proj-1', 'T2', '{}')"
  ).run()

  const child = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => child,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  const ops = createChatOps(localChatOpts(db))
  const opts = { tabId: 'tab-cli-1', taskId: 'task-cli-1', mode: 'claude-chat', cwd: '/tmp' }
  expect(await ops.getCliSnapshot('task-cli-2', 'claude-chat')).toBeNull()

  const info = await ops.start({ ...opts, providerFlagsOverride: null })
  ;(child as unknown as EventEmitter).emit('spawn')
  ;(child.stdout as PassThrough).write(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: info.sessionId,
      model: 'opus',
      cwd: '/tmp',
      tools: [],
      slash_commands: ['compact', 'context', 'doctor'],
      terminal_slash_commands: ['doctor'],
      skills: [],
      claude_code_version: '2.1.312'
    }) + '\n'
  )

  expect(await eventually(() => ops.getCliSnapshot('task-cli-2', 'claude-chat'))).toEqual({
    slashCommands: ['compact', 'context', 'doctor'],
    terminalSlashCommands: ['doctor'],
    skills: [],
    cliVersion: '2.1.312'
  })
})

test('onChatEvent receives the task, mode and conversation of the event', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = await setupDb()
  seedTask(db, 'task-ctx-1', null, 'tab-ctx-1')
  const child = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => child,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  const seen: Array<{ kind: string; ctx: unknown }> = []
  const ops = createChatOps({
    ...localChatOpts(db),
    onChatEvent: (_tabId, event, ctx) => {
      seen.push({ kind: event.kind, ctx })
    }
  })
  const info = await ops.start({
    tabId: 'tab-ctx-1',
    taskId: 'task-ctx-1',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlagsOverride: null
  })
  ;(child as unknown as EventEmitter).emit('spawn')
  await ops.send('tab-ctx-1', 'hello there')
  const sent = seen.find((s) => s.kind === 'user-message')
  expect(sent?.ctx).toEqual({
    taskId: 'task-ctx-1',
    mode: 'claude-chat',
    conversationId: info.sessionId
  })
})
