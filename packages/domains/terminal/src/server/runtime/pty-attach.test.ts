/**
 * A hub restart is invisible to terminal agents: the restarted hub ADOPTS the
 * process its previous run left running on the computer — it never launches a
 * second one, never replaces the live one, and treats it as a running agent (no
 * startup deadline, no "starting", the conversation it reports).
 *
 * Two ways in:
 *  - a start (`createPty`) whose owner answers that it took the live session over
 *    (`whenSpawned` → `attached`, the computer's `adoptLive`);
 *  - the attach intent (`createPty({ attach })`), the hub adopting a session nobody
 *    started yet: nothing is launched, only `PtyBackend.reattach`.
 *
 * Fake backend + stub db — nothing spawns.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import {
  createPty,
  getState,
  hasLivePty,
  hasPty,
  killPty,
  resetAutoResumeForTests,
  resizePty,
  setConversationResolver,
  setDatabase,
  writePty
} from './pty-manager'
import {
  setPtyBackend,
  type PtyBackend,
  type PtySpawnConfirmation,
  type PtySpawnSpec
} from './pty-backend'
import { ptyEvents } from './pty-events'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import { setClaudeTranscriptLocator } from './claude-transcript-locator'

const diag = vi.hoisted(() => [] as Array<{ event: string; payload?: Record<string, unknown> }>)
vi.mock('@slayzone/diagnostics/server', async (orig) => ({
  ...(await orig<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: (e: { event: string; payload?: Record<string, unknown> }) => {
    diag.push(e)
  }
}))

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
const store = createFakeTaskSessionStore()
setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  store
)

const ID = 'aa11aa11-0000-4000-8000-000000000001'
const LIVE_ID = 'cc33cc33-0000-4000-8000-000000000003'

type Exit = { exitCode: number; signal?: number; reason?: string }
interface FakeHandle {
  print(data: string): void
  exit(e: Exit): void
  killed: boolean
  written: string[]
  resized: Array<[number, number]>
}
interface Backend {
  specs: PtySpawnSpec[]
  handles: FakeHandle[]
  reattached: Array<{ computerId: string; sessionId: string; fromSpawnId: string; opts: unknown }>
  /** How the next spawn's owner answers: started, or took the live session over. */
  spawnAnswer: PtySpawnConfirmation | null
  /** `reattach` rejects with this when set. */
  refuseReattach: unknown
}

const attached = (conversationId: string | null = LIVE_ID): PtySpawnConfirmation => ({
  pid: 777,
  ownsStartupDeadline: true,
  attached: { seq: 12, conversationId }
})

function fakeBackend(): Backend {
  const b: Backend = {
    specs: [],
    handles: [],
    reattached: [],
    spawnAnswer: null,
    refuseReattach: null
  }
  const make = (confirmation: PtySpawnConfirmation | null): unknown => {
    let dataCb: ((d: string) => void) | undefined
    let exitCb: ((e: Exit) => void) | undefined
    const h: FakeHandle = {
      print: (d) => dataCb?.(d),
      exit: (e) => exitCb?.(e),
      killed: false,
      written: [],
      resized: []
    }
    b.handles.push(h)
    return {
      ...(confirmation ? { whenSpawned: Promise.resolve(confirmation) } : {}),
      pid: confirmation?.pid ?? 4000 + b.handles.length,
      process: 'zsh',
      computerId: 'pc',
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
        queueMicrotask(() => exitCb?.({ exitCode: 0, signal: 9 }))
      },
      resize: (cols: number, rows: number) => {
        h.resized.push([cols, rows])
      }
    }
  }
  setPtyBackend({
    spawn: (spec: PtySpawnSpec) => {
      b.specs.push(spec)
      const answer = b.spawnAnswer
      b.spawnAnswer = null
      return Promise.resolve(make(answer ?? { pid: 4100, ownsStartupDeadline: true })) as never
    },
    reattach: async (computerId: string, sessionId: string, fromSpawnId: string, opts: unknown) => {
      b.reattached.push({ computerId, sessionId, fromSpawnId, opts })
      if (b.refuseReattach) throw b.refuseReattach
      return make(attached()) as never
    }
  } as unknown as PtyBackend)
  return b
}

let skew = 0
const realNow = Date.now
const exits: Array<{ id: string; code: number | null }> = []
const opened: string[] = []
let resolverCalls = 0
let locatorCalls = 0

beforeEach(() => {
  skew = 0
  diag.length = 0
  exits.length = 0
  store.calls.length = 0
  resolverCalls = 0
  locatorCalls = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  ptyEvents.on('exit', (id: string, code: number | null) => {
    exits.push({ id, code })
  })
  setConversationResolver(async () => {
    resolverCalls++
    return null
  })
  setClaudeTranscriptLocator(async (req) => {
    locatorCalls++
    return req.sessionIds.map((sessionId) => ({ sessionId, found: true, resumeCwd: null }))
  })
})
afterEach(() => {
  for (const id of opened.splice(0)) killPty(id)
  ptyEvents.removeAllListeners()
  setConversationResolver(null)
  setClaudeTranscriptLocator(null)
  setPtyBackend(null)
  resetAutoResumeForTests()
  vi.restoreAllMocks()
})

let n = 0
const nextSessionId = (): string => `atTask${++n}:atTask${n}`
const agentOpts = (sid: string, over: Record<string, unknown> = {}) =>
  ({
    win: fakeWin,
    sessionId: sid,
    computerId: 'pc',
    projectId: 'proj-1',
    cwd: '/work/repo',
    mode: 'claude-code',
    type: 'claude-code',
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '',
    ...over
  }) as never

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100))
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = realNow() + ms
  while (!cond()) {
    if (realNow() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const events = (name: string) => diag.filter((e) => e.event === name)

test('a start the computer answers by taking the live session over: the agent just runs on', async () => {
  const b = fakeBackend()
  b.spawnAnswer = attached()
  const sid = nextSessionId()
  const res = await createPty(agentOpts(sid, { existingConversationId: ID }))
  expect(res.success).toBe(true)
  opened.push(sid)
  await settle()

  // Running, not starting: it is long past its startup.
  expect(getState(sid)).not.toBe('starting')
  expect(hasLivePty(sid)).toBe(true)
  expect(exits).toEqual([])
  // This launch's provenance row is gone: the live agent keeps its own.
  const recorded = store.calls.filter((c) => c.method === 'recordPendingSpawn').length
  const pruned = store.calls.filter((c) => c.method === 'prunePendingSpawns')
  expect(pruned).toHaveLength(recorded)
  expect(events('pty.orphan_adopted')).toMatchObject([
    { payload: { computerId: 'pc', via: 'spawn', conversationId: LIVE_ID } }
  ])

  // Its conversation is the one it reports: an unexpected death past the start
  // window resumes THAT one (fix 5's rules apply to it like to any agent).
  skew += 11_000
  b.handles[0]!.exit({ exitCode: 129 })
  await until(() => b.specs.length === 2)
  expect(JSON.stringify(b.specs[1]!.args)).toContain(LIVE_ID)
})

test('attach intent: takes a listed session over and launches nothing', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  const res = await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))
  expect(res.success, JSON.stringify(res)).toBe(true)
  opened.push(sid)
  await settle()

  expect(b.specs).toEqual([])
  expect(b.reattached).toEqual([
    {
      computerId: 'pc',
      sessionId: sid,
      fromSpawnId: 'run-1',
      opts: expect.objectContaining({ mode: 'claude-code', taskId: sid.split(':')[0] })
    }
  ])
  // No launch was built: no conversation resolved, healed or located, no provenance row.
  expect(resolverCalls).toBe(0)
  expect(locatorCalls).toBe(0)
  expect(store.calls.filter((c) => c.method === 'recordPendingSpawn')).toEqual([])
  expect(getState(sid)).not.toBe('starting')
  expect(hasLivePty(sid)).toBe(true)
  expect(events('pty.orphan_adopted')).toMatchObject([{ payload: { via: 'reattach' } }])
  // Input reaches it.
  expect(writePty(sid, 'hi')).toBe(true)
  expect(b.handles[0]!.written).toContain('hi')
})

test('attach intent refused: nothing runs, and the refusal is named', async () => {
  const b = fakeBackend()
  b.refuseReattach = Object.assign(new Error('attempt run-1 is not running'), {
    reattachRefusal: 'not-adoptable'
  })
  const sid = nextSessionId()
  const res = await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))
  expect(res).toMatchObject({
    success: false,
    code: 'attach-refused',
    attachRefusal: 'not-adoptable'
  })
  expect(hasPty(sid)).toBe(false)
  expect(b.specs).toEqual([])
})

test('attach intent for a session already tracked: refused, the tracked one untouched', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  expect((await createPty(agentOpts(sid, { existingConversationId: ID }))).success).toBe(true)
  opened.push(sid)
  const res = await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))
  expect(res).toMatchObject({
    success: false,
    code: 'attach-refused',
    attachRefusal: 'already-tracked'
  })
  expect(b.handles[0]!.killed).toBe(false)
  expect(b.reattached).toEqual([])
})

test('a plain shell tab is adopted the same way, and its exit just ends it', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  const res = await createPty(
    agentOpts(sid, {
      mode: 'terminal',
      type: 'terminal',
      initialCommand: null,
      resumeCommand: null,
      attach: { computerId: 'pc', spawnId: 'run-1' }
    })
  )
  expect(res.success, JSON.stringify(res)).toBe(true)
  await settle()
  expect(b.reattached[0]?.opts).toMatchObject({ mode: 'terminal' })
  expect(hasLivePty(sid)).toBe(true)
  skew += 11_000
  b.handles[0]!.exit({ exitCode: 1 })
  await until(() => exits.some((e) => e.id === sid))
  expect(b.specs).toEqual([]) // no recovery shell, no resume: a shell that ended
})

// The hub has no size for a session it adopts on its own (no tab is on screen), and
// a running agent's TUI is laid out for the size it has: adopting must never resize
// it (an 80x24 placeholder would garble it). Only a client's own resize may.
test('adoption never resizes the running process; a client resize does', async () => {
  const b = fakeBackend()
  const attachedSid = nextSessionId()
  expect(
    (await createPty(agentOpts(attachedSid, { attach: { computerId: 'pc', spawnId: 'run-1' } })))
      .success
  ).toBe(true)
  opened.push(attachedSid)
  b.spawnAnswer = attached()
  const startedSid = nextSessionId()
  expect((await createPty(agentOpts(startedSid, { cols: 200, rows: 50 }))).success).toBe(true)
  opened.push(startedSid)
  await settle()
  expect(b.handles.map((h) => h.resized)).toEqual([[], []])

  expect(resizePty(attachedSid, 120, 40)).toBe(true)
  expect(b.handles[0]!.resized).toEqual([[120, 40]])
})

// Review H2: a tab's ordinary start (`pty.create`) is in its long preparation while the
// hub's own adoption attaches the running agent. The start must then BIND to the adopted
// session — never replace it (which killed the agent and resumed a twin).
test('a start racing the hub attach binds to the adopted session, never replaces it', async () => {
  const b = fakeBackend()
  // Held until released (every call: the resolver is retried on null).
  let held: Promise<void> = new Promise(() => undefined)
  let release: (id: null) => void = () => undefined
  held = new Promise<void>((r) => {
    release = () => r()
  })
  setConversationResolver(() => held.then(() => null))
  const sid = nextSessionId()
  const starting = createPty(agentOpts(sid)) // held at the resolver
  await settle()
  const attach = await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))
  expect(attach.success).toBe(true)
  opened.push(sid)
  release(null)
  expect((await starting).success).toBe(true)
  await settle()

  expect(b.specs).toEqual([]) // nothing started
  expect(b.handles[0]!.killed).toBe(false)
  expect(hasLivePty(sid)).toBe(true)
  expect(store.calls.filter((c) => c.method === 'recordPendingSpawn').length).toBe(
    store.calls
      .filter((c) => c.method === 'prunePendingSpawns')
      .reduce((n, c) => n + ((c.args as { ids: string[] }).ids?.length ?? 0), 0)
  )
  expect(events('pty.create_bound_to_adopted')).toHaveLength(1)
})

test('a start after the hub attached binds to the adopted session too', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  expect(
    (await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))).success
  ).toBe(true)
  opened.push(sid)
  expect((await createPty(agentOpts(sid, { existingConversationId: ID }))).success).toBe(true)
  await settle()
  expect(b.specs).toEqual([])
  expect(b.handles[0]!.killed).toBe(false)
  expect(events('pty.create_bound_to_adopted')).toHaveLength(1)
})

test('explicit replacement bypasses an adopted session and reaches the backend', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  expect(
    (await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))).success
  ).toBe(true)
  opened.push(sid)
  expect((await createPty(agentOpts(sid, { takeOver: false }))).success).toBe(true)
  expect(b.handles[0]!.killed).toBe(true)
  expect(b.specs).toHaveLength(1)
  expect(b.specs[0]).toMatchObject({ takeOver: false })
})

test('an explicit restart of an adopted session replaces it, and says so', async () => {
  const b = fakeBackend()
  const sid = nextSessionId()
  expect(
    (await createPty(agentOpts(sid, { attach: { computerId: 'pc', spawnId: 'run-1' } }))).success
  ).toBe(true)
  opened.push(sid)
  killPty(sid) // the user's restart: kill, then start
  expect((await createPty(agentOpts(sid, { existingConversationId: ID }))).success).toBe(true)
  await settle()
  expect(b.specs).toHaveLength(1)
  expect(events('pty.adopted_replaced')).toMatchObject([
    { payload: { reason: 'restart-requested' } }
  ])
})
