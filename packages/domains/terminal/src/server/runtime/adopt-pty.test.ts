/**
 * Tests for createPty's warm-shell adoption branch (`opts.adoptPty`). Verifies that an
 * already-spawned shell is registered under the real sessionId WITHOUT a fresh spawn, that
 * the task-scoped env is exported and the agent exec'd via the post-spawn write, and that
 * the warm scrollback seeds the RingBuffer. Uses a fake pty + fake window + stub db — no
 * real shell spawns.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import type { PtySessionWindow } from '../pty-host'
import type { IPty } from 'node-pty'
import type { SlayzoneDb } from '@slayzone/platform'
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
    resize() {}
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
