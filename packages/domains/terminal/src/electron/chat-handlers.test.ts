/**
 * Integration test for chat:reset IPC handler.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/domains/terminal/src/main/chat-handlers.test.ts
 *
 * Uses Electron's bundled Node so better-sqlite3's native module matches. Wires
 * registerChatHandlers against a mock ipcMain + in-memory sqlite + faked transport
 * spawn, then drives the `chat:reset` channel end-to-end. Asserts the three
 * properties that make reset correct:
 *   - new spawn does NOT use --resume (ignores stored chatConversationId)
 *   - DB chatConversationId is cleared
 *   - persisted chat_events for the tab are wiped
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import { registerChatHandlers } from './chat-handlers'
import * as mgr from './chat-transport-manager'
import { persistChatEvent } from '../server/chat-events-store'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T): void {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy(): void {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
    toBeFalsy(): void {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`)
    },
  }
}

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
    kill: () => true,
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
    },
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      provider_config TEXT
    );
    CREATE TABLE terminal_modes (
      id TEXT PRIMARY KEY,
      default_flags TEXT
    );
    CREATE TABLE chat_events (
      tab_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (tab_id, seq)
    );
  `)
  return db
}

console.log('\nchat:reset IPC handler tests\n')

await test(
  'chat:reset spawns fresh (no --resume) even when DB has stored chatConversationId',
  async () => {
    mgr.__resetForTests()
    mgr.resetTransportDeps()

    const db = setupDb()
    const taskId = 'task-reset-1'
    const tabId = 'tab-reset-1'
    const mode = 'claude-code'

    db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
      taskId,
      JSON.stringify({ [mode]: { chatConversationId: 'old-stored-sid' } })
    )

    const spawnArgsLog: string[][] = []
    mgr.setTransportDepsForTests({
      whichBinary: async () => '/fake/claude',
      spawn: (_cmd, args) => {
        spawnArgsLog.push(args)
        return makeFakeChild()
      },
      broadcastEvent: () => {},
      broadcastExit: () => {},
      broadcastStateChange: () => {},
    })

    const ipc = createMockIpcMain()
    registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

    // Pre-seed: an initial create that DOES --resume the stored id (mirrors what
    // chat:create would do today on tab reopen).
    await ipc.invoke('chat:create', {
      tabId,
      taskId,
      mode,
      cwd: '/tmp',
      providerFlagsOverride: null,
    })
    expect(spawnArgsLog.length).toBe(1)
    expect(spawnArgsLog[0].includes('--resume')).toBeTruthy()

    // Persist some chat events for this tab.
    persistChatEvent(db, tabId, 0, { kind: 'turn-init', sessionId: 'old-stored-sid', model: 'opus', cwd: '/tmp', tools: [] })
    persistChatEvent(db, tabId, 1, { kind: 'assistant-text', messageId: 'm', text: 'hi' })
    const evCountBefore = db
      .prepare('SELECT COUNT(*) AS c FROM chat_events WHERE tab_id = ?')
      .get(tabId) as { c: number }
    expect(evCountBefore.c).toBe(2)

    // Now reset.
    const info = (await ipc.invoke('chat:reset', {
      tabId,
      taskId,
      mode,
      cwd: '/tmp',
      providerFlagsOverride: null,
    })) as { sessionId: string }

    // Spawn called again, this time WITHOUT --resume.
    expect(spawnArgsLog.length).toBe(2)
    expect(spawnArgsLog[1].includes('--resume')).toBeFalsy()
    expect(spawnArgsLog[1].includes('--session-id')).toBeTruthy()

    // Returned session info has a fresh sessionId, not the stored one.
    expect(info.sessionId === 'old-stored-sid').toBe(false)

    // DB chatConversationId is cleared (so future creates don't re-resume).
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
  }
)

await test('chat:reset still wipes events + clears conv id when no live session exists', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()

  const db = setupDb()
  const taskId = 'task-reset-2'
  const tabId = 'tab-reset-2'
  const mode = 'claude-code'

  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
    taskId,
    JSON.stringify({ [mode]: { chatConversationId: 'stale-sid' } })
  )
  persistChatEvent(db, tabId, 0, { kind: 'turn-init', sessionId: 'stale-sid', model: 'opus', cwd: '/tmp', tools: [] })

  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => makeFakeChild(),
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  // Reset on a tab whose session is NOT in the in-memory map (e.g. after app restart
  // before any panel mount). Must not throw; must still clear DB state and spawn fresh.
  await ipc.invoke('chat:reset', {
    tabId,
    taskId,
    mode,
    cwd: '/tmp',
    providerFlagsOverride: null,
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

console.log('\nchat:setModel / chat:getModel IPC handler tests\n')

await test('chat:getModel falls back to account default (or DEFAULT_CHAT_MODEL=opus) when nothing stored', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-1'
  const mode = 'claude-code'
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(taskId, null)

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  // Resolution reads `~/.claude/settings.json` on the host. Result is one of
  // the three concrete aliases — never `'default'`. We assert the union, not
  // a specific value, so the test stays portable across machines.
  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(['opus', 'sonnet', 'haiku'].includes(got)).toBe(true)
})

await test('chat:getModel returns stored value', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-2'
  const mode = 'claude-code'
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
    taskId,
    JSON.stringify({ [mode]: { chatModel: 'opus' } })
  )

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(got).toBe('opus')
})

await test('chat:getModel falls back to account default for unknown / legacy stored value', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-3'
  const mode = 'claude-code'
  // Includes legacy `'default'` from before the option was removed — must
  // coerce to a concrete model rather than echo back.
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
    taskId,
    JSON.stringify({ [mode]: { chatModel: 'default' } })
  )

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  const got = (await ipc.invoke('chat:getModel', taskId, mode)) as string
  expect(['opus', 'sonnet', 'haiku'].includes(got)).toBe(true)
})

await test('chat:setModel persists to provider_config + respawns with --model flag', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-4'
  const tabId = 'tab-model-4'
  const mode = 'claude-code'
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(taskId, null)

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => { spawnArgsLog.push(args); return makeFakeChild() },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  // Initial create — no model stored. We always emit --model now, picking
  // the account default from `~/.claude/settings.json` (or DEFAULT_CHAT_MODEL).
  await ipc.invoke('chat:create', { tabId, taskId, mode, cwd: '/tmp', providerFlagsOverride: null })
  expect(spawnArgsLog.length).toBe(1)
  const firstIdx = spawnArgsLog[0].indexOf('--model')
  expect(firstIdx >= 0).toBe(true)
  expect(['opus', 'sonnet', 'haiku'].includes(spawnArgsLog[0][firstIdx + 1])).toBe(true)

  // setModel → kill+respawn with --model sonnet.
  await ipc.invoke('chat:setModel', { tabId, taskId, mode, cwd: '/tmp', chatModel: 'sonnet' })
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

await test('chat:setModel rejects invalid model id', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-5'
  const tabId = 'tab-model-5'
  const mode = 'claude-code'
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(taskId, null)

  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => makeFakeChild(),
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  let threw = false
  try {
    await ipc.invoke('chat:setModel', { tabId, taskId, mode, cwd: '/tmp', chatModel: 'gpt-5' })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
})

await test('chat:create reads stored chatModel and adds --model on cold spawn', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-6'
  const tabId = 'tab-model-6'
  const mode = 'claude-code'
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
    taskId,
    JSON.stringify({ [mode]: { chatModel: 'haiku' } })
  )

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => { spawnArgsLog.push(args); return makeFakeChild() },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  await ipc.invoke('chat:create', { tabId, taskId, mode, cwd: '/tmp', providerFlagsOverride: null })
  expect(spawnArgsLog.length).toBe(1)
  const args = spawnArgsLog[0]
  const idx = args.indexOf('--model')
  expect(idx >= 0).toBe(true)
  expect(args[idx + 1]).toBe('haiku')
})

await test('explicit providerFlagsOverride suppresses --model injection', async () => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db = setupDb()
  const taskId = 'task-model-7'
  const tabId = 'tab-model-7'
  const mode = 'claude-code'
  // Stored chatModel = sonnet; override should still win.
  db.prepare('INSERT INTO tasks (id, provider_config) VALUES (?, ?)').run(
    taskId,
    JSON.stringify({ [mode]: { chatModel: 'sonnet' } })
  )

  const spawnArgsLog: string[][] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => { spawnArgsLog.push(args); return makeFakeChild() },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
  })

  const ipc = createMockIpcMain()
  registerChatHandlers(ipc as unknown as Parameters<typeof registerChatHandlers>[0], db)

  await ipc.invoke('chat:create', {
    tabId, taskId, mode, cwd: '/tmp',
    providerFlagsOverride: '--allow-dangerously-skip-permissions',
  })
  expect(spawnArgsLog.length).toBe(1)
  expect(spawnArgsLog[0].includes('--model')).toBeFalsy()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
