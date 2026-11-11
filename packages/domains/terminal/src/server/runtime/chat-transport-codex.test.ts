/**
 * Codex chat (`codex-chat`) through the real transport: the conversation the
 * app-server mints is the tab's own, resume failures are told apart (a missing
 * thread starts over; anything else keeps the conversation), and the notices
 * name Codex. Fake children speak the app-server's JSON-RPC (codex-cli 0.159.2
 * wire: responses without `jsonrpc`, the resume-missing error as recorded).
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import { onTaskReachedTerminal, setTaskAgentsStopper, stopTaskAgents } from '../task-events'
import { onTaskReachedTerminal as stopRuntimeTaskAgents } from './pty-manager'
import { createChatQueueRuntime } from './chat-queue-handlers'
import type { ChatQueueData } from './chat-queue-data'
import type { QueuedChatMessage } from '@slayzone/terminal-contracts'
import type { SlayzoneDb } from '@slayzone/platform'
import { chatTranscriptFromEvents, formatChatTranscript } from '../../shared/chat-transcript'

type Json = Record<string, unknown>
/** Answer to one request: a result, a JSON-RPC error, or nothing (hang). */
type Reply = { result: unknown } | { error: { code: number; message: string } } | 'hang'

interface CodexChild {
  child: ChildProcess
  /** Every stdin line, parsed. */
  stdin: Json[]
  requests(method: string): Json[]
  /** Write one server line. */
  send(msg: Json): void
  exit(code: number | null, signal?: string | null): void
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function codexChild(answer: (method: string, params: Json) => Reply | undefined): CodexChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin: Json[] = []
  let buf = ''
  const send = (msg: Json): void => {
    stdout.write(`${JSON.stringify(msg)}\n`)
  }
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    pid: 4242,
    kill: () => {
      setImmediate(() => emitter.emit('exit', null, 'SIGTERM'))
      return true
    },
    stdin: {
      write: (s: string, cb?: (err?: Error | null) => void) => {
        buf += s
        let i = buf.indexOf('\n')
        while (i !== -1) {
          const msg = JSON.parse(buf.slice(0, i)) as Json
          stdin.push(msg)
          buf = buf.slice(i + 1)
          i = buf.indexOf('\n')
          if (typeof msg.method === 'string' && msg.id !== undefined) {
            const reply = answer(msg.method, (msg.params ?? {}) as Json) ?? { result: {} }
            if (reply !== 'hang') setImmediate(() => send({ id: msg.id, ...reply }))
          }
        }
        cb?.()
        return true
      },
      end: () => undefined
    }
  }) as unknown as ChildProcess
  return {
    child,
    stdin,
    requests: (method) =>
      stdin.filter((m) => m.method === method).map((m) => (m.params ?? {}) as Json),
    send,
    exit: (code, signal = null) => emitter.emit('exit', code, signal)
  }
}

/** The default handshake: initialize, then a thread with `threadId`. */
function handshake(
  threadId: string,
  extra: (m: string, p: Json) => Reply | undefined = () => undefined
) {
  return (method: string, params: Json): Reply | undefined => {
    const own = extra(method, params)
    if (own) return own
    if (method === 'initialize')
      return {
        result: {
          userAgent: 'slayzone/0.159.2 (Mac OS 26.5.2; arm64) fake (slayzone; 1.0)',
          codexHome: '/h',
          platformFamily: 'unix',
          platformOs: 'macos'
        }
      }
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        result: {
          thread: { id: method === 'thread/resume' ? params.threadId : threadId },
          model: 'gpt-6-luna',
          cwd: '/tmp'
        }
      }
    if (method === 'model/list') return { result: { data: [] } }
    return undefined
  }
}

interface Harness {
  children: CodexChild[]
  events: AgentEvent[]
  persisted: Array<{ conversationId: string; origin: string }>
  invalidResumes: number
  states: string[]
}

let h: Harness

beforeEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})
afterEach(() => {
  setTaskAgentsStopper(() => {})
  mgr.__resetForTests()
})

/** Wire the transport to fake codex children; `answers[i]` scripts spawn #i. */
function setup(answers: Array<(method: string, params: Json) => Reply | undefined>): void {
  h = { children: [], events: [], persisted: [], invalidResumes: 0, states: [] }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/codex',
    spawn: () => {
      const answer = answers[h.children.length] ?? answers[answers.length - 1]
      const c = codexChild(answer)
      h.children.push(c)
      setImmediate(() => (c.child as unknown as EventEmitter).emit('spawn'))
      return c.child
    },
    broadcastEvent: (_tab, event) => h.events.push(event),
    broadcastExit: () => {},
    broadcastStateChange: (_id, state) => h.states.push(state)
  })
}

async function open(tabId: string, conversationId: string | null): Promise<void> {
  await mgr.hydrateSession({
    tabId,
    taskId: 'task-codex',
    mode: 'codex-chat',
    cwd: '/tmp',
    conversationId,
    providerFlags: [],
    onPersistSessionId: (p) => h.persisted.push(p),
    onInvalidResume: () => {
      h.invalidResumes++
    }
  })
  await mgr.ensureSpawned(tabId)
  await wait(60)
}

const notices = (): Array<Extract<AgentEvent, { kind: 'notice' }>> =>
  h.events.filter((e): e is Extract<AgentEvent, { kind: 'notice' }> => e.kind === 'notice')

test('a fresh thread: the id Codex minted is the tab’s own conversation (slay-spawned-fresh)', async () => {
  setup([handshake('thr-minted')])
  await open('tab-fresh', null)
  expect(h.children[0].requests('thread/start')).toHaveLength(1)
  expect(h.persisted).toEqual([{ conversationId: 'thr-minted', origin: 'slay-spawned-fresh' }])
  expect(mgr.confirmedConversation('tab-fresh')).toBe('thr-minted')
})

test('a restart after a fresh start resumes the minted thread', async () => {
  setup([handshake('thr-minted')])
  await open('tab-restart', null)
  h.children[0].exit(1)
  await wait(30)
  await mgr.ensureSpawned('tab-restart')
  await wait(60)
  expect(h.children).toHaveLength(2)
  expect(h.children[1].requests('thread/resume')).toEqual([
    expect.objectContaining({ threadId: 'thr-minted' })
  ])
  expect(h.children[1].requests('thread/start')).toHaveLength(0)
})

test('a resumed thread is recorded as slay-spawned-resume', async () => {
  setup([handshake('unused')])
  await open('tab-resume', 'thr-stored')
  expect(h.children[0].requests('thread/resume')).toEqual([
    expect.objectContaining({ threadId: 'thr-stored' })
  ])
  expect(h.persisted).toEqual([{ conversationId: 'thr-stored', origin: 'slay-spawned-resume' }])
})

test('a thread the server does not have: a fresh one starts, and the notice names Codex', async () => {
  setup([
    handshake('unused', (m) =>
      m === 'thread/resume'
        ? { error: { code: -32600, message: 'no rollout found for thread id thr-gone' } }
        : undefined
    ),
    handshake('thr-new')
  ])
  await open('tab-missing', 'thr-gone')
  await wait(100)
  expect(h.invalidResumes).toBe(1)
  expect(h.children).toHaveLength(2)
  expect(h.children[1].requests('thread/start')).toHaveLength(1)
  const notice = notices().find((n) => n.code === 'resume-failed-fresh-start')
  expect(notice?.text).toContain('Codex started a new one')
  expect(notice?.text).not.toContain('Claude')
  expect(h.persisted.at(-1)).toEqual({ conversationId: 'thr-new', origin: 'slay-spawned-fresh' })
})

test('a resume that fails for another reason keeps the conversation; Retry resumes it again', async () => {
  setup([
    handshake('unused', (m) =>
      m === 'thread/resume'
        ? { error: { code: -32000, message: 'stream disconnected before completion' } }
        : undefined
    ),
    handshake('unused')
  ])
  await open('tab-flaky', 'thr-kept')
  await wait(100)
  // Not a fresh start: the stored conversation stays the tab's.
  expect(h.invalidResumes).toBe(0)
  expect(h.children.flatMap((c) => c.requests('thread/start'))).toHaveLength(0)
  expect(notices().some((n) => n.code === 'resume-failed-fresh-start')).toBe(false)
  const kept = notices().find((n) => n.code === 'resume-failed-kept')
  expect(kept?.text).toContain('Codex')
  expect(kept?.text).toContain('stream disconnected before completion')
  expect(mgr.getSessionTerminalState('tab-flaky')).toBe('dead')
  // Retry: the same thread again.
  await mgr.ensureSpawned('tab-flaky')
  await wait(60)
  expect(h.children.at(-1)!.requests('thread/resume')).toEqual([
    expect.objectContaining({ threadId: 'thr-kept' })
  ])
  expect(mgr.getSessionTerminalState('tab-flaky')).toBe('idle')
})

// --- Stop (liveInterrupt): parity with Claude chat's live interrupt ---------------

/**
 * A scripted turn server on top of `handshake`: `turn/start` answers a turn id
 * (after `replyDelayMs`), `turn/interrupt` ends that turn `interrupted` (0.159.2:
 * reply, then `turn/completed`), `thread/turns/list` + `thread/revert` keep the
 * turns by `clientUserMessageId`.
 */
function turnServer(opts: { replyDelayMs?: number; refuseInterrupt?: boolean } = {}) {
  const turns: Array<{ id: string; clientId: string | null }> = []
  let child: CodexChild | null = null
  const reverts: string[] = []
  const forks: Array<{ from: string; lastTurnId: string }> = []
  const answer = handshake('thr-stop', (method, params) => {
    if (method === 'turn/start') {
      const id = `turn-${turns.length + 1}`
      turns.push({ id, clientId: (params.clientUserMessageId as string | undefined) ?? null })
      const reply = { result: { turn: { id, status: 'inProgress', items: [] } } }
      if (!opts.replyDelayMs) {
        setTimeout(() => child?.send({ method: 'turn/started', params: { turn: { id } } }), 5)
        return reply
      }
      setTimeout(() => {
        const start = child!.stdin.filter((m) => m.method === 'turn/start').at(-1)!
        child!.send({ id: start.id, ...reply })
        child!.send({ method: 'turn/started', params: { turn: { id } } })
      }, opts.replyDelayMs)
      return 'hang'
    }
    if (method === 'turn/interrupt') {
      if (opts.refuseInterrupt) return { error: { code: -32000, message: 'Cannot interrupt' } }
      setTimeout(
        () =>
          child?.send({
            method: 'turn/completed',
            params: { turn: { id: params.turnId, status: 'interrupted', durationMs: 1 } }
          }),
        5
      )
      return { result: {} }
    }
    if (method === 'thread/turns/list')
      return {
        result: {
          data: turns.map((t) => ({
            id: t.id,
            items: [{ type: 'userMessage', id: `u-${t.id}`, clientId: t.clientId }]
          })),
          nextCursor: null
        }
      }
    if (method === 'thread/fork') {
      forks.push({ from: String(params.threadId), lastTurnId: String(params.lastTurnId) })
      return { result: { thread: { id: 'thr-fork' }, model: 'gpt-6-luna', cwd: '/tmp' } }
    }
    if (method === 'thread/revert') {
      reverts.push(String(params.beforeTurnId))
      return { result: { thread: { id: 'thr-stop' } } }
    }
    return undefined
  })
  return {
    answer,
    turns,
    reverts,
    forks,
    bind: (c: CodexChild) => {
      child = c
    }
  }
}

async function openWithServer(
  server: ReturnType<typeof turnServer>,
  tabId: string
): Promise<CodexChild> {
  setup([server.answer])
  await open(tabId, null)
  server.bind(h.children[0])
  return h.children[0]
}

// A done task keeps no agent: completion stops chats too, even mid-turn. The CLI
// refuses `slay tasks done` on a task whose agent is mid-reply unless `--force`
// (REST done/update routes), so reaching this teardown mid-turn is deliberate.
test.each(['task-events', 'status-adapter', 'explicit-stop'])(
  'completion via %s stops a Codex chat, even mid-turn',
  async (path) => {
    const server = turnServer()
    const c = await openWithServer(server, 'tab-done')
    setTaskAgentsStopper(stopRuntimeTaskAgents)
    mgr.dispatchUserMessage('tab-done', {
      id: 'go-ahead',
      content: [{ type: 'text', text: 'Go ahead' }]
    })
    await until(() => c.requests('turn/start').length === 1)
    if (path === 'task-events') onTaskReachedTerminal('task-codex')
    else if (path === 'status-adapter') stopRuntimeTaskAgents('task-codex')
    else await stopTaskAgents('task-codex')
    await until(() => mgr.getSessionTerminalState('tab-done') === 'dead')
  }
)

test('a message queued during a Codex turn waits for completion; both turns finish idle', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-queued')
  const runtime = createChatQueueRuntime()
  const rows: QueuedChatMessage[] = []
  const unused = async (): Promise<never> => {
    throw new Error('unexpected queue operation')
  }
  const data: ChatQueueData = {
    list: async () => [...rows],
    push: async (tabId, send, original, opts) => {
      const row = { id: opts!.id!, tabId, send, original, position: rows.length, createdAt: 'now' }
      rows.push(row)
      return row
    },
    pop: async () => rows.shift() ?? null,
    requeue: async (row) => {
      rows.unshift(row)
    },
    update: unused,
    move: unused,
    remove: unused,
    clear: unused,
    getTabIdForItem: unused
  }
  const queue = runtime.createChatQueueOps({} as SlayzoneDb, data)
  try {
    mgr.dispatchUserMessage('tab-queued', {
      id: 'first',
      content: [{ type: 'text', text: 'work' }]
    })
    await until(() => c.requests('turn/start').length === 1)
    await queue.push('tab-queued', 'follow up', 'follow up', { id: 'second' })
    expect(await queue.list('tab-queued')).toHaveLength(1)
    expect(c.requests('turn/start')).toHaveLength(1)
    expect(mgr.getTurnStatus('tab-queued')).toMatchObject({ state: 'running', turnOpen: true })
    c.send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    await until(() => c.requests('turn/start').length === 2)
    expect(await queue.list('tab-queued')).toHaveLength(0)
    expect(c.requests('turn/start')[1]).toMatchObject({ clientUserMessageId: 'second' })
    c.send({ method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed' } } })
    await until(() => mgr.getSessionTerminalState('tab-queued') === 'idle')
    expect(mgr.getTurnStatus('tab-queued')).toMatchObject({ state: 'idle', turnOpen: false })
    expect(h.events.filter((e) => e.kind === 'result').map((e) => e.subtype)).toEqual([
      'completed',
      'completed'
    ])
    expect(c.requests('turn/interrupt')).toHaveLength(0)
    expect(c.requests('turn/steer')).toHaveLength(0)
    expect(h.children).toHaveLength(1)
  } finally {
    await runtime.close()
  }
})

const stopOpts = (tabId: string) => ({
  restorePrompt: true,
  respawnOpts: async () => ({
    tabId,
    taskId: 'task-codex',
    mode: 'codex-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  }),
  interruptTimeoutMs: 2000
})

const until = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time')
    await wait(5)
  }
}

test('Stop mid-turn: turn/interrupt in place, the process stays, the turn ends interrupted', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-stop')
  mgr.dispatchUserMessage('tab-stop', { id: 'm1', content: [{ type: 'text', text: 'go' }] })
  await until(() => server.turns.length === 1)
  c.send({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'working' } })
  await until(() => h.events.some((e) => e.kind === 'stream-block-delta'))
  await wait(20)

  const result = await mgr.stopTurn('tab-stop', stopOpts('tab-stop'))

  expect(result).toMatchObject({ popped: false, via: 'interrupt' })
  expect(c.requests('turn/interrupt')).toEqual([expect.objectContaining({ turnId: 'turn-1' })])
  expect(h.children).toHaveLength(1)
  await until(() => mgr.getSessionTerminalState('tab-stop') === 'idle')
  expect(h.states).not.toContain('error')
  expect(server.reverts).toEqual([])
})

test('after a Stop, the next turn takes "Send now" (turn/steer) again; while the stop is in flight it does not', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-steer')
  mgr.dispatchUserMessage('tab-steer', { id: 'm1', content: [{ type: 'text', text: 'go' }] })
  await until(() => server.turns.length === 1)
  c.send({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'working' } })
  await until(() => h.events.some((e) => e.kind === 'stream-block-delta'))
  await wait(20)
  expect(mgr.canSteer('tab-steer')).toBe(true)

  const stopping = mgr.stopTurn('tab-steer', stopOpts('tab-steer'))
  // The turn has not ended yet: it is being stopped, nothing is added to it.
  expect(mgr.getSessionTerminalState('tab-steer')).toBe('running')
  expect(mgr.canSteer('tab-steer')).toBe(false)
  expect(await stopping).toMatchObject({ popped: false, via: 'interrupt' })
  await until(() => mgr.getSessionTerminalState('tab-steer') === 'idle')
  expect(h.children).toHaveLength(1)

  mgr.dispatchUserMessage('tab-steer', { id: 'm2', content: [{ type: 'text', text: 'next' }] })
  await until(() => server.turns.length === 2)
  await wait(30)
  expect(mgr.getSessionTerminalState('tab-steer')).toBe('running')
  expect(mgr.canSteer('tab-steer')).toBe(true)
  expect(
    await mgr.steerUserMessage('tab-steer', {
      id: 's1',
      content: [{ type: 'text', text: 'also run lint' }]
    })
  ).toEqual({ ok: true })
  expect(c.requests('turn/steer')).toEqual([
    expect.objectContaining({ expectedTurnId: 'turn-2', clientUserMessageId: 's1' })
  ])
})

test('permission change stops the turn before continuing with the new sandbox and holds the queue', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-permissions')
  mgr.dispatchUserMessage('tab-permissions', {
    id: 'm1',
    content: [{ type: 'text', text: 'work' }]
  })
  await until(() => server.turns.length === 1)
  let persisted = false
  await mgr.changeCodexPermissionsAndResume('tab-permissions', 'approval-required', async () => {
    expect(server.turns).toHaveLength(1)
    expect(mgr.isReadyForQueuedMessage('tab-permissions')).toBe(false)
    persisted = true
  })
  await until(() => server.turns.length === 2)
  expect(persisted).toBe(true)
  expect(c.requests('turn/interrupt')).toHaveLength(1)
  expect(c.requests('turn/start')[1].sandboxPolicy).toMatchObject({ type: 'readOnly' })
  expect(mgr.getSessionInfo('tab-permissions')?.chatMode).toBe('approval-required')
  expect(h.children).toHaveLength(1)
  expect(server.reverts).toEqual([])
})

test('permission change after a turn finishes does not invent a continuation', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-permissions-idle')
  await mgr.changeCodexPermissionsAndResume('tab-permissions-idle', 'full-access', async () => {})
  expect(c.requests('turn/interrupt')).toHaveLength(0)
  expect(server.turns).toHaveLength(0)
  expect(mgr.getSessionInfo('tab-permissions-idle')?.chatMode).toBe('full-access')
})

test('a refused interrupt keeps permissions and never sends a continuation', async () => {
  const server = turnServer({ refuseInterrupt: true })
  await openWithServer(server, 'tab-permissions-refused')
  mgr.dispatchUserMessage('tab-permissions-refused', {
    id: 'm1',
    content: [{ type: 'text', text: 'work' }]
  })
  await until(() => server.turns.length === 1)
  const previous = mgr.getSessionInfo('tab-permissions-refused')?.chatMode
  let persisted = false
  await expect(
    mgr.changeCodexPermissionsAndResume(
      'tab-permissions-refused',
      'approval-required',
      async () => {
        persisted = true
      }
    )
  ).rejects.toThrow('Cannot interrupt')
  expect(persisted).toBe(false)
  expect(server.turns).toHaveLength(1)
  expect(mgr.getSessionInfo('tab-permissions-refused')?.chatMode).toBe(previous)
})

test('failure to save permissions restores the previous sandbox and releases the queue', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-permissions-save')
  await expect(
    mgr.changeCodexPermissionsAndResume('tab-permissions-save', 'full-access', async () => {
      throw new Error('Save failed')
    })
  ).rejects.toThrow('Save failed')
  expect(server.turns).toHaveLength(0)
  expect(mgr.isReadyForQueuedMessage('tab-permissions-save')).toBe(true)
  mgr.dispatchUserMessage('tab-permissions-save', {
    id: 'm1',
    content: [{ type: 'text', text: 'work' }]
  })
  await until(() => server.turns.length === 1)
  expect(c.requests('turn/start')[0].sandboxPolicy).toMatchObject({ type: 'workspaceWrite' })
})

test('Stop before any output: the message comes back and its turn leaves the thread (as Claude chat)', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-pop')
  mgr.dispatchUserMessage('tab-pop', { id: 'm1', content: [{ type: 'text', text: 'hello' }] })
  await until(() => server.turns.length === 1)
  await wait(20)

  const result = await mgr.stopTurn('tab-pop', stopOpts('tab-pop'))

  expect(result).toEqual({
    popped: true,
    text: 'hello',
    id: 'm1',
    content: [{ type: 'text', text: 'hello' }],
    via: 'interrupt'
  })
  expect(c.requests('turn/start')[0]).toMatchObject({ clientUserMessageId: 'm1' })
  expect(c.requests('turn/interrupt')).toHaveLength(1)
  expect(server.reverts).toEqual(['turn-1'])
  expect(h.children).toHaveLength(1)
  await until(() => mgr.getSessionTerminalState('tab-pop') === 'idle')
  expect(notices().some((n) => n.code === 'stop-rewind-failed')).toBe(false)
})

test('Stop before the turn has an id: the interrupt goes once the id arrives', async () => {
  const server = turnServer({ replyDelayMs: 150 })
  const c = await openWithServer(server, 'tab-early')
  mgr.dispatchUserMessage('tab-early', { id: 'm1', content: [{ type: 'text', text: 'go' }] })
  await until(() => c.requests('turn/start').length === 1)

  const result = await mgr.stopTurn('tab-early', stopOpts('tab-early'))

  expect(result).toMatchObject({ via: 'interrupt' })
  expect(c.requests('turn/interrupt')).toEqual([expect.objectContaining({ turnId: 'turn-1' })])
  expect(h.children).toHaveLength(1)
  await until(() => mgr.getSessionTerminalState('tab-early') === 'idle')
})

test('fork from an answered message: thread/fork through its turn; the new thread is the tab’s (slay-spawned-fork)', async () => {
  const server = turnServer()
  const c = await openWithServer(server, 'tab-fork')
  mgr.dispatchUserMessage('tab-fork', { id: 'm1', content: [{ type: 'text', text: 'first' }] })
  await until(() => server.turns.length === 1)
  c.send({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'answer' } })
  c.send({
    method: 'item/completed',
    params: { item: { type: 'agentMessage', id: 'a1', text: 'answer' } }
  })
  c.send({
    method: 'turn/completed',
    params: { turn: { id: 'turn-1', status: 'completed', durationMs: 1 } }
  })
  await until(() => mgr.getSessionTerminalState('tab-fork') === 'idle')
  await wait(20)

  const res = await mgr.forkTab('tab-fork', {
    messageId: 'm1',
    respawnOpts: stopOpts('tab-fork').respawnOpts
  })
  await until(() => mgr.confirmedConversation('tab-fork') === 'thr-fork')

  expect(res.fromConversationId).toBe('thr-stop')
  expect(server.forks).toEqual([{ from: 'thr-stop', lastTurnId: 'turn-1' }])
  expect(h.children).toHaveLength(2)
  expect(h.persisted.at(-1)).toEqual({ conversationId: 'thr-fork', origin: 'slay-spawned-fork' })
})

test('a fork Codex refuses takes the tab back to the original conversation', async () => {
  const server = turnServer()
  const refuse = (m: string, p: Json) =>
    m === 'thread/fork'
      ? ({ error: { code: -32600, message: 'cannot fork an in-progress turn' } } as Reply)
      : server.answer(m, p)
  setup([server.answer, refuse, server.answer])
  await open('tab-nofork', null)
  server.bind(h.children[0])
  const c = h.children[0]
  mgr.dispatchUserMessage('tab-nofork', { id: 'm1', content: [{ type: 'text', text: 'first' }] })
  await until(() => server.turns.length === 1)
  c.send({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'answer' } })
  c.send({
    method: 'item/completed',
    params: { item: { type: 'agentMessage', id: 'a1', text: 'answer' } }
  })
  c.send({
    method: 'turn/completed',
    params: { turn: { id: 'turn-1', status: 'completed', durationMs: 1 } }
  })
  await until(() => mgr.getSessionTerminalState('tab-nofork') === 'idle')
  await wait(20)

  await mgr.forkTab('tab-nofork', {
    messageId: 'm1',
    respawnOpts: stopOpts('tab-nofork').respawnOpts
  })
  await until(() => notices().some((n) => n.code === 'fork-failed'), 3000)

  expect(notices().find((n) => n.code === 'fork-failed')?.text).toContain('Codex could not fork')
  await until(() => mgr.confirmedConversation('tab-nofork') === 'thr-stop', 3000)
})

// --- Sessions: switching to another conversation ----------------------------------

test('a switch to another Codex conversation shows its past (thread/turns/list), once, before it runs', async () => {
  const pastTurns = {
    result: {
      // newest first, as asked (`sortDirection: 'desc'`)
      data: [
        {
          id: 'old-2',
          items: [
            {
              type: 'userMessage',
              id: 'u2',
              clientId: 'msg-2',
              content: [{ type: 'text', text: 'second' }]
            },
            {
              type: 'commandExecution',
              id: 'x2',
              command: 'ls',
              cwd: '/tmp',
              status: 'completed',
              aggregatedOutput: 'a\n',
              exitCode: 0
            },
            { type: 'agentMessage', id: 'a2', text: 'done' }
          ]
        },
        {
          id: 'old-1',
          items: [
            {
              type: 'userMessage',
              id: 'u1',
              clientId: null,
              content: [{ type: 'text', text: 'first' }]
            },
            { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] },
            { type: 'agentMessage', id: 'a1', text: 'hi' }
          ]
        }
      ],
      nextCursor: null
    }
  }
  setup([handshake('thr-own', (m) => (m === 'thread/turns/list' ? pastTurns : undefined))])
  await open('tab-switch', null)
  await mgr.switchTabConversation('tab-switch', {
    conversationId: 'thr-other',
    branch: {
      kind: 'conversation-branch',
      reason: 'switched',
      conversationId: 'thr-other',
      source: 'sessions'
    },
    history: [],
    notices: [],
    historyFromAgent: true,
    respawnOpts: {
      tabId: 'tab-switch',
      taskId: 'task-codex',
      mode: 'codex-chat',
      cwd: '/tmp',
      conversationId: 'thr-other',
      providerFlags: []
    }
  })
  // The switched-to thread's turn-init comes after its past (asserted below): wait for
  // it, not for idle plus a fixed pause, which a loaded machine outran.
  await until(() =>
    h.events.some(
      (e) => e.kind === 'turn-init' && (e as { sessionId?: string }).sessionId === 'thr-other'
    )
  )

  const next = h.children[1]
  expect(next.requests('thread/resume')).toEqual([
    expect.objectContaining({ threadId: 'thr-other' })
  ])
  expect(next.requests('thread/turns/list')).toEqual([
    expect.objectContaining({ threadId: 'thr-other', itemsView: 'full', sortDirection: 'desc' })
  ])
  const afterBranch = h.events.slice(h.events.findIndex((e) => e.kind === 'conversation-branch'))
  const shown = afterBranch
    .filter((e) =>
      [
        'user-message',
        'assistant-text',
        'assistant-thinking',
        'tool-call',
        'tool-result',
        'turn-init'
      ].includes(e.kind)
    )
    .map((e) =>
      e.kind === 'user-message'
        ? `user:${e.text}:${e.history}:${e.id}`
        : e.kind === 'assistant-text'
          ? `text:${e.text}`
          : e.kind === 'turn-init'
            ? `init:${e.sessionId}`
            : e.kind
    )
  expect(shown).toEqual([
    'user:first:true:u1',
    'assistant-thinking',
    'text:hi',
    'user:second:true:msg-2',
    'tool-call',
    'tool-result',
    'text:done',
    'init:thr-other'
  ])

  // A later restart resumes without reading the past again.
  next.exit(1)
  await wait(30)
  await mgr.ensureSpawned('tab-switch')
  await wait(60)
  expect(h.children[2].requests('thread/turns/list')).toEqual([])
})

test('a Codex older than the tested one: a non-blocking warning naming Codex and its update', async () => {
  setup([
    handshake('thr-old', (m) =>
      m === 'initialize'
        ? { result: { userAgent: 'slayzone/0.139.0 (Mac OS 26.5.2; arm64) x (slayzone; 1.0)' } }
        : undefined
    )
  ])
  await open('tab-old', null)
  const notice = notices().find((n) => n.code === 'cli-version-untested')
  expect(notice?.text).toContain('Untested Codex version 0.139.0')
  expect(notice?.text).toContain('npm install -g @openai/codex')
  expect(mgr.getSessionTerminalState('tab-old')).toBe('idle')
})

// Audit 9f22908f: quiet reasoning was killed five minutes after visible output.
test('watchdog preserves a silent resumed Codex turn when its server answers a read-only probe', async () => {
  const server = turnServer()
  setup([
    handshake('unused', (method, params) =>
      method === 'thread/read'
        ? {
            result: {
              thread: {
                id: params.threadId,
                status: { type: 'active', activeFlags: [] }
              }
            }
          }
        : server.answer(method, params)
    )
  ])
  mgr.configureTransport({
    isProcessAlive: () => true,
    watchdogTimings: {
      startingBoundMs: 1000,
      runningStallMs: 60,
      killGraceMs: 20
    }
  })
  await open('tab-quiet', 'thr-audit')
  const c = h.children[0]
  server.bind(c)
  mgr.dispatchUserMessage('tab-quiet', {
    id: 'resume',
    content: [{ type: 'text', text: 'Resume' }]
  })
  await wait(240)
  expect(c.requests('thread/read').length).toBeGreaterThanOrEqual(2)
  expect(c.requests('turn/interrupt')).toHaveLength(0)
  expect(h.children).toHaveLength(1)
  expect(notices().some((e) => e.code === 'watchdog-killed')).toBe(false)
  expect(mgr.confirmedConversation('tab-quiet')).toBe('thr-audit')
  // A real Stop must still interrupt the same live turn.
  await mgr.stopTurn('tab-quiet', stopOpts('tab-quiet'))
  expect(c.requests('turn/interrupt')).toHaveLength(1)
})

test('failed watchdog probe records its cause and restarts with the original conversation', async () => {
  const server = turnServer()
  setup([
    handshake('unused', (method, params) =>
      method === 'thread/read'
        ? { error: { code: -32000, message: 'unavailable' } }
        : server.answer(method, params)
    )
  ])
  mgr.configureTransport({
    isProcessAlive: () => true,
    watchdogTimings: {
      startingBoundMs: 1000,
      runningStallMs: 60,
      killGraceMs: 20
    }
  })
  await open('tab-probe-failed', 'thr-audit')
  server.bind(h.children[0])
  mgr.dispatchUserMessage('tab-probe-failed', {
    id: 'resume',
    content: [{ type: 'text', text: 'Resume' }]
  })
  await until(() => h.children.length === 2)
  await until(() => h.children[1].requests('thread/resume').length === 1)
  expect(h.children[0].requests('thread/read')).toEqual([
    { threadId: 'thr-audit', includeTurns: false }
  ])
  expect(h.children[1].requests('thread/resume')).toEqual([
    expect.objectContaining({ threadId: 'thr-audit' })
  ])
  expect(h.invalidResumes).toBe(0)
  expect(h.events).toContainEqual(
    expect.objectContaining({ kind: 'process-exit', reason: 'watchdog' })
  )
  expect(chatTranscriptFromEvents(h.events).some((r) => r.text === 'interrupted by watchdog')).toBe(
    true
  )
})

test.each(['completion', 'Stop'] as const)(
  '%s while a watchdog probe waits prevents a late failed probe from killing the process',
  async (end) => {
    const server = turnServer()
    setup([
      handshake('unused', (method, params) =>
        method === 'thread/read' ? 'hang' : server.answer(method, params)
      )
    ])
    mgr.configureTransport({
      isProcessAlive: () => true,
      watchdogTimings: {
        startingBoundMs: 1000,
        runningStallMs: 60,
        killGraceMs: 20
      }
    })
    await open('tab-probe-race', 'thr-audit')
    const c = h.children[0]
    server.bind(c)
    mgr.dispatchUserMessage('tab-probe-race', {
      id: 'resume',
      content: [{ type: 'text', text: 'Resume' }]
    })
    await until(() => c.requests('thread/read').length === 1)
    const probe = c.stdin.find((m) => m.method === 'thread/read')!
    const stopping =
      end === 'Stop' ? mgr.stopTurn('tab-probe-race', stopOpts('tab-probe-race')) : null
    if (end === 'completion')
      c.send({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } }
      })
    c.send({ id: probe.id, error: { code: -32000, message: 'late failure' } })
    await stopping
    await until(() => mgr.getSessionTerminalState('tab-probe-race') === 'idle')
    await wait(100)
    expect(h.children).toHaveLength(1)
    expect(notices().some((e) => e.code === 'watchdog-killed')).toBe(false)
  }
)
