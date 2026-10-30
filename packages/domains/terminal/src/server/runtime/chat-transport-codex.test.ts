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
function turnServer(opts: { replyDelayMs?: number } = {}) {
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
  await until(() => h.children.length === 2 && mgr.getSessionTerminalState('tab-switch') === 'idle')
  await wait(30)

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
