/**
 * Tests for WarmProcessManager — the per-project warm gate + adopt-match logic.
 * Run under Electron's node (pty-manager pulls in `electron`); a fake PtyBackend is
 * injected so nothing is spawned anywhere — warm agents run on RUNNERS, reached
 * through the backend's warm methods.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import { tmpdir, homedir } from 'node:os'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  initWarmProcessManager,
  setProjectTabCounts,
  clearWindowTabCounts,
  claimWarmShell,
  getWarmStatus,
  reapOrphanWarms,
  __resetForTests,
  type WarmPoolDataOps
} from './warm-process-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'
import { setReinstallHooks, buildBaseEnv } from './pty-manager'

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

/**
 * Warm agents live on RUNNERS now, so the pool is driven through the
 * `PtyBackend` warm methods rather than by spawning a local shell. This fake
 * backend records what the pool asked the runner to do.
 */
interface WarmSpawnCall {
  runnerId: string
  warmId: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  postSpawnCommand?: string
}

let spawnCalls: WarmSpawnCall[] = []
let killCalls: Array<{ runnerId: string; warmId: string }> = []
let listResult: Array<{ warmId: string; cwd: string; pid: number }> = []

const spawnCount = (): number => spawnCalls.length
const lastSpawn = (): WarmSpawnCall | undefined => spawnCalls[spawnCalls.length - 1]

const fakeBackend = {
  spawn() {
    throw new Error('cold spawn must not run from the warm pool')
  },
  async warmSpawn(runnerId: string, spec: Omit<WarmSpawnCall, 'runnerId'>) {
    spawnCalls.push({ runnerId, ...spec })
    return { pid: 4242 }
  },
  async warmKill(runnerId: string, warmId: string) {
    killCalls.push({ runnerId, warmId })
  },
  async warmList() {
    return listResult
  },
  async adopt() {
    throw new Error('adopt is exercised by adopt-pty.test.ts')
  }
}

let enabled = true
// cwd must exist on disk — spawnWarm guards on existsSync(projectRoot).
const PROJECT_ROOT = tmpdir()
// Stub db: the mode lookup returns the claude-code template; `run` captures
// writes (recordSessionSpawn / markSessionDead) so the agent-warm test can
// assert a pooled session row was recorded.
let dbRunCalls: Array<{ sql: string; params: unknown[] }> = []
const db = {
  get: async (sql: string) =>
    /terminal_modes/.test(sql)
      ? { initial_command: 'claude --session-id {id} {flags}', default_flags: '--dangerously' }
      : undefined,
  run: async (sql: string, params: unknown[] = []) => {
    dbRunCalls.push({ sql, params })
    return { changes: 1, lastInsertRowid: 0 }
  }
} as unknown as SlayzoneDb

let runnerId: string | null = 'runner-1'

function init(): void {
  spawnCalls = []
  killCalls = []
  listResult = []
  dbRunCalls = []
  enabled = true
  runnerId = 'runner-1'
  setPtyBackend(fakeBackend as unknown as PtyBackend)
  initWarmProcessManager({
    db,
    isEnabled: () => enabled,
    getProjectRoot: async () => PROJECT_ROOT,
    resolveRunnerId: async () => runnerId
  })
}

await test('gate 0→1 spawns one warm shell', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(getWarmStatus().p1).toBe('ready')
  expect(spawnCount()).toBe(1)
})

await test('warm spawn pre-boots the agent + records a pooled session (B3b)', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  // The provider command is sent as postSpawnCommand for the RUNNER to exec into
  // the warm shell (agent pre-boot). Built hub-side so the hub stays the sole
  // authority on mode templates + conversation ids.
  const post = lastSpawn()?.postSpawnCommand ?? ''
  expect(post.includes('exec ') && post.includes('claude')).toBeTruthy()
  // A pooled agent_sessions row was recorded.
  const pooledInsert = dbRunCalls.find((c) => /INSERT INTO agent_sessions/.test(c.sql))
  expect(!!pooledInsert).toBeTruthy()
  expect((pooledInsert!.params as unknown[]).includes('pooled')).toBeTruthy()
})

await test('warm spawn sets SLAYZONE_PROJECT_ID even with no task bound yet', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(lastSpawn()?.env?.SLAYZONE_PROJECT_ID).toBe('p1')
  expect(lastSpawn()?.env?.SLAYZONE_TASK_ID).toBe(undefined as unknown as string)
})

await test('warm spawn fires the notify.sh self-heal (the clobber-bug population)', async () => {
  // A pre-warmed claude-code agent's hooks fire from warm time and it is never
  // healed at adoption (createPty skips preWarmedAgent) — so if the warm path
  // did not self-heal, this exact population (the one the clobber bug made
  // invisible) could run through a stale cross-release-channel notify.sh. Guard it.
  let heals = 0
  setReinstallHooks(async () => {
    heals++
  })
  try {
    init()
    setProjectTabCounts(1, { p1: 1 })
    await settle()
    expect(spawnCount()).toBe(1)
    expect(heals).toBe(1)
  } finally {
    setReinstallHooks(null)
  }
})

await test('count 1→2→1 does not respawn', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  setProjectTabCounts(1, { p1: 2 })
  await settle()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(spawnCount()).toBe(1)
})

await test('count →0 kills the warm agent on its runner', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const warmId = lastSpawn()!.warmId
  setProjectTabCounts(1, { p1: 0 })
  await settle()
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
  // The process is the runner's, so teardown is a request, not a local kill.
  expect(killCalls.some((c) => c.warmId === warmId && c.runnerId === 'runner-1')).toBe(true)
})

await test('multi-window union keeps warm while any window has the tab', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  setProjectTabCounts(2, { p1: 1 })
  await settle()
  expect(spawnCount()).toBe(1)
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
  expect(spawnCount()).toBe(0)
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
})

await test('claim returns the runner handle, not a process (nothing to seed hub-side)', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({
    projectId: 'p1',
    mode: 'claude-code',
    cwd: PROJECT_ROOT,
    resuming: false,
    runnerId: 'runner-1',
    flags: '--dangerously'
  })
  // The pool no longer owns output. The RUNNER buffers a warm session in its own
  // RingBuffer and replays it in the pty.warmAdopt reply, which reaches the hub on
  // the session's normal data path — so it passes through `interceptSyncQueries` +
  // `filterBufferData` (attachPtyHandlers wraps remote handles too) exactly like
  // live output.
  //
  // That is what retires this module's old stateful stripper. A pre-warmed claude
  // polls DECXCPR (`ESC[?6n`) every 200ms with nobody answering; the OLD hub-local
  // drain bypassed onData, so those accumulated unfiltered and replayed at adopt —
  // xterm.js then answered them, and a row=1 answer is what Claude Code reads as
  // "screen externally wiped" → `/clear` → new session. Neither half of that
  // survives the move: nothing bypasses onData now, and the seed arrives as ONE
  // contiguous chunk, so there is no torn `ESC[?6` / `n` split across read
  // boundaries for a stateless filter to miss.
  expect(claim!.warmId).toBe(lastSpawn()!.warmId)
  expect(claim!.runnerId).toBe('runner-1')
  expect((claim as unknown as { seedBuffer?: string }).seedBuffer).toBe(
    undefined as unknown as string
  )
})

await test('never warms when no runner resolves (no ownerless billable agent)', async () => {
  init()
  runnerId = null
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  // Warming on a machine no task will resolve to would boot an agent nothing can
  // adopt — and a pre-booted agent costs tokens.
  expect(spawnCount()).toBe(0)
  expect(getWarmStatus().p1).toBe(undefined as unknown as 'ready')
})

await test('claim refuses a warm agent held by a DIFFERENT runner', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({
    projectId: 'p1',
    mode: 'claude-code',
    cwd: PROJECT_ROOT,
    resuming: false,
    runnerId: 'runner-2',
    flags: '--dangerously'
  })
  // The process lives on ONE machine; a spawn routed elsewhere must cold-spawn.
  expect(claim).toBe(null as unknown as ReturnType<typeof claimWarmShell>)
})

await test('reapOrphanWarms kills runner-side warms this hub is not tracking', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const mine = lastSpawn()!.warmId
  // Warm agents are the runner's processes, so they survive a hub/sidecar restart
  // that wiped the pool map — an unclaimed pre-booted agent is billable with no
  // owner. The runner's own list is the authority on what is actually alive.
  listResult = [
    { warmId: mine, cwd: PROJECT_ROOT, pid: 1 },
    { warmId: 'warm:orphan-from-a-previous-boot', cwd: PROJECT_ROOT, pid: 2 }
  ]
  await reapOrphanWarms('runner-1')
  expect(killCalls.length).toBe(1)
  expect(killCalls[0].warmId).toBe('warm:orphan-from-a-previous-boot')
})

await test('adopt matches: claude-code + project-root cwd + fresh', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const adopted = lastSpawn()!.warmId
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: false, runnerId: 'runner-1', flags: '--dangerously' })
  expect(claim?.warmId).toBe(adopted)
  // Consumed: removed from the pool, then re-armed immediately (still has an open tab).
  await settle()
  expect(spawnCount()).toBe(2)
})

await test('adopt miss: wrong mode', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'codex', cwd: PROJECT_ROOT, resuming: false, runnerId: 'runner-1' })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready') // untouched
})

await test('adopt miss: resume', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: true, runnerId: 'runner-1' })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready')
})

await test('adopt miss: cwd mismatch (e.g. worktree path)', async () => {
  init()
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  const claim = claimWarmShell({ projectId: 'p1', mode: 'claude-code', cwd: homedir(), resuming: false, runnerId: 'runner-1' })
  expect(claim).toBeNull()
  expect(getWarmStatus().p1).toBe('ready')
})

await test('adopt miss: no warm for project', async () => {
  init()
  const claim = claimWarmShell({ projectId: 'nope', mode: 'claude-code', cwd: PROJECT_ROOT, resuming: false, runnerId: 'runner-1' })
  expect(claim).toBeNull()
})

await test('injected ops seam handles mode lookup + session writes (db untouched)', async () => {
  spawnCalls = []
  killCalls = []
  listResult = []
  dbRunCalls = []
  enabled = true
  runnerId = 'runner-1'
  setPtyBackend(fakeBackend as unknown as PtyBackend)
  const modeLookups: string[] = []
  let recorded: Parameters<WarmPoolDataOps['recordSessionSpawn']>[0] | null = null
  const deadIds: string[] = []
  const ops: WarmPoolDataOps = {
    getModeSpawnConfig: async (modeId) => {
      modeLookups.push(modeId)
      return { initial_command: 'claude --session-id {id} {flags}', default_flags: '--dangerously' }
    },
    recordSessionSpawn: async (input) => {
      recorded = input
    },
    markSessionDead: async (sessionId) => {
      deadIds.push(sessionId)
    }
  }
  initWarmProcessManager({
    db,
    ops,
    isEnabled: () => enabled,
    getProjectRoot: async () => PROJECT_ROOT,
    resolveRunnerId: async () => runnerId
  })
  setProjectTabCounts(1, { p1: 1 })
  await settle()
  expect(getWarmStatus().p1).toBe('ready')
  // Mode template came through ops, and the agent was exec'd from it.
  expect(modeLookups.includes('claude-code')).toBeTruthy()
  expect((lastSpawn()?.postSpawnCommand ?? '').includes('claude')).toBeTruthy()
  // Pooled session recorded through ops with the exact spawn payload…
  expect(recorded?.status).toBe('pooled')
  expect(recorded?.mode).toBe('claude-code')
  expect(recorded?.taskId).toBeNull()
  // …and no session write hit the injected db directly (db.run untouched;
  // deps.db itself stays required this wave, e.g. buildMcpEnv still takes it).
  expect(dbRunCalls.length).toBe(0)
  // Teardown → markSessionDead flows through ops with the pooled session id. The
  // warm process is the runner's, so its death is no longer observed through a
  // local onExit; the pool marks the pooled row dead when it releases the handle.
  setProjectTabCounts(1, { p1: 0 })
  await settle()
  await wait(10)
  expect(deadIds.length).toBe(1)
  expect(deadIds[0]).toBe(recorded!.id)
})

// buildBaseEnv is the shared base for EVERY pty spawn (cold createPty + warm
// pool + docker/ssh). It must sanitize the host's env: keep the user env
// (PATH/HOME) but strip SlayZone infra/secret/identity (and unmanifested
// SLAYZONE_*, fail closed). Per-spawn identity is re-added later via mcpEnv.
await test('buildBaseEnv sanitizes host env: strips SlayZone infra/secret/identity, keeps user env', () => {
  const saved: Record<string, string | undefined> = {}
  const inject: Record<string, string> = {
    SLAYZONE_HUB_TOKEN: 'host-secret', // secret
    SLAYZONE_HUB_ADDRESS: 'hub.example:8443', // infra
    SLAYZONE_MODE: 'remote', // infra
    SLAYZONE_TASK_ID: 'host-task', // identity (mcpEnv re-adds correct)
    SLAYZONE_FUTURE_UNLISTED: 'fail-closed', // unmanifested → fail closed
    SLAYZONE_RELEASE_CHANNEL: 'dev' // global → kept
  }
  for (const [k, v] of Object.entries(inject)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    const env = buildBaseEnv()
    expect('SLAYZONE_HUB_TOKEN' in env).toBe(false)
    expect('SLAYZONE_HUB_ADDRESS' in env).toBe(false)
    expect('SLAYZONE_MODE' in env).toBe(false)
    expect('SLAYZONE_TASK_ID' in env).toBe(false)
    expect('SLAYZONE_FUTURE_UNLISTED' in env).toBe(false)
    expect(env.SLAYZONE_RELEASE_CHANNEL).toBe('dev')
    // User env + terminal decoration survive.
    expect(typeof env.PATH === 'string' && env.PATH.length > 0).toBe(true)
    expect(env.TERM).toBe('xterm-256color')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
