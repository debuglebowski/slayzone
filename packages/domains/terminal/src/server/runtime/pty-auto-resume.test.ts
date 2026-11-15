/**
 * An agent that dies mid-session without SlayZone asking is RESUMED on its
 * conversation, in place — not replaced by a bare recovery shell.
 *
 * Regression (2026-11-14): the hub's stray sweep SIGHUP'd 31 live claude-code
 * agents (exit 129); each became an interactive shell and the user lost the agent
 * view. Start failures, requested kills and stale resumes keep their old handling.
 *
 * Fake backend + stub db + stub transcript locator — nothing spawns.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import {
  applyPtyInputFacts,
  writePty,
  createPty,
  getBuffer,
  hasLivePty,
  hasPty,
  killPty,
  noteSessionConversationId,
  resetAutoResumeForTests,
  setDatabase
} from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtySpawnSpec } from './pty-backend'
import { ptyEvents } from './pty-events'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import { setClaudeTranscriptLocator } from './claude-transcript-locator'

const diag = vi.hoisted(() => [] as Array<{ event: string; payload?: unknown }>)
vi.mock('@slayzone/diagnostics/server', async (orig) => ({
  ...(await orig<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: (e: { event: string; payload?: unknown }) => {
    diag.push(e)
  }
}))

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

const ID = 'aa11aa11-0000-4000-8000-000000000001'
const ID2 = 'bb22bb22-0000-4000-8000-000000000002'

type Exit = { exitCode: number; signal?: number; reason?: string }
interface FakeHandle {
  print(data: string): void
  exit(e: Exit): void
  killed: boolean
  written: string[]
}
interface Backend {
  specs: PtySpawnSpec[]
  handles: FakeHandle[]
  /** While set, the next spawn waits for it. */
  hold: Promise<void> | null
  /** Spawn indexes whose owner refuses the start (`whenSpawned` rejects). */
  refuse: Set<number>
}

/** A routing-style backend: every spawn resolves to a handle the test drives. */
function fakeBackend(sync = false): Backend {
  const b: Backend = { specs: [], handles: [], hold: null, refuse: new Set() }
  const make = (): unknown => {
    let dataCb: ((d: string) => void) | undefined
    let exitCb: ((e: Exit) => void) | undefined
    const h: FakeHandle = {
      print: (d) => dataCb?.(d),
      exit: (e) => exitCb?.(e),
      killed: false,
      written: []
    }
    const index = b.handles.length
    b.handles.push(h)
    return {
      ...(b.refuse.has(index)
        ? { whenSpawned: Promise.reject(new Error('admission refused')) }
        : {}),
      pid: 4000 + b.handles.length,
      process: 'zsh',
      onData: (cb: (d: string) => void) => {
        dataCb = cb
        return { dispose: () => undefined }
      },
      onExit: (cb: (e: Exit) => void) => {
        exitCb = cb
        return { dispose: () => undefined }
      },
      write: (d: string) => {
        h.written.push(d)
      },
      kill: () => {
        if (h.killed) return
        h.killed = true
        // What node-pty reports for a SIGKILL: code 0, signal 9.
        queueMicrotask(() => exitCb?.({ exitCode: 0, signal: 9 }))
      },
      resize: () => undefined
    }
  }
  setPtyBackend({
    spawn: (spec: PtySpawnSpec) => {
      b.specs.push(spec)
      if (sync) return make() as never
      const held = b.hold
      return (async () => {
        if (held) await held
        return make()
      })() as never
    }
  } as unknown as PtyBackend)
  return b
}

const commandOf = (spec: PtySpawnSpec): string => JSON.stringify(spec.args)

let skew = 0
const realNow = Date.now
const exits: Array<{ id: string; code: number | null }> = []
const opened: string[] = []

beforeEach(() => {
  skew = 0
  diag.length = 0
  exits.length = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  ptyEvents.on('exit', (id: string, code: number | null) => {
    exits.push({ id, code })
  })
  setClaudeTranscriptLocator(async (req) =>
    req.sessionIds.map((sessionId) => ({ sessionId, found: true, resumeCwd: null }))
  )
})
afterEach(() => {
  for (const id of opened.splice(0)) killPty(id)
  ptyEvents.removeAllListeners()
  setClaudeTranscriptLocator(null)
  setPtyBackend(null)
  resetAutoResumeForTests()
  vi.restoreAllMocks()
})

let n = 0
async function openAgent(over: Record<string, unknown> = {}): Promise<string> {
  const sid = `arTask${++n}:arTask${n}`
  const res = await createPty({
    win: fakeWin,
    sessionId: sid,
    computerId: 'pc',
    projectId: 'proj-1',
    cwd: '/work/repo',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: ID,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '',
    ...over
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  opened.push(sid)
  return sid
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = realNow() + ms
  while (!cond()) {
    if (realNow() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150))
const events = (name: string) => diag.filter((e) => e.event === name)

test('unexpected death past startup: resumed on the current conversation, in place', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].print('claude ready\r\n')
  // The conversation moved on since the spawn (/clear): resume the CURRENT one.
  noteSessionConversationId(sid, ID2)
  skew += 11_000
  b.handles[0].exit({ exitCode: 129 })

  await until(() => b.specs.length === 2)
  expect(commandOf(b.specs[1])).toContain(`--resume' '${ID2}`)
  expect(b.specs[1].carryOutput?.preamble).toContain(
    'claude-code exited unexpectedly (code 129) — resuming conversation'
  )
  await settle()
  // No exit reached anyone: the terminal stays on the same live session.
  expect(exits).toEqual([])
  expect(hasLivePty(sid)).toBe(true)
  expect(events('pty.auto_resumed')).toHaveLength(1)
  expect(events('pty.auto_resumed')[0].payload).toMatchObject({
    exitCode: 129,
    mode: 'claude-code',
    computerId: 'pc'
  })
  expect(events('pty.shell_fallback')).toEqual([])
  // The resumed agent's own output flows into the same session.
  b.handles[1].print('resumed\r\n')
  expect(hasLivePty(sid)).toBe(true)
})

test('a kill SlayZone asked for is never resumed', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].print('claude ready\r\n')
  skew += 11_000
  killPty(sid)
  await until(() => exits.length === 1)
  await settle()
  expect(b.specs).toHaveLength(1)
  expect(events('pty.auto_resumed')).toEqual([])
})

test('a start failure keeps the recovery shell', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].exit({ exitCode: 1 })
  await until(() => b.specs.length === 2)
  expect(commandOf(b.specs[1])).not.toContain('--resume')
  expect(b.specs[1].carryOutput?.preamble).toContain('Switched to interactive shell for recovery')
  await settle()
  expect(events('pty.shell_fallback')).toHaveLength(1)
  expect(events('pty.auto_resumed')).toEqual([])
  expect(hasPty(sid)).toBe(true)
})

test('a second death within the window gets the recovery shell', async () => {
  const b = fakeBackend()
  await openAgent()
  b.handles[0].print('ready\r\n')
  skew += 11_000
  b.handles[0].exit({ exitCode: 129 })
  await until(() => b.specs.length === 2)
  await settle()
  b.handles[1].print('resumed\r\n')
  skew += 60_000
  b.handles[1].exit({ exitCode: 129 })
  await until(() => b.specs.length === 3)
  expect(commandOf(b.specs[2])).not.toContain('--resume')
  expect(b.specs[2].carryOutput?.preamble).toContain('Switched to interactive shell for recovery')
  await settle()
  expect(events('pty.auto_resume_rate_limited')).toHaveLength(1)
  expect(events('pty.shell_fallback')).toHaveLength(1)
})

test('an exit with a transport reason is not resumed', async () => {
  const b = fakeBackend()
  await openAgent()
  b.handles[0].print('ready\r\n')
  skew += 11_000
  b.handles[0].exit({ exitCode: 1, reason: 'exited-while-detached' })
  await settle()
  for (const spec of b.specs.slice(1)) expect(commandOf(spec)).not.toContain('--resume')
  expect(events('pty.auto_resumed')).toEqual([])
})

test('the user ending it with ^C is not resumed', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].print('ready\r\n')
  skew += 11_000
  applyPtyInputFacts(sid, { esc: false, submitted: null, statusCommand: false, interrupt: true }, 1)
  b.handles[0].exit({ exitCode: 1 })
  await settle()
  for (const spec of b.specs.slice(1)) expect(commandOf(spec)).not.toContain('--resume')
  expect(events('pty.auto_resumed')).toEqual([])
})

test('closed while the resume is starting: the new process is dropped, one exit', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].print('ready\r\n')
  skew += 11_000
  let release!: () => void
  b.hold = new Promise<void>((r) => {
    release = r
  })
  b.handles[0].exit({ exitCode: 129 })
  await until(() => b.specs.length === 2)
  killPty(sid)
  await until(() => exits.length === 1)
  release()
  await until(() => b.handles.length === 2)
  await settle()
  expect(b.handles[1].killed).toBe(true)
  expect(exits).toHaveLength(1)
  expect(hasPty(sid)).toBe(false)
})

test('hub-local session: the resumed agent continues the same scrollback', async () => {
  const b = fakeBackend(true)
  // codex: a claude-code resume here would read this machine's disk for its transcript.
  const sid = await openAgent({
    computerId: null,
    mode: 'codex',
    type: 'codex',
    initialCommand: 'codex {flags}',
    resumeCommand: 'codex resume {id} {flags}'
  })
  b.handles[0].print('before the crash\r\n')
  skew += 11_000
  b.handles[0].exit({ exitCode: 129 })
  await until(() => b.specs.length === 2)
  await settle()
  b.handles[1].print('after the resume\r\n')
  const buf = (await getBuffer(sid)) ?? ''
  expect(buf).toContain('before the crash')
  expect(buf).toContain('codex exited unexpectedly (code 129)')
  expect(commandOf(b.specs[1])).toContain(`'resume' '${ID}`)
  expect(buf).toContain('after the resume')
  expect(exits).toEqual([])
})

test("the dead process's agent tree is dropped before the resumed agent reports", async () => {
  // The hub keys agent-tree eviction on `replacing` / `exit` (composition.ts); a death
  // without SessionEnd (SIGKILL, OOM) would otherwise leave a stale subagent id that
  // pins the resumed agent's state on 'background'.
  const trees = new Map<string, string[]>()
  ptyEvents.on('replacing', (id: string) => trees.delete(id))
  const b = fakeBackend()
  const sid = await openAgent()
  trees.set(sid, ['subagent-1'])
  b.handles[0].print('ready\r\n')
  skew += 11_000
  b.handles[0].exit({ exitCode: 0, signal: 9 })
  await until(() => b.specs.length === 2)
  expect(trees.has(sid)).toBe(false)
  await settle()
  expect(exits).toEqual([])
})

test('while the resume starts: the tab shows starting and the info line, typing is kept', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  const states: string[] = []
  ptyEvents.on('state-change', (id: string, state: string) => {
    if (id === sid) states.push(state)
  })
  b.handles[0].print('ready\r\n')
  // Past the first output's (debounced) move out of `starting`.
  await settle()
  states.length = 0
  skew += 11_000
  let release!: () => void
  b.hold = new Promise<void>((r) => {
    release = r
  })
  b.handles[0].exit({ exitCode: 129 })
  await until(() => b.specs.length === 2)
  // Before the new process exists.
  expect(states).toContain('starting')
  expect((await getBuffer(sid)) ?? '').toContain('exited unexpectedly (code 129)')
  expect(writePty(sid, 'hello')).toBe(true)
  expect(b.handles[0].written).toEqual([])
  release()
  await until(() => b.handles.length === 2)
  await settle()
  expect(b.handles[1].written.join('')).toContain('hello')
  expect(exits).toEqual([])
})

test('a resume its computer refuses to start falls back to the recovery shell', async () => {
  const b = fakeBackend()
  const sid = await openAgent()
  b.handles[0].print('ready\r\n')
  skew += 11_000
  b.refuse.add(1)
  b.handles[0].exit({ exitCode: 129 })
  await until(() => b.specs.length === 3)
  expect(commandOf(b.specs[1])).toContain('--resume')
  expect(commandOf(b.specs[2])).not.toContain('--resume')
  expect(b.specs[2].carryOutput?.preamble).toContain('Switched to interactive shell for recovery')
  await settle()
  expect(exits).toEqual([])
  expect(hasPty(sid)).toBe(true)
  expect(events('pty.shell_fallback')).toHaveLength(1)
})
