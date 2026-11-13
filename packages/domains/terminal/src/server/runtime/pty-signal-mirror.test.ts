/**
 * The hub mirrors what the process owner detected (`PtyHandle.onSignal`) instead of
 * parsing output itself — once the owner acknowledged the spawn's `detection`
 * (`detectsOutput`). Without the ack (local backend, an older computer or retained
 * session host) the hub keeps detecting the output it is delivered, as before.
 *
 * Fake routed handle + stub db — nothing spawns.
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import {
  clearBuffer,
  createPty,
  PtyOutputUnavailableError,
  watchPtyOutput,
  getBuffer,
  getBufferSince,
  getState,
  killPty,
  onPtyInputSubmit,
  setDatabase,
  writePty
} from './pty-manager'
import type { PtyInputFacts } from '../pty-input'
import { hasSessionUserInput } from '../user-input-tracker'
import { setPtyBackend, type PtyBackend, type PtySignal, type PtySpawnSpec } from './pty-backend'
import { ptyEvents } from './pty-events'
import { createFakeTaskSessionStore } from './fake-task-session-store'

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

const signal = (over: Partial<PtySignal>): PtySignal => ({
  seq: 0,
  activity: null,
  refreshIdleClock: false,
  preview: '',
  error: null,
  suppressOutput: false,
  prompt: null,
  title: null,
  devServerUrls: [],
  conversationId: null,
  ...over
})

function routedBackend(detectsOutput: boolean, computerId?: string) {
  const specs: PtySpawnSpec[] = []
  const writes: Array<[string, unknown]> = []
  const relays: boolean[] = []
  let dataCb: ((d: string) => void) | undefined
  let signalCb: ((s: PtySignal) => void) | undefined
  let inputCb: ((f: PtyInputFacts) => void) | undefined
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  setPtyBackend({
    spawn: (spec: PtySpawnSpec) => {
      specs.push(spec)
      return {
        pid: 4343,
        process: 'gemini',
        ...(computerId ? { computerId } : {}),
        detectsOutput,
        onData: (cb: (d: string) => void) => {
          dataCb = cb
          return { dispose: () => undefined }
        },
        onSignal: (cb: (s: PtySignal) => void) => {
          signalCb = cb
          return { dispose: () => undefined }
        },
        onInput: (cb: (f: PtyInputFacts) => void) => {
          inputCb = cb
          return { dispose: () => undefined }
        },
        onExit: (cb: (e: { exitCode: number }) => void) => {
          exitCb = cb
          return { dispose: () => undefined }
        },
        write: (data: string, opts?: unknown) => writes.push([data, opts]),
        kill: () => undefined,
        resize: () => undefined,
        setRelay: (on: boolean) => relays.push(on)
      } as never
    }
  } as PtyBackend)
  return {
    specs,
    writes,
    output: (d: string) => dataCb?.(d),
    signal: (s: PtySignal) => signalCb?.(s),
    input: (f: PtyInputFacts) => inputCb?.(f),
    exit: (exitCode: number) => exitCb?.({ exitCode }),
    relays
  }
}

function collect<E extends 'title-change' | 'dev-server-detected'>(
  event: E,
  sessionId?: string
): string[] {
  const seen: string[] = []
  ptyEvents.on(event, (id: string, value: string) => {
    if (sessionId === undefined || id === sessionId) seen.push(value)
  })
  return seen
}

const sessions: string[] = []
async function open(sessionId: string): Promise<void> {
  const res = await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'gemini',
    computerId: 'computer-1'
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  sessions.push(sessionId)
}

afterEach(() => {
  for (const id of sessions.splice(0)) killPty(id)
  ptyEvents.removeAllListeners()
})

test('the spawn asks the owner to detect output', async () => {
  const b = routedBackend(true)
  await open('mirror:spec')
  expect(b.specs[0]?.detection).toEqual(
    expect.objectContaining({ mode: 'gemini', resuming: false })
  )
})

test('owner detects: the hub does not parse output, and mirrors signals', async () => {
  const b = routedBackend(true)
  const titles = collect('title-change')
  const urls = collect('dev-server-detected')
  await open('mirror:on')
  // Would be a title + URL + working activity if the hub still parsed it.
  b.output(`\x1b]0;from output\x07${'x'.repeat(80)} http://localhost:5173`)
  expect(titles).toEqual([])
  expect(urls).toEqual([])

  b.signal(signal({ seq: 1, title: 'from owner', devServerUrls: ['http://localhost:4000'] }))
  expect(titles).toEqual(['from owner'])
  expect(urls).toEqual(['http://localhost:4000'])

  // Two working detections inside the window promote to running, as locally.
  b.signal(signal({ seq: 2, activity: 'working', refreshIdleClock: true, preview: 'x' }))
  b.signal(signal({ seq: 3, activity: 'working', refreshIdleClock: true, preview: 'x' }))
  await new Promise((r) => setTimeout(r, 150))
  expect(getState('mirror:on')).toBe('running')
})

test('owner runs the pipeline: the hub does not answer terminal queries a second time', async () => {
  const b = routedBackend(true)
  await open('mirror:query')
  b.output('\x1b[c')
  expect(b.writes).toEqual([])
})

test('owner did not acknowledge: the hub answers terminal queries, as before', async () => {
  const b = routedBackend(false)
  await open('mirror:query-local')
  b.output('\x1b[c')
  expect(b.writes.map(([d]) => d)).toEqual(['\x1b[?62;4;22c'])
})

test('owner did not acknowledge: the hub detects the output itself', async () => {
  const b = routedBackend(false)
  const titles = collect('title-change')
  const urls = collect('dev-server-detected')
  await open('mirror:off')
  b.output('\x1b]0;from output\x07 http://localhost:5173')
  expect(titles).toEqual(['from output'])
  expect(urls).toEqual(['http://localhost:5173'])
})

test('submitting the session-id command (gemini: /stats) tells the owner to watch for a conversation id', async () => {
  const b = routedBackend(true)
  await open('mirror:status')
  b.output('> ')
  writePty('mirror:status', '/stats\r')
  expect(b.writes.at(-1)).toEqual(['/stats\r', { watchConversationId: true }])
  writePty('mirror:status', 'hi\r')
  expect(b.writes.at(-1)).toEqual(['hi\r', undefined])
})

test("the owner's exitError becomes the session's error carried on exit", async () => {
  const b = routedBackend(true)
  // Only THIS session's exits: an earlier test's session, killed in afterEach on a fake
  // backend that never reports exit, is finalized by killPty's watchdog 500 ms later —
  // a `null` exit that landed here whenever this test ran slowly.
  const exits: Array<string | null> = []
  let exited!: () => void
  const firstExit = new Promise<void>((resolve) => {
    exited = resolve
  })
  ptyEvents.on('exit', (id: string, _code: number | null, errorCode: string | null) => {
    if (id !== 'mirror:exit-error') return
    exits.push(errorCode)
    exited()
  })
  await open('mirror:exit-error')
  b.output('$ ')
  b.signal(
    signal({
      seq: 1,
      exitError: { code: 'SESSION_NOT_FOUND', message: 'Session not found', recoverable: false }
    })
  )
  b.exit(0)
  await firstExit
  expect(exits).toEqual(['SESSION_NOT_FOUND'])
})

test('a reconnect snapshot applies the detected state at once, without repeating seen URLs', async () => {
  const b = routedBackend(true)
  const urls = collect('dev-server-detected', 'mirror:snapshot')
  const titles = collect('title-change', 'mirror:snapshot')
  await open('mirror:snapshot')
  b.output('$ ')
  b.signal(signal({ seq: 1, devServerUrls: ['http://localhost:5173'] }))
  b.signal(
    signal({
      seq: 9,
      snapshot: true,
      activity: 'working',
      title: 'while away',
      devServerUrls: ['http://localhost:5173', 'http://localhost:4000']
    })
  )
  await new Promise((r) => setTimeout(r, 150))
  // One snapshot is the computer's settled view: no two-detection gate.
  expect(getState('mirror:snapshot')).toBe('running')
  expect(titles).toEqual(['while away'])
  expect(urls).toEqual(['http://localhost:5173', 'http://localhost:4000'])
})

test('owner owns the output: no hub copy; replay, clear and seqs come from the owner', async () => {
  const replays: number[] = []
  let dataCb: ((d: string, seq?: number) => void) | undefined
  setPtyBackend({
    spawn: () =>
      ({
        pid: 4545,
        process: 'gemini',
        detectsOutput: true,
        ownsOutput: true,
        onData: (cb: (d: string, seq?: number) => void) => {
          dataCb = cb
          return { dispose: () => undefined }
        },
        onSignal: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: () => undefined,
        kill: () => undefined,
        resize: () => undefined,
        getReplay: async (afterSeq: number) => {
          replays.push(afterSeq)
          return { chunks: [{ seq: 41, data: 'from owner' }], prelude: '\x1b[0m', currentSeq: 41 }
        },
        clearOutput: async () => ({ clearedSeq: 41 })
      }) as never
  } as PtyBackend)
  const emitted: Array<[string, number]> = []
  ptyEvents.on('data', (id: string, data: string, seq: number) => {
    if (id === 'mirror:owner') emitted.push([data, seq])
  })
  await open('mirror:owner')
  dataCb?.('live chunk', 42)
  // Emitted under the OWNER's seq, so a client's reattach `afterSeq` is the owner's.
  expect(emitted).toEqual([['live chunk', 42]])
  expect(await getBufferSince('mirror:owner', 41)).toEqual({
    chunks: [{ seq: 41, data: 'from owner' }],
    prelude: '\x1b[0m',
    currentSeq: 41
  })
  expect(replays).toEqual([41])
  // No hub copy: the full buffer is the owner's replay too.
  expect(await getBuffer('mirror:owner')).toBe('\x1b[0mfrom owner')
  expect(await clearBuffer('mirror:owner')).toEqual({ success: true, clearedSeq: 41 })
})

test('output is relayed only while someone watches the session', async () => {
  const b = routedBackend(true)
  await open('mirror:relay')
  // Nobody watching at spawn: the owner keeps it to itself.
  expect(b.specs.at(-1)?.relay).toBe(false)
  const stop = watchPtyOutput(['mirror:relay'])
  expect(b.relays).toEqual([true])
  const stopAll = watchPtyOutput('all')
  stop()
  // Still watched (by the unfiltered watcher): no flip.
  expect(b.relays).toEqual([true])
  stopAll()
  expect(b.relays).toEqual([true, false])
})

test('a session spawned while watched starts relayed', async () => {
  const b = routedBackend(true)
  const stop = watchPtyOutput('all')
  await open('mirror:relay-on')
  expect(b.specs.at(-1)?.relay).toBe(true)
  stop()
})

test('first output known from the owner even when nothing is relayed', async () => {
  const b = routedBackend(true)
  await open('mirror:first')
  expect(getState('mirror:first')).toBe('starting')
  b.signal(signal({ seq: 0, firstOutput: true }))
  await new Promise((r) => setTimeout(r, 150))
  expect(getState('mirror:first')).toBe('idle')
})

test("owner's computer away: scrollback reads fail fast as unavailable, and recover", async () => {
  let availability: ((available: boolean) => void) | undefined
  let reachable = true
  setPtyBackend({
    spawn: () =>
      ({
        pid: 4646,
        process: 'gemini',
        detectsOutput: true,
        ownsOutput: true,
        onData: () => ({ dispose: () => undefined }),
        onSignal: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        onAvailability: (cb: (available: boolean) => void) => {
          availability = cb
          return { dispose: () => undefined }
        },
        write: () => undefined,
        kill: () => undefined,
        resize: () => undefined,
        getReplay: async () => {
          if (!reachable) throw new Error('computer unreachable')
          return { chunks: [{ seq: 3, data: 'back' }], prelude: '', currentSeq: 3 }
        },
        clearOutput: async () => ({ clearedSeq: 3 })
      }) as never
  } as PtyBackend)
  const events: boolean[] = []
  ptyEvents.on('output-availability', (id: string, available: boolean) => {
    if (id === 'mirror:offline') events.push(available)
  })
  await open('mirror:offline')
  reachable = false
  availability?.(false)
  expect(events).toEqual([false])
  await expect(getBufferSince('mirror:offline', -1)).rejects.toBeInstanceOf(
    PtyOutputUnavailableError
  )
  await expect(getBuffer('mirror:offline')).rejects.toBeInstanceOf(PtyOutputUnavailableError)
  reachable = true
  availability?.(true)
  expect(events).toEqual([false, true])
  expect(await getBufferSince('mirror:offline', 2)).toEqual({
    chunks: [{ seq: 3, data: 'back' }],
    prelude: '',
    currentSeq: 3
  })
})

test('a write the client sent straight to the computer has the effects of a relayed one', async () => {
  const b = routedBackend(true)
  const submitted: string[] = []
  const stop = onPtyInputSubmit((sessionId, _taskId, line) => {
    if (sessionId === 'mirror:direct-input') submitted.push(line)
  })
  await open('mirror:direct-input')
  b.input({ submitted: 'fix the bug\r', esc: false, statusCommand: false })
  expect(submitted).toEqual(['fix the bug\r'])
  // The attention mark a relayed submit sets (needs_attention on running → idle).
  expect(hasSessionUserInput('mirror:direct-input')).toBe(true)
  // Nothing was written by the hub: the computer already wrote it.
  expect(b.writes).toEqual([])
  // A blank submit marks nothing, as on the relayed path.
  b.input({ submitted: '  \r', esc: false, statusCommand: false })
  expect(submitted).toEqual(['fix the bug\r'])
  stop()
})

test('every write to a computer session is analysed on the computer, in ONE buffer: a hub-originated submit completes a line the client typed', async () => {
  const b = routedBackend(true, 'computer-1')
  const submitted: string[] = []
  const stop = onPtyInputSubmit((sessionId, _taskId, line) => {
    if (sessionId === 'mirror:one-buffer') submitted.push(line)
  })
  await open('mirror:one-buffer')
  writePty('mirror:one-buffer', 'hel', 'client-1')
  // A write the hub makes itself (submitPty, automations, the CLI) carries an id too:
  // the computer analyses it with what the client typed, and reports the facts.
  writePty('mirror:one-buffer', '\r')
  expect(b.writes).toEqual([
    ['hel', { writeId: 'client-1' }],
    ['\r', { writeId: expect.any(String) }]
  ])
  // No hub-side analysis: the line arrives once, from the computer's report.
  expect(submitted).toEqual([])
  b.input({ submitted: 'hel\r', esc: false, statusCommand: false })
  expect(submitted).toEqual(['hel\r'])
  stop()
})
