/**
 * Tests for createPty's warm-shell adoption branch (`opts.adoptPty`). Verifies that an
 * already-spawned shell is registered under the real sessionId WITHOUT a fresh spawn, that
 * the task-scoped env is exported and the agent exec'd via the post-spawn write, and that
 * the warm scrollback seeds the RingBuffer. Uses a fake pty + fake window + stub db — no
 * real shell spawns.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import Database from 'better-sqlite3'
import type { PtySessionWindow } from '../pty-host'
import type { IPty } from 'node-pty'
import type { SlayzoneDb, BatchOp } from '@slayzone/platform'
import { createPty, hasPty, getBuffer, killPty, setDatabase } from './pty-manager'

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

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

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

setDatabase(stubDb)

await test('adopt: registers the provided pty without a fresh spawn', async () => {
  const fake = makeFakePty()
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
    adoptPty: { pty: fake as unknown as IPty, seedBuffer: 'PROMPT$ ' }
  })
  expect(res.success === true, `createPty failed: ${res.error}`)
  expect(hasPty(sessionId), 'session not registered under real id')
  killPty(sessionId)
})

await test('adopt: exports task identity then execs the agent', async () => {
  const fake = makeFakePty()
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
    adoptPty: { pty: fake as unknown as IPty }
  })
  const cmd = fake.written.join('')
  expect(cmd.includes('export SLAYZONE_TASK_ID='), `no task-id export in: ${cmd}`)
  expect(cmd.includes('taskB'), `task id not exported: ${cmd}`)
  expect(cmd.includes('SLAYZONE_PROJECT_ID='), `no project-id export in: ${cmd}`)
  expect(cmd.includes('exec '), `no exec in: ${cmd}`)
  expect(cmd.includes('claude'), `agent binary missing: ${cmd}`)
  expect(cmd.includes('conv-2'), `conversation id missing: ${cmd}`)
  // export must come before exec (env set before the shell is replaced)
  expect(
    cmd.indexOf('export SLAYZONE_TASK_ID=') < cmd.indexOf('exec '),
    `export must precede exec: ${cmd}`
  )
  killPty(sessionId)
})

await test('adopt: seeds the RingBuffer with the warm scrollback', async () => {
  const fake = makeFakePty()
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
    adoptPty: { pty: fake as unknown as IPty, seedBuffer: 'WARM-PROMPT$ ' }
  })
  const buf = getBuffer(sessionId) ?? ''
  expect(buf.includes('WARM-PROMPT$ '), `seed not in buffer: ${JSON.stringify(buf)}`)
  killPty(sessionId)
})

await test('adopt: resizes the warm pty to the tab\'s real dimensions', async () => {
  // The warm pool spawns the shell with no cols/rows (placeholder 80x24) — adoption
  // must apply the tab's actual requested size, or the already-running agent's
  // first paint is laid out for the wrong terminal size.
  const fake = makeFakePty()
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
    adoptPty: { pty: fake as unknown as IPty, seedBuffer: 'PROMPT$ ' }
  })
  expect(
    fake.resized.some(([c, r]) => c === 217 && r === 53),
    `pty not resized to requested dims: ${JSON.stringify(fake.resized)}`
  )
  killPty(sessionId)
})

await test('adopt: resizes to the 80x24 default when the tab requests no explicit size', async () => {
  const fake = makeFakePty()
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
    adoptPty: { pty: fake as unknown as IPty, seedBuffer: 'PROMPT$ ' }
  })
  expect(
    fake.resized.some(([c, r]) => c === 80 && r === 24),
    `pty not resized to default dims: ${JSON.stringify(fake.resized)}`
  )
  killPty(sessionId)
})

await test('adopt preWarmedAgent: no double-exec, sends prompt, binds the pooled session (B4)', async () => {
  // Real in-memory db so we can assert the bind actually happened.
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
  setDatabase(realDb)
  try {
    const fake = makeFakePty()
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
        pty: fake as unknown as IPty,
        preWarmedAgent: true,
        sessionId: 'poolS',
        conversationId: 'convPool'
      }
    })
    expect(
      fake.resized.some(([c, r]) => c === 180 && r === 45),
      `pre-warmed adoption did not resize to real dims: ${JSON.stringify(fake.resized)}`
    )
    const cmd = fake.written.join('')
    // The agent is already running — it must NOT receive an exec/export (that
    // would be typed into its live TUI as input).
    expect(
      !cmd.includes('exec ') && !cmd.includes('export SLAYZONE_TASK_ID'),
      `pre-warmed agent must not be re-exec'd: ${JSON.stringify(cmd)}`
    )
    // The task's initial prompt is sent to the live agent.
    expect(cmd.includes('HELLO-PROMPT'), `initial prompt not sent: ${JSON.stringify(cmd)}`)
    // The pooled session entity was bound to the task (set-once).
    const row = raw
      .prepare("SELECT task_id, status FROM agent_sessions WHERE id = 'poolS'")
      .get() as { task_id: string | null; status: string }
    expect(
      row.task_id === 'taskD' && row.status === 'bound',
      `pooled session not bound: ${JSON.stringify(row)}`
    )
    killPty(sessionId)
  } finally {
    setDatabase(stubDb)
    raw.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
