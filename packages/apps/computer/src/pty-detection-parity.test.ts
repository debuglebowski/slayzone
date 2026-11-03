/**
 * PARITY: hub-side output detection vs computer detection → `pty-signal` → hub mirror.
 *
 * Both paths share `PtyOutputDetector`, but the computer path adds its own steps
 * (sync-query answers + filter before streaming, idle-clock coalescing, the seq
 * filter on signals), so parity is proven here end to end, not assumed. The same
 * recorded output — split mid-escape on purpose — is fed to every adapter through
 *  (a) the hub's own detection: a pty handle that does not detect (an older computer);
 *  (b) the real computer pty handlers (fake node-pty) → routing backend → hub mirror;
 * and the hub-visible results must be identical: state transitions, prompts, titles,
 * dev-server URLs, conversation ids, terminal-query answers, and the idle clock.
 */
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, test, vi } from 'vitest'
import type * as nodePty from 'node-pty'
import { TypedEventEmitter } from '@slayzone/computer-transport/shared'
import {
  createRoutingPtyBackend,
  type ComputerGatewayEvents,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtyBackend, PtySpawnSpec } from '@slayzone/terminal/server'
import { getAdapter } from '@slayzone/terminal/pty-detection'
// The pty runtime itself (not re-exported by the domain barrel).
import {
  createPty,
  killPty,
  listPtys,
  setDatabase,
  writePty
} from '../../../domains/terminal/src/server/runtime/pty-manager'
import { setPtyBackend } from '../../../domains/terminal/src/server/runtime/pty-backend'
import { ptyEvents } from '../../../domains/terminal/src/server/runtime/pty-events'
import { createFakeTaskSessionStore } from '../../../domains/terminal/src/server/runtime/fake-task-session-store'
import type { PtySessionWindow } from '../../../domains/terminal/src/server/pty-host'
import type { ComputerConfig } from './config'
import { createPtyHandlers } from './handlers/pty'
import type { ComputerDialer } from './handlers/types'

const computerId = 'parity-computer'
const CONVERSATION = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'

/** Recorded-shaped output, deliberately split inside escape sequences. */
const FIXTURE: Array<string | { write: 'session-id-command' }> = [
  '\x1b]0;Agent tit',
  'le one\x07booting\r\n',
  'before\x1b[',
  'cafter\r\n',
  '⠋ thinking\r\n',
  '⠙ still thinking\r\n',
  `${'x'.repeat(120)}\r\n`,
  'Compiling crate foo\r\n',
  'Compiling crate bar\r\n',
  'ready on http://0.0.0.0:5173 and http://127.0.0.1:3000\r\n',
  'again http://localhost:5173\r\n',
  '\x1b]0;Agent title two\x07',
  'Do you want to proceed? [Y/n] ',
  'Approve? (y/n) ',
  'Would you like to run the following command?\r\n 1. Yes\r\n 2. No, and tell Codex what to do\r\n',
  '❯ 1. Yes\r\n',
  'FATAL: boom\r\n',
  '\x1b]11',
  ';?\x07',
  { write: 'session-id-command' },
  'Session ID:',
  ` ${CONVERSATION}\r\n`,
  '$ '
]

const MODES: Array<{ mode: string; patternWorking?: string; patternError?: string }> = [
  { mode: 'claude-code' },
  { mode: 'codex' },
  { mode: 'gemini' },
  { mode: 'cursor-agent' },
  { mode: 'copilot' },
  { mode: 'qwen-code' },
  { mode: 'opencode' },
  { mode: 'terminal', patternWorking: 'Compiling', patternError: 'FATAL' }
]

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  createFakeTaskSessionStore()
)

interface Talker {
  say(data: string): void
  writes: string[]
}

/** A node-pty stand-in whose output the test drives. */
function talker(processName = 'agent'): { proc: nodePty.IPty; t: Talker } {
  let onData: ((d: string) => void) | undefined
  const writes: string[] = []
  const proc = {
    pid: 7100,
    process: processName,
    kill: () => undefined,
    write: (d: string) => writes.push(d),
    resize: () => undefined,
    onData: (cb: (d: string) => void) => {
      onData = cb
      return { dispose() {} }
    },
    onExit: () => ({ dispose() {} })
  } as unknown as nodePty.IPty
  return { proc, t: { say: (d) => onData?.(d), writes } }
}

// --- path (b): real computer handlers behind the routing backend ---------------
const events = new TypedEventEmitter<ComputerGatewayEvents>()
const dialer: ComputerDialer = {
  notify: (method, params) => {
    events.emit(
      method as 'pty.data',
      { ...(params as Record<string, unknown>), computerId } as ComputerGatewayEvents['pty.data']
    )
    return true
  }
}
const config: ComputerConfig = {
  hubUrl: 'ws://localhost:0/computers',
  name: 'parity',
  allowedRoots: [process.cwd(), tmpdir()],
  capabilities: ['pty']
}
const computerTalkers: Talker[] = []
const computer = createPtyHandlers({ dialer, config, log: () => {} }, undefined, {
  spawnPty: (() => {
    const { proc, t } = talker()
    computerTalkers.push(t)
    return proc
  }) as unknown as typeof nodePty.spawn
})
const routing = createRoutingPtyBackend({
  gateway: {
    events,
    listComputers: () => [],
    request: async (_id: string, method: string, params: unknown) =>
      computer.handlers[method]!(params)
  } as RoutingGateway,
  resolveComputerId: (spec) => spec.computerId
})

// --- path (a): a handle that does not detect — the hub detects ------------------
const hubTalkers: Talker[] = []
function hubDetectingHandle(spec: PtySpawnSpec) {
  // Named like the routed handle (its spawn file), so process-title polling agrees.
  const { proc, t } = talker(spec.file)
  hubTalkers.push(t)
  return proc
}

setPtyBackend({
  spawn: (spec: PtySpawnSpec) =>
    spec.sessionId.startsWith('a:') ? (hubDetectingHandle(spec) as never) : routing.spawn(spec)
} as PtyBackend)

type Seen = Array<[string, unknown]>
function record(sessionId: string): { seen: Seen; stop: () => void } {
  const seen: Seen = []
  const mine = (id: string) => id === sessionId
  const on = {
    state: (id: string, s: string) => mine(id) && seen.push(['state', s]),
    prompt: (id: string, p: unknown) =>
      mine(id) && seen.push(['prompt', (p as { type: string }).type]),
    title: (id: string, t: string) => mine(id) && seen.push(['title', t]),
    url: (id: string, u: string) => mine(id) && seen.push(['dev-url', u]),
    conv: (id: string, c: string) => mine(id) && seen.push(['conversation', c])
  }
  ptyEvents.on('state-change', on.state)
  ptyEvents.on('prompt', on.prompt)
  ptyEvents.on('title-change', on.title)
  ptyEvents.on('dev-server-detected', on.url)
  ptyEvents.on('session-detected', on.conv)
  return {
    seen,
    stop: () => {
      ptyEvents.off('state-change', on.state)
      ptyEvents.off('prompt', on.prompt)
      ptyEvents.off('title-change', on.title)
      ptyEvents.off('dev-server-detected', on.url)
      ptyEvents.off('session-detected', on.conv)
    }
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(
  path: 'a' | 'b',
  m: (typeof MODES)[number]
): Promise<{ seen: Seen; answers: string[]; lastOutputTime: number; outputAt: number }> {
  const sessionId = `${path}:${m.mode}`
  const rec = record(sessionId)
  const talkers = path === 'a' ? hubTalkers : computerTalkers
  const before = talkers.length
  const res = await createPty({
    win: fakeWin,
    sessionId,
    cwd: process.cwd(),
    mode: m.mode,
    computerId,
    ...(m.patternWorking ? { patternWorking: m.patternWorking } : {}),
    ...(m.patternError ? { patternError: m.patternError } : {})
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  await vi.waitFor(() => expect(talkers.length).toBe(before + 1))
  const t = talkers[before]!
  const cmd = getAdapter({ mode: m.mode }).sessionIdCommand ?? '/status'
  let outputAt = 0
  for (const step of FIXTURE) {
    if (typeof step === 'string') {
      t.say(step)
      outputAt = Date.now()
    } else {
      writePty(sessionId, `${cmd}\r`)
    }
    await tick(25)
  }
  // Past the computer's idle-clock coalescing window and the state debounce.
  await tick(700)
  const info = (await listPtys()).find((p) => p.sessionId === sessionId)
  rec.stop()
  killPty(sessionId)
  const answers = t.writes.filter((w) => w.startsWith('\x1b'))
  return { seen: rec.seen, answers, lastOutputTime: info?.lastOutputTime ?? -1, outputAt }
}

afterAll(() => {
  computer.disposeAll()
})

describe('pty detection parity: hub-side vs computer → signal → mirror', () => {
  for (const m of MODES) {
    test(m.mode, async () => {
      const a = await run('a', m)
      const b = await run('b', m)
      // Per kind, in order. Kinds are compared separately: process-title polling runs
      // on its own timer, so its place among state transitions is not output-driven.
      const byKind = (seen: Seen) =>
        Object.fromEntries(
          ['state', 'prompt', 'title', 'dev-url', 'conversation'].map((k) => [
            k,
            seen.filter(([kind]) => kind === k).map(([, v]) => v)
          ])
        )
      expect(byKind(b.seen)).toEqual(byKind(a.seen))
      expect(b.answers).toEqual(a.answers)
      // Both clocks read the output's own time (coalescing must not move it later).
      expect(
        Math.abs(b.lastOutputTime - b.outputAt - (a.lastOutputTime - a.outputAt))
      ).toBeLessThan(60)
      // The fixture says something to every adapter (titles at least).
      expect(a.seen.length).toBeGreaterThan(0)
    }, 20_000)
  }
})
