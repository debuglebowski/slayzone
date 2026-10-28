/**
 * Tests for createPty's warm adoption branch (`opts.adoptPty`). Verifies that a warm
 * agent already running ON A COMPUTER is registered under the real sessionId WITHOUT a
 * fresh spawn, that the task-scoped env is exported and the agent exec'd via the
 * post-spawn write, and that the warm scrollback reaches the RingBuffer.
 *
 * Adoption is a REKEY on the computer (`pty.warmAdopt`), reached through
 * `PtyBackend.adopt`, so the fake backend below stands in for the routing one and
 * replays the warm scrollback the way a real computer does: as the first chunk on the
 * adopted session's ordinary data path. Fake pty + fake window + stub db — nothing
 * spawns anywhere.
 */
import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { PtySessionWindow } from '../pty-host'
import type { SlayzoneDb, BatchOp } from '@slayzone/platform'
import { createPty, hasPty, getBuffer, killPty, setDatabase } from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'

interface FakePty {
  pid: number
  process: string
  written: string[]
  resized: [number, number][]
  spawnedFresh: boolean
  onData: (cb: (d: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  write: (s: string) => void
  kill: (sig?: string) => void
  resize: (c: number, r: number) => void
}
function makeFakePty(): FakePty {
  return {
    pid: 4242,
    process: 'zsh',
    written: [],
    resized: [],
    spawnedFresh: false,
    onData() {
      return { dispose() {} }
    },
    onExit() {
      return { dispose() {} }
    },
    write(s) {
      this.written.push(s)
    },
    kill() {},
    resize(c, r) {
      this.resized.push([c, r])
    }
  }
}

// Minimal BrowserWindow stub — createPty only calls isDestroyed() + webContents.send().
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} }
} as unknown as PtySessionWindow

// Stub db: buildMcpEnv resolves the project from the task row.
const stubDb = {
  get: async () => ({ project_id: 'proj-1' })
} as unknown as SlayzoneDb

setDatabase(stubDb, createFakeTaskSessionStore())

/**
 * Stands in for the routing backend. `adopt` hands back the fake pty (the computer's
 * process, rekeyed) and replays `warmScrollback` through its onData, which is how a
 * real computer delivers everything the agent emitted while warm.
 */
let warmScrollback = ''
const adoptCalls: Array<{ computerId: string; warmId: string; sessionId: string }> = []
function installFakeBackend(fake: FakePty): void {
  setPtyBackend({
    spawn() {
      fake.spawnedFresh = true
      throw new Error('adoption must not cold-spawn')
    },
    async adopt(computerId: string, warmId: string, sessionId: string) {
      adoptCalls.push({ computerId, warmId, sessionId })
      const dataCbs: Array<(d: string) => void> = []
      const handle = {
        ...fake,
        onData(cb: (d: string) => void) {
          dataCbs.push(cb)
          // The seed arrives as the FIRST chunk on the normal data path (one
          // contiguous chunk), not as a side-channel buffer append.
          if (warmScrollback) queueMicrotask(() => cb(warmScrollback))
          return { dispose() {} }
        },
        write: (str: string) => fake.write(str),
        resize: (c: number, r: number) => fake.resize(c, r),
        kill: () => fake.kill()
      }
      return handle as unknown as Awaited<ReturnType<NonNullable<PtyBackend['adopt']>>>
    }
  } as unknown as PtyBackend)
}

test('adopt: registers the provided pty without a fresh spawn', async () => {
  const fake = makeFakePty()
  installFakeBackend(fake)
  const sessionId = 'taskA:taskA'
  const res = await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-1',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  expect(res.success, `createPty failed: ${res.error}`).toBe(true)
  expect(hasPty(sessionId), 'session not registered under real id').toBeTruthy()
  killPty(sessionId)
})

test('adopt: exports task identity then execs the agent', async () => {
  const fake = makeFakePty()
  installFakeBackend(fake)
  const sessionId = 'taskB:taskB'
  await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-2',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  const cmd = fake.written.join('')
  expect(cmd, `no task-id export in: ${cmd}`).toContain('export SLAYZONE_TASK_ID=')
  expect(cmd, `task id not exported: ${cmd}`).toContain('taskB')
  expect(cmd, `no project-id export in: ${cmd}`).toContain('SLAYZONE_PROJECT_ID=')
  expect(cmd, `no exec in: ${cmd}`).toContain('exec ')
  expect(cmd, `agent binary missing: ${cmd}`).toContain('claude')
  expect(cmd, `conversation id missing: ${cmd}`).toContain('conv-2')
  // export must come before exec (env set before the shell is replaced)
  expect(cmd.indexOf('export SLAYZONE_TASK_ID='), `export must precede exec: ${cmd}`).toBeLessThan(
    cmd.indexOf('exec ')
  )
  killPty(sessionId)
})

test('adopt: warm scrollback reaches the RingBuffer via the data path', async () => {
  const fake = makeFakePty()
  installFakeBackend(fake)
  // Delivered BY THE COMPUTER in the adopt reply, then emitted on this session's
  // ordinary onData — so it lands in the buffer through `filterBufferData` exactly
  // like live output, rather than being appended as a separate seed.
  warmScrollback = 'WARM-PROMPT$ '
  const sessionId = 'taskC:taskC'
  await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-3',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  // onData is registered during createPty; the replay is queued as a microtask.
  await new Promise((r) => setTimeout(r, 10))
  const buf = getBuffer(sessionId) ?? ''
  expect(buf, `warm scrollback not in buffer: ${JSON.stringify(buf)}`).toContain('WARM-PROMPT$ ')
  warmScrollback = ''
  killPty(sessionId)
})

test("adopt: resizes the warm pty to the tab's real dimensions", async () => {
  // The warm pool spawns the shell with no cols/rows (placeholder 80x24) — adoption
  // must apply the tab's actual requested size, or the already-running agent's
  // first paint is laid out for the wrong terminal size.
  const fake = makeFakePty()
  installFakeBackend(fake)
  const sessionId = 'taskE:taskE'
  await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-5',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    cols: 217,
    rows: 53,
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  expect(
    fake.resized.some(([c, r]) => c === 217 && r === 53),
    `pty not resized to requested dims: ${JSON.stringify(fake.resized)}`
  ).toBe(true)
  killPty(sessionId)
})

test('adopt: resizes to the 80x24 default when the tab requests no explicit size', async () => {
  const fake = makeFakePty()
  installFakeBackend(fake)
  const sessionId = 'taskF:taskF'
  await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-6',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  expect(
    fake.resized.some(([c, r]) => c === 80 && r === 24),
    `pty not resized to default dims: ${JSON.stringify(fake.resized)}`
  ).toBe(true)
  killPty(sessionId)
})

test('adopt preWarmedAgent: no double-exec, sends prompt, binds the pooled session (B4)', async () => {
  // Real in-memory db backs the spawn's reads; the bind goes through the task store.
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, cwd TEXT, task_id TEXT, conversation_id TEXT,
      origin TEXT NOT NULL, status TEXT NOT NULL, pending_meta TEXT, created_at INTEGER NOT NULL,
      bound_at INTEGER, tab_id TEXT, ended_at INTEGER);
  `)
  raw.prepare("INSERT INTO tasks (id, project_id) VALUES ('taskD','proj-1')").run()
  // A pre-warmed pooled agent already confirmed its conversation id.
  raw
    .prepare(
      `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at)
       VALUES ('poolS','claude-code','/tmp',NULL,'convPool','slay-spawned-fresh','pooled',0)`
    )
    .run()
  const realDb = {
    get: async (sql: string, p: unknown[] = []) => raw.prepare(sql).get(...p),
    all: async (sql: string, p: unknown[] = []) => raw.prepare(sql).all(...p),
    run: async (sql: string, p: unknown[] = []) => {
      const r = raw.prepare(sql).run(...p)
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    },
    batchTxn: async (ops: BatchOp[]) =>
      raw.transaction(() => ops.map((o) => raw.prepare(o.sql)[o.type](...o.params)))()
  } as unknown as SlayzoneDb
  // Task's ledger store is a fake (terminal cannot import task): the bind is
  // asserted as the call terminal makes; its SQL is covered by task's op tests.
  const taskStore = createFakeTaskSessionStore()
  setDatabase(realDb, taskStore)
  try {
    const fake = makeFakePty()
    installFakeBackend(fake)
    installFakeBackend(fake)
    const sessionId = 'taskD:taskD'
    await createPty({
      win: fakeWin,
      sessionId,
      taskId: 'taskD',
      tabId: 'taskD',
      cwd: '/tmp',
      mode: 'claude-code',
      type: 'claude-code',
      initialCommand: 'claude --session-id {id} {flags}',
      defaultFlags: '--x',
      initialPrompt: 'HELLO-PROMPT',
      cols: 180,
      rows: 45,
      adoptPty: {
        warmId: 'warm-D',
        computerId: 'computer-1',
        preWarmedAgent: true,
        sessionId: 'poolS',
        conversationId: 'convPool'
      }
    })
    expect(
      fake.resized.some(([c, r]) => c === 180 && r === 45),
      `pre-warmed adoption did not resize to real dims: ${JSON.stringify(fake.resized)}`
    ).toBe(true)
    const cmd = fake.written.join('')
    // The agent is already running — it must NOT receive an exec/export (that
    // would be typed into its live TUI as input).
    expect(cmd, `pre-warmed agent must not be re-exec'd: ${JSON.stringify(cmd)}`).not.toContain(
      'exec '
    )
    expect(cmd, `pre-warmed agent must not be re-exec'd: ${JSON.stringify(cmd)}`).not.toContain(
      'export SLAYZONE_TASK_ID'
    )
    // The task's initial prompt is sent to the live agent.
    expect(cmd, `initial prompt not sent: ${JSON.stringify(cmd)}`).toContain('HELLO-PROMPT')
    // The pooled session entity was bound to the task (set-once), on the ledger db.
    const binds = taskStore.calls.filter((c) => c.method === 'bindSessionToTask')
    expect(binds.length, `pooled session not bound: ${JSON.stringify(binds)}`).toBe(1)
    expect(binds[0].db).toBe(realDb)
    expect(binds[0].args).toEqual({ sessionId: 'poolS', taskId: 'taskD', tabId: 'taskD' })
    killPty(sessionId)
  } finally {
    setDatabase(stubDb, createFakeTaskSessionStore())
    raw.close()
  }
})
