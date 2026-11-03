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
import { createPty, getState, killPty, setDatabase, writePty } from './pty-manager'
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

function routedBackend(detectsOutput: boolean) {
  const specs: PtySpawnSpec[] = []
  const writes: Array<[string, unknown]> = []
  let dataCb: ((d: string) => void) | undefined
  let signalCb: ((s: PtySignal) => void) | undefined
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  setPtyBackend({
    spawn: (spec: PtySpawnSpec) => {
      specs.push(spec)
      return {
        pid: 4343,
        process: 'gemini',
        detectsOutput,
        onData: (cb: (d: string) => void) => {
          dataCb = cb
          return { dispose: () => undefined }
        },
        onSignal: (cb: (s: PtySignal) => void) => {
          signalCb = cb
          return { dispose: () => undefined }
        },
        onExit: (cb: (e: { exitCode: number }) => void) => {
          exitCb = cb
          return { dispose: () => undefined }
        },
        write: (data: string, opts?: unknown) => writes.push([data, opts]),
        kill: () => undefined,
        resize: () => undefined
      } as never
    }
  } as PtyBackend)
  return {
    specs,
    writes,
    output: (d: string) => dataCb?.(d),
    signal: (s: PtySignal) => signalCb?.(s),
    exit: (exitCode: number) => exitCb?.({ exitCode })
  }
}

function collect<E extends 'title-change' | 'dev-server-detected'>(event: E): string[] {
  const seen: string[] = []
  ptyEvents.on(event, (_id: string, value: string) => seen.push(value))
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
  const exits: Array<string | null> = []
  ptyEvents.on('exit', (_id: string, _code: number | null, errorCode: string | null) =>
    exits.push(errorCode)
  )
  await open('mirror:exit-error')
  b.output('$ ')
  b.signal(
    signal({
      seq: 1,
      exitError: { code: 'SESSION_NOT_FOUND', message: 'Session not found', recoverable: false }
    })
  )
  b.exit(0)
  await new Promise((r) => setTimeout(r, 200))
  expect(exits).toEqual(['SESSION_NOT_FOUND'])
})
