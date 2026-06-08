/**
 * Tests for WarmProcessManager — the per-project warm-shell gate + adopt-match logic.
 * Run under Electron's node (pty-manager pulls in `electron`); a fake spawnShell is
 * injected so no real shells spawn.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import { tmpdir, homedir } from 'node:os'
import type { SlayzoneDb } from '@slayzone/platform'
import type { IPty } from 'node-pty'
import {
  initWarmProcessManager,
  setProjectTabCounts,
  clearWindowTabCounts,
  claimWarmShell,
  getWarmStatus,
  __resetForTests
} from './warm-process-manager'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    __resetForTests()
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
    toBe(expected: T) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`)
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// Past the manager's 150ms reconcile debounce + the async spawn tick.
const settle = (): Promise<void> => wait(240)

interface FakePty {
  killed: boolean
  dataCbs: Array<(d: string) => void>
  written: string[]
  onData: (cb: (d: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  kill: () => void
  write: (s: string) => void
}

let spawnCount = 0
let lastSpawned: FakePty | null = null

function makeFakePty(): FakePty {
  const dataCbs: Array<(d: string) => void> = []
  const obj: FakePty = {
    killed: false,
    dataCbs,
    written: [],
    onData(cb) {
      dataCbs.push(cb)
      return { dispose() {} }
    },
    onExit() {
      return { dispose() {} }
    },
    kill() {
      obj.killed = true
    },
    write(s) {
      obj.written.push(s)
    }
  }
  return obj
}

const fakeSpawn = (() => {
  spawnCount++
  const pty = makeFakePty()
  lastSpawned = pty
  return { pty: pty as unknown as IPty, shell: '/bin/zsh', usedArgs: ['-i', '-l'], usedFallback: false }
}) as unknown as Parameters<typeof initWarmProcessManager>[0]['spawnShell']

let enabled = true
// cwd must exist on disk — spawnWarm guards on existsSync(projectRoot).
const PROJECT_ROOT = tmpdir()
const db = { get: async () => undefined } as unknown as SlayzoneDb

function init(): void {
  spawnCount = 0
  lastSpawned = null
  enabled = true
  initWarmProcessManager({
    db,
    isEnabled: () => enabled,
    getProjectRoot: async () => PROJECT_ROOT,
    spawnShell: fakeSpawn
  })
}

await test('gate 0→1 spawns one warm shell', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(getWarmStatus().p1).toBe('ready')
  expect(spawnCount).toBe(1)
})

await test('count 1→2→1 does not respawn', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  setProjectTabCounts(1, { p1: 2 })
  await settle()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(spawnCount).toBe(1)
})

await test('count →0 kills the warm shell', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const pty = lastSpawned!
  setProjectTabCounts(1, { p1: 0 })
  await settle()
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
  expect(pty.killed).toBe(true)
})

await test('multi-window union keeps warm while any window has the tab', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  setProjectTabCounts(2, { p1: 1 })
  await settle()
  expect(spawnCount).toBe(1)
  // Window 1 closes its tab; window 2 still has it → warm survives.
  setProjectTabCounts(1, {})
  await settle()
  expect(getWarmStatus().p1).toBe('ready')
  // Window 2 also drops → killed.
  clearWindowTabCounts(2)
  await settle()
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
})

await test('disabled flag never spawns', async () => {
  init()
  enabled = false
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(spawnCount).toBe(0)
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
})

await test('captures shell prompt into seedBuffer', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  lastSpawned!.dataCbs.forEach((cb) => cb('user@host % '))
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: false })
  expect(claim?.seedBuffer).toBe('user@host % ')
})

await test('adopt matches: claude-code + project-root cwd + fresh', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const adopted = lastSpawned!
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: false })
  expect((claim?.pty as unknown as FakePty) === adopted).toBe(true)
  // Consumed: removed from the pool, then re-armed immediately (still has an open tab).
  await settle()
  expect(spawnCount).toBe(2)
})

await test('adopt miss: wrong mode', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'codex', cwd: PROJECT_ROOT, resuming: false })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready') // untouched
})

await test('adopt miss: resume', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: true })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready')
})

await test('adopt miss: cwd mismatch (e.g. worktree path)', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: homedir(), resuming: false })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready')
})

await test('adopt miss: no warm for project', async () => {
  init()
  const claim = claimWarmShell({ projectId: 'nope', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: false })
  expect(claim).toBeNull()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
