/**
 * Tests for the PtySessionLedger seam (hub/computer split, wave 1): createPty's
 * session-provenance DB touchpoints go through the injected ledger, not a raw
 * db handle. Asserts the ordering contract with a fake ledger:
 *   - pending-spawn is recorded (and AWAITED durable) before the agent starts
 *   - pending rows are pruned on exit (fire-and-forget)
 *   - bindSessionToTask fires only on pre-warmed (pooled) adoption
 *   - a null ledger (pre-init) spawns fine and records nothing
 * Uses a fake pty + fake window + fake ledger — no real shell spawns, no db.
 */
import { expect, test } from 'vitest'
import type { PtySessionWindow } from '../pty-host'
import type { IPty } from 'node-pty'
import type { PtySessionLedger } from './pty-data-ops'
import { createPty, killPty, setPtySessionLedger } from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'

interface FakePty {
  pid: number
  process: string
  written: string[]
  onData: (cb: (d: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  write: (s: string) => void
  kill: (sig?: string) => void
  resize: (c: number, r: number) => void
  /** Push output through the registered pty:data handler. Sets firstOutputTs
   *  inside createPty, which keeps the fast-exit-no-output fallback (a REAL
   *  shell respawn) out of the exit path. */
  fireData: (d: string) => void
  /** Fire the registered onExit callback — the REAL production exit path
   *  (onExit handler → finalizeSessionExit), not killPty's error branch. */
  fireExit: (exitCode: number) => void
}
function makeFakePty(events: string[]): FakePty {
  const dataCbs: Array<(d: string) => void> = []
  const exitCbs: Array<(e: { exitCode: number }) => void> = []
  return {
    pid: 4242,
    process: 'zsh',
    written: [],
    onData(cb) {
      dataCbs.push(cb)
      return { dispose() {} }
    },
    onExit(cb) {
      exitCbs.push(cb)
      return { dispose() {} }
    },
    write(s) {
      this.written.push(s)
      events.push('pty:write')
    },
    kill() {
      // Throwing makes killPty run the exit finalizer synchronously (the
      // "process already exited" branch) — deterministic CLEANUP for tests
      // whose assertions are already done, with no lingering kill-watchdog
      // timer that could fire a stray prune into a later test's fake ledger.
      throw new Error('already exited')
    },
    resize() {},
    fireData(d) {
      for (const cb of dataCbs) cb(d)
    },
    fireExit(exitCode) {
      for (const cb of exitCbs) cb({ exitCode })
    }
  }
}

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} }
} as unknown as PtySessionWindow

type LedgerCalls = {
  record: Array<{
    taskId: string
    mode: string
    expectedSessionId: string | null
    usedResume: boolean
  }>
  prune: Array<{ taskId: string; mode: string }>
  bind: Array<{ sessionId: string; taskId: string; tabId: string }>
}
function makeFakeLedger(events: string[]): { ledger: PtySessionLedger; calls: LedgerCalls } {
  const calls: LedgerCalls = { record: [], prune: [], bind: [] }
  const ledger: PtySessionLedger = {
    async recordPendingSpawn(args) {
      events.push('record:start')
      // Simulated write latency: only an AWAITED record can finish before the
      // agent starts. If createPty ever stops awaiting (fire-and-forget), the
      // first pty write overtakes 'record:done' and the ordering test fails.
      await new Promise((r) => setTimeout(r, 20))
      calls.record.push(args)
      events.push('record:done')
    },
    async prunePendingSpawns(scope) {
      calls.prune.push(scope)
      events.push('prune')
      return 1
    },
    async bindSessionToTask(args) {
      calls.bind.push(args)
      events.push('bind')
      return true
    },
    async buildMcpEnv(taskId): Promise<Record<string, string>> {
      return taskId ? { SLAYZONE_TASK_ID: taskId } : {}
    }
  }
  return { ledger, calls }
}

/**
 * Warm adoption is a REKEY on a COMPUTER (`pty.warmAdopt`) reached through
 * `PtyBackend.adopt` — there is no hub-local warm pool. These tests exercise the
 * adoption BRANCH of createPty, so they stand in a backend whose `adopt` returns
 * the fake pty the computer would have handed back.
 */
function installAdoptBackend(fake: unknown): void {
  setPtyBackend({
    spawn() {
      throw new Error('adoption must not cold-spawn')
    },
    async adopt() {
      return fake as never
    }
  } as unknown as PtyBackend)
}

test('pending-spawn is recorded durably BEFORE the agent starts (no bind on plain adopt)', async () => {
  const events: string[] = []
  const { ledger, calls } = makeFakeLedger(events)
  setPtySessionLedger(ledger)
  try {
    const fake = makeFakePty(events)
    installAdoptBackend(fake)
    installAdoptBackend(fake)
    const sessionId = 'ledgerA:ledgerA'
    const res = await createPty({
      win: fakeWin,
      sessionId,
      cwd: '/tmp',
      mode: 'claude-code',
      type: 'claude-code',
      conversationId: 'conv-L1',
      initialCommand: 'claude --session-id {id} {flags}',
      defaultFlags: '--allow-dangerously-skip-permissions',
      adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
    })
    expect(res.success, `createPty failed: ${res.error}`).toBe(true)
    expect(calls.record.length, `expected 1 recordPendingSpawn, got ${calls.record.length}`).toBe(1)
    const rec = calls.record[0]
    expect(rec.taskId, `wrong taskId recorded: ${rec.taskId}`).toBe('ledgerA')
    expect(rec.mode, `wrong mode recorded: ${rec.mode}`).toBe('claude-code')
    expect(rec.expectedSessionId, `wrong expected id: ${rec.expectedSessionId}`).toBe('conv-L1')
    expect(rec.usedResume, 'fresh spawn must record usedResume=false').toBe(false)
    // The durability contract: the record resolved before any byte reached the
    // pty (the agent exec is written into the adopted shell).
    const recordDone = events.indexOf('record:done')
    const firstWrite = events.indexOf('pty:write')
    expect(recordDone, 'record never completed').not.toBe(-1)
    expect(firstWrite, 'agent exec never written to pty').not.toBe(-1)
    expect(
      recordDone,
      `pending-spawn must be durable before spawn: ${JSON.stringify(events)}`
    ).toBeLessThan(firstWrite)
    // Plain (non-pre-warmed) adoption must NOT bind a pooled session.
    expect(calls.bind.length, `bind must not fire on plain adopt: ${calls.bind.length}`).toBe(0)
    killPty(sessionId)
  } finally {
    setPtySessionLedger(null)
  }
})

test('pending-spawn is pruned on exit (fire-and-forget, scoped to task+mode)', async () => {
  const events: string[] = []
  const { ledger, calls } = makeFakeLedger(events)
  setPtySessionLedger(ledger)
  try {
    const fake = makeFakePty(events)
    installAdoptBackend(fake)
    installAdoptBackend(fake)
    const sessionId = 'ledgerB:ledgerB'
    await createPty({
      win: fakeWin,
      sessionId,
      cwd: '/tmp',
      mode: 'claude-code',
      type: 'claude-code',
      conversationId: 'conv-L2',
      initialCommand: 'claude --session-id {id} {flags}',
      defaultFlags: '--allow-dangerously-skip-permissions',
      adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
    })
    expect(calls.prune.length, 'prune must not fire before exit').toBe(0)
    // Natural exit through the REAL production path: emit output first (so the
    // fast-exit-no-output fallback doesn't respawn a real shell), then fire the
    // registered onExit handler → finalizeSessionExit → prune.
    fake.fireData('agent output\r\n')
    fake.fireExit(0)
    // Prune is deliberately fire-and-forget (void'd promise) — flush microtasks.
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.prune.length, `expected 1 prune on exit, got ${calls.prune.length}`).toBe(1)
    expect(calls.prune[0].taskId, `prune scope wrong: ${JSON.stringify(calls.prune[0])}`).toBe(
      'ledgerB'
    )
    expect(calls.prune[0].mode, `prune scope wrong: ${JSON.stringify(calls.prune[0])}`).toBe(
      'claude-code'
    )
  } finally {
    setPtySessionLedger(null)
  }
})

test('bindSessionToTask fires ONLY on pre-warmed pooled adoption (and skips record)', async () => {
  const events: string[] = []
  const { ledger, calls } = makeFakeLedger(events)
  setPtySessionLedger(ledger)
  try {
    const fake = makeFakePty(events)
    installAdoptBackend(fake)
    installAdoptBackend(fake)
    const sessionId = 'ledgerC:ledgerC'
    await createPty({
      win: fakeWin,
      sessionId,
      taskId: 'ledgerC',
      tabId: 'ledgerC',
      cwd: '/tmp',
      mode: 'claude-code',
      type: 'claude-code',
      initialCommand: 'claude --session-id {id} {flags}',
      defaultFlags: '--x',
      initialPrompt: 'HI',
      adoptPty: {
        warmId: 'warm-1',
        computerId: 'computer-1',
        preWarmedAgent: true,
        sessionId: 'poolX',
        conversationId: 'convPool'
      }
    })
    expect(calls.bind.length, `expected 1 bind, got ${calls.bind.length}`).toBe(1)
    expect(calls.bind[0].sessionId, `bind args wrong: ${JSON.stringify(calls.bind[0])}`).toBe(
      'poolX'
    )
    expect(calls.bind[0].taskId, `bind args wrong: ${JSON.stringify(calls.bind[0])}`).toBe(
      'ledgerC'
    )
    expect(calls.bind[0].tabId, `bind args wrong: ${JSON.stringify(calls.bind[0])}`).toBe('ledgerC')
    // A pre-warmed agent's provenance was anchored at warm-spawn time — the
    // adoption must NOT write a fresh pending-spawn row.
    expect(calls.record.length, 'pre-warmed adoption must not record a pending spawn').toBe(0)
    killPty(sessionId)
  } finally {
    setPtySessionLedger(null)
  }
})

test('null ledger (pre-init): spawn still succeeds, nothing recorded', async () => {
  const events: string[] = []
  setPtySessionLedger(null)
  const fake = makeFakePty(events)
  installAdoptBackend(fake)
  const sessionId = 'ledgerD:ledgerD'
  const res = await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    conversationId: 'conv-L4',
    initialCommand: 'claude --session-id {id} {flags}',
    defaultFlags: '--x',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
  expect(res.success, `createPty must succeed without a ledger: ${res.error}`).toBe(true)
  // The mcp-env fallback still exports the task identity without a db.
  const cmd = fake.written.join('')
  expect(cmd, `task id must still be exported: ${cmd}`).toContain('SLAYZONE_TASK_ID=')
  killPty(sessionId)
  await new Promise((r) => setTimeout(r, 10))
  expect(
    events.every((e) => e === 'pty:write'),
    `no ledger calls expected: ${JSON.stringify(events)}`
  ).toBe(true)
})
