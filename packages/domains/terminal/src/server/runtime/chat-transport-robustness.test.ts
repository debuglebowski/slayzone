/**
 * Plan Phase 1 ("never lose anything") at the transport: process generations,
 * the insert-only log, live vs saved events, the resume guard, the outbox and
 * the tool-aware watchdog — driven through the real transport with fake
 * children speaking Claude's stream-json.
 */
import { afterEach, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import { childProcessToHandle } from './chat-proc-handle'

interface Fake {
  child: ChildProcess
  emitter: EventEmitter
  stdout: PassThrough
  stderr: PassThrough
  /** Every stdin line, parsed. */
  stdin: Array<Record<string, unknown>>
  kills: string[]
  exit(code: number | null, signal?: string | null): void
}

function fake(opts: { exitOnKill?: boolean } = {}): Fake {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin: Array<Record<string, unknown>> = []
  const kills: string[] = []
  let buf = ''
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: {
      write: (s: string, cb?: (err?: Error | null) => void) => {
        buf += s
        let i = buf.indexOf('\n')
        while (i !== -1) {
          stdin.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>)
          buf = buf.slice(i + 1)
          i = buf.indexOf('\n')
        }
        cb?.()
        return true
      }
    },
    pid: 4242,
    kill: (sig?: string) => {
      kills.push(sig ?? 'SIGTERM')
      if (opts.exitOnKill) setImmediate(() => emitter.emit('exit', null, sig ?? 'SIGTERM'))
      return true
    }
  }) as unknown as ChildProcess
  return {
    child,
    emitter,
    stdout,
    stderr,
    stdin,
    kills,
    exit: (code, signal = null) => emitter.emit('exit', code, signal)
  }
}

const line = (fakeChild: Fake, obj: unknown): void => {
  fakeChild.stdout.write(JSON.stringify(obj) + '\n')
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const userMessages = (f: Fake): Array<Record<string, unknown>> =>
  f.stdin.filter((m) => m.type === 'user')

const init = (sessionId: string) => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'haiku',
  cwd: '/tmp',
  tools: [],
  claude_code_version: '2.1.312'
})
const text = (t: string, id = 'msg_1') => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text: t }] }
})
const toolUse = (id: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { id: 'msg_t', content: [{ type: 'tool_use', id, name: 'Bash', input }] }
})
const success = (numTurns = 1) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: numTurns,
  total_cost_usd: 0,
  result: 'ok'
})
const lifecycle = (uuid: string, state: string) => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state
})

interface Harness {
  fakes: Fake[]
  /** Every broadcast: saved (no `live`) and live. */
  broadcasts: Array<{ kind: string; seq: number; live?: number; event: AgentEvent }>
  /** Rows written to the store, in write order. */
  rows: Array<{ seq: number; event: AgentEvent }>
  clashes: number
  exits: number
}

function harness(
  opts: {
    exitOnKill?: boolean
    timings?: { startingBoundMs: number; runningStallMs: number; killGraceMs: number }
    alive?: () => boolean
  } = {}
): Harness {
  mgr.__resetForTests()
  const h: Harness = { fakes: [], broadcasts: [], rows: [], clashes: 0, exits: 0 }
  const seen = new Set<number>()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      const f = fake({ exitOnKill: opts.exitOnKill })
      h.fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    broadcastEvent: (_tab, event, seq, live) =>
      h.broadcasts.push({ kind: event.kind, seq, ...(live !== undefined ? { live } : {}), event }),
    broadcastExit: () => {
      h.exits++
    },
    broadcastStateChange: () => {},
    eventStore: {
      load: async () => [],
      insert: async (_tab, seq, event) => {
        if (seen.has(seq)) {
          h.clashes++
          return 'clash'
        }
        seen.add(seq)
        h.rows.push({ seq, event })
        return 'inserted'
      }
    },
    ...(opts.alive ? { isProcessAlive: opts.alive } : {}),
    ...(opts.timings ? { watchdogTimings: opts.timings } : {})
  })
  return h
}

const OPTS = {
  tabId: 'tab',
  taskId: 'task',
  mode: 'claude-chat',
  cwd: '/tmp',
  conversationId: null as string | null,
  providerFlags: [] as string[]
}

async function start(over: Partial<typeof OPTS> = {}): Promise<void> {
  await mgr.hydrateSession({ ...OPTS, ...over })
  await mgr.ensureSpawned(OPTS.tabId)
}

const saved = (h: Harness): AgentEvent[] =>
  h.broadcasts.filter((b) => b.live === undefined).map((b) => b.event)

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

// ---- 1.1 generations ----

test('a replaced process: nothing it says after the respawn reaches the history or the screen', async () => {
  const h = harness({ exitOnKill: true })
  await start()
  const old = h.fakes[0]
  await mgr.respawn(OPTS.tabId, { ...OPTS })
  expect(h.fakes).toHaveLength(2)
  const before = h.broadcasts.length
  // The old process's late output (it was writing when it was replaced).
  line(old, text('late words from the old process', 'msg_old'))
  old.stderr.write('old stderr\n')
  await wait(150)
  expect(h.broadcasts.slice(before)).toEqual([])
  expect(h.rows.some((r) => JSON.stringify(r.event).includes('old process'))).toBe(false)
})

test('a respawn waits for the old process to exit (SIGKILL after the grace) before starting the next', async () => {
  const h = harness()
  await start()
  const old = h.fakes[0]
  const respawned = mgr.respawn(OPTS.tabId, { ...OPTS })
  await wait(50)
  expect(old.kills).toEqual(['SIGTERM'])
  expect(h.fakes).toHaveLength(1)
  await wait(2100)
  expect(old.kills).toEqual(['SIGTERM', 'SIGKILL'])
  old.exit(null, 'SIGKILL')
  await respawned
  expect(h.fakes).toHaveLength(2)
}, 10_000)

test('seqs are the tab’s: a respawn never re-uses one, nothing is overwritten', async () => {
  const h = harness({ exitOnKill: true })
  await start()
  mgr.sendUserMessage(OPTS.tabId, 'one')
  line(h.fakes[0], init('s1'))
  line(h.fakes[0], text('reply one'))
  await wait(30)
  await mgr.respawn(OPTS.tabId, { ...OPTS })
  mgr.sendUserMessage(OPTS.tabId, 'two')
  line(h.fakes[1], init('s1'))
  line(h.fakes[1], text('reply two', 'msg_2'))
  await wait(30)
  const seqs = h.rows.map((r) => r.seq)
  expect(h.clashes).toBe(0)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(seqs.length)
})

test('Codex-style late result after exit is dropped (the session stays dead, not error)', async () => {
  const h = harness()
  await start()
  const f = h.fakes[0]
  f.exit(0)
  await wait(10)
  // A late line from the dead process (e.g. a teardown-time result).
  line(f, success())
  await wait(50)
  expect(mgr.getSessionTerminalState(OPTS.tabId)).toBe('dead')
  expect(saved(h).filter((e) => e.kind === 'result')).toEqual([])
})

// ---- N1 / 1.5 outbox ----

test('the message that lazily starts the agent reaches it (ready before the write)', async () => {
  const h = harness()
  await mgr.hydrateSession({ ...OPTS })
  const sent = mgr.dispatchUserMessage(OPTS.tabId, {
    id: 'm-first',
    content: [{ type: 'text', text: 'first message' }]
  })
  expect(sent.state).toBe('queued')
  await wait(50)
  expect(userMessages(h.fakes[0])).toEqual([
    { type: 'user', uuid: 'm-first', message: { role: 'user', content: 'first message' } }
  ])
})

test('delivery states come from the CLI: queued → delivered, completed → answered (saved)', async () => {
  const h = harness()
  await start()
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'hi' }] })
  const f = h.fakes[0]
  line(f, lifecycle('m1', 'queued'))
  line(f, lifecycle('m1', 'started'))
  line(f, init('s1'))
  line(f, text('hello'))
  line(f, lifecycle('m1', 'completed'))
  line(f, success())
  await wait(30)
  const delivery = h.broadcasts.filter((b) => b.kind === 'user-message-delivery')
  expect(delivery.map((b) => [(b.event as { state: string }).state, b.live !== undefined])).toEqual(
    [
      ['sending', true],
      ['delivered', false],
      ['answered', false]
    ]
  )
  expect(h.rows.some((r) => r.event.kind === 'command-lifecycle')).toBe(false)
})

test('a process that dies before confirming fails the message, visibly', async () => {
  const h = harness()
  await start()
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'hi' }] })
  h.fakes[0].exit(1)
  await wait(30)
  const failed = saved(h).find((e) => e.kind === 'user-message-delivery' && e.state === 'failed')
  expect(failed).toBeTruthy()
})

test('a start failure is a typed error in the chat and fails the message', async () => {
  harness()
  mgr.setTransportDepsForTests({
    whichBinary: async () => null,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  const errors: AgentEvent[] = []
  mgr.configureTransport({ broadcastEvent: (_t, e) => errors.push(e) })
  await mgr.hydrateSession({ ...OPTS })
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'hi' }] })
  await wait(50)
  expect(errors.find((e) => e.kind === 'error')).toMatchObject({
    detail: { code: 'cli-not-installed', binary: 'claude' }
  })
  expect(errors.find((e) => e.kind === 'user-message-delivery')).toMatchObject({
    id: 'm1',
    state: 'failed'
  })
  expect(mgr.getSessionTerminalState(OPTS.tabId)).toBe('dead')
})

// ---- 1.4 resume guard ----

test('failed resume: the fresh start receives the user’s message (same id), history kept', async () => {
  const h = harness({ exitOnKill: true })
  let invalid = 0
  await mgr.hydrateSession({ ...OPTS, conversationId: 'gone', onInvalidResume: () => invalid++ })
  mgr.dispatchUserMessage(OPTS.tabId, {
    id: 'm1',
    content: [{ type: 'text', text: 'hello again' }]
  })
  await wait(30)
  const first = h.fakes[0]
  first.stderr.write('No conversation found with session ID: gone\n')
  line(first, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    result: 'No conversation found with session ID: gone'
  })
  await wait(150)
  first.exit(1)
  await wait(200)
  expect(invalid).toBe(1)
  expect(h.fakes).toHaveLength(2)
  expect(userMessages(h.fakes[1])).toEqual([
    { type: 'user', uuid: 'm1', message: { role: 'user', content: 'hello again' } }
  ])
  // Withheld: the failure itself. Shown: the notice and the message (once).
  const kinds = saved(h).map((e) => e.kind)
  expect(kinds).not.toContain('stderr')
  expect(kinds).not.toContain('process-exit')
  expect(kinds).toContain('notice')
  expect(kinds.filter((k) => k === 'user-message')).toHaveLength(1)
})

test('a resumed first turn that fails for another reason shows the error', async () => {
  const h = harness()
  await mgr.hydrateSession({ ...OPTS, conversationId: 'exists' })
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'hi' }] })
  await wait(30)
  const f = h.fakes[0]
  line(f, init('exists'))
  line(f, {
    type: 'result',
    subtype: 'success',
    is_error: true,
    num_turns: 1,
    result: 'Invalid API key · Please run /login'
  })
  await wait(30)
  expect(saved(h).find((e) => e.kind === 'result')).toMatchObject({
    isError: true,
    text: 'Invalid API key · Please run /login'
  })
  expect(h.fakes).toHaveLength(1)
})

// ---- 1.3 live vs saved ----

test('streaming fragments are live only; one saved event per block; the replay snapshot redraws an open block', async () => {
  const h = harness()
  await start()
  const f = h.fakes[0]
  const se = (event: unknown) => ({ type: 'stream_event', event })
  line(f, se({ type: 'message_start', message: { id: 'msg_s' } }))
  line(f, se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  line(f, se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }))
  line(f, se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }))
  await wait(30)
  expect(h.rows.some((r) => r.event.kind.startsWith('stream-'))).toBe(false)
  const replay = mgr.getReplay(OPTS.tabId, -1)
  expect(replay.live.events.at(-1)).toMatchObject({ kind: 'stream-block-delta', text: 'Hello' })
  expect(replay.live.afterSeq).toBe(replay.events.at(-1)!.seq)
  // Claude's consolidated block, then the stop.
  line(f, text('Hello', 'msg_s'))
  line(f, se({ type: 'content_block_stop', index: 0 }))
  line(f, se({ type: 'message_stop' }))
  await wait(30)
  expect(h.rows.filter((r) => r.event.kind === 'assistant-text')).toHaveLength(1)
  expect(mgr.getReplay(OPTS.tabId, -1).live.events).toEqual([])
  const live = h.broadcasts.filter((b) => b.live !== undefined)
  expect(live.every((b, i) => i === 0 || b.live! > live[i - 1].live!)).toBe(true)
})

// ---- 1.6 tool-aware watchdog ----

test('a silent tool call within its own timeout is not killed; a silent turn without one is', async () => {
  const h = harness({
    timings: { startingBoundMs: 5000, runningStallMs: 150, killGraceMs: 50 },
    alive: () => true
  })
  await start()
  const f = h.fakes[0]
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'build' }] })
  line(f, toolUse('toolu_1', { command: 'sleep 600', timeout: 600_000 }))
  await wait(600)
  expect(f.kills).toEqual([])
  expect(mgr.getSessionTerminalState(OPTS.tabId)).toBe('running')
  // Tool returns; the turn then goes silent with nothing open → stall → killed.
  line(f, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] }
  })
  await wait(400)
  expect(f.kills[0]).toBe('SIGTERM')
  expect(saved(h).some((e) => e.kind === 'notice' && e.code === 'watchdog-killed')).toBe(true)
})

test('routed process that never confirms its kill still reaches dead (no endless loop)', async () => {
  mgr.__resetForTests()
  const kills: string[] = []
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: { write: (_s: string, cb?: () => void) => (cb?.(), true) },
    pid: 0,
    kill: (sig?: string) => (kills.push(sig ?? 'SIGTERM'), true)
  }) as unknown as ChildProcess
  mgr.setTransportDepsForTests({
    backend: {
      spawn: async () => {
        setImmediate(() => emitter.emit('spawn'))
        return childProcessToHandle(child)
      }
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {},
    watchdogTimings: { startingBoundMs: 5000, runningStallMs: 100, killGraceMs: 50 }
  })
  await start()
  mgr.dispatchUserMessage(OPTS.tabId, { id: 'm1', content: [{ type: 'text', text: 'hi' }] })
  await wait(600)
  expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
  expect(mgr.getSessionTerminalState(OPTS.tabId)).toBe('dead')
})

// ---- 1.9 version notice ----

test('an untested (older) CLI version gets a notice, once', async () => {
  const h = harness()
  await start()
  line(h.fakes[0], { ...init('s1'), claude_code_version: '2.1.100' })
  line(h.fakes[0], { ...init('s1'), claude_code_version: '2.1.100' })
  await wait(30)
  const notices = saved(h).filter((e) => e.kind === 'notice' && e.code === 'cli-version-untested')
  expect(notices).toHaveLength(1)
  expect((notices[0] as { text: string }).text).toContain('Untested Claude Code version 2.1.100')
})

test('a respawn resumes the conversation the tab already confirmed, even before the DB has its id', async () => {
  const h = harness({ exitOnKill: true })
  const spawned: string[][] = []
  mgr.configureTransport({
    spawn: (_cmd, args) => {
      spawned.push(args)
      const f = fake({ exitOnKill: true })
      h.fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    }
  })
  await start()
  const sessionId = spawned[0][spawned[0].indexOf('--session-id') + 1]
  mgr.sendUserMessage(OPTS.tabId, 'hi')
  line(h.fakes[0], init(sessionId))
  await wait(30)
  // A model change rebuilt the opts from a DB that has no conversation id yet.
  await mgr.respawn(OPTS.tabId, { ...OPTS, conversationId: null })
  expect(spawned[1]).toContain('--resume')
  expect(spawned[1][spawned[1].indexOf('--resume') + 1]).toBe(sessionId)
})

test('a respawn of a tab whose conversation never started keeps its unused id', async () => {
  const h = harness({ exitOnKill: true })
  const spawned: string[][] = []
  mgr.configureTransport({
    spawn: (_cmd, args) => {
      spawned.push(args)
      const f = fake({ exitOnKill: true })
      h.fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    }
  })
  await start()
  await mgr.respawn(OPTS.tabId, { ...OPTS, conversationId: null })
  expect(spawned[1]).not.toContain('--resume')
  expect(spawned[1][spawned[1].indexOf('--session-id') + 1]).toBe(
    spawned[0][spawned[0].indexOf('--session-id') + 1]
  )
})
