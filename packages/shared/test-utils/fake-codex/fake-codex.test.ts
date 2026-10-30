import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexEchoTurn,
  codexReply,
  codexTranscriptPath,
  commandTurn,
  createFakeCodex,
  cstep,
  cx,
  FAKE_CODEX_EXIT,
  FAKE_CODEX_VERSION,
  type CodexScenario,
  type FakeCodex,
  readCodexProtocolSurface
} from './index'

type Msg = Record<string, unknown>

interface Proc {
  child: ChildProcessWithoutNullStreams
  lines: Msg[]
  stderr: () => string
  send: (msg: Msg) => void
  request: (method: string, params?: unknown) => Promise<Msg>
  waitFor: (pred: (m: Msg) => boolean, timeoutMs?: number) => Promise<Msg>
  handshake: () => Promise<string>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

let root: string
let fake: FakeCodex
const procs: ChildProcessWithoutNullStreams[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'))
  fake = createFakeCodex({ root })
})

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  fake.dispose()
})

function start(args = ['app-server']): Proc {
  const child = spawn(path.join(fake.binDir, 'codex'), args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  procs.push(child)
  const lines: Msg[] = []
  let buf = ''
  let err = ''
  const waiters = new Set<() => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) lines.push(JSON.parse(line) as Msg)
      nl = buf.indexOf('\n')
    }
    for (const w of [...waiters]) w()
  })
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString('utf8')
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  )
  let nextId = 1
  const waitFor = (pred: (m: Msg) => boolean, timeoutMs = 5000): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        const hit = lines.find(pred)
        if (!hit) return false
        waiters.delete(w)
        clearTimeout(timer)
        resolve(hit)
        return true
      }
      const w = (): void => void check()
      const timer = setTimeout(() => {
        waiters.delete(w)
        reject(new Error(`timeout; got ${JSON.stringify(lines.map((l) => l.method ?? l.id))}`))
      }, timeoutMs)
      waiters.add(w)
      check()
    })
  const send = (msg: Msg): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }
  const request = (method: string, params?: unknown): Promise<Msg> => {
    const id = nextId++
    send({ id, method, params })
    return waitFor((m) => m.id === id && m.method === undefined)
  }
  return {
    child,
    lines,
    stderr: () => err,
    send,
    request,
    waitFor,
    exited,
    async handshake() {
      await request('initialize', { clientInfo: { name: 't', title: null, version: '1' } })
      send({ method: 'initialized' })
      const res = await request('thread/start', { cwd: root })
      return ((res.result as Msg).thread as Msg).id as string
    }
  }
}

const turnStart = (threadId: string, text: string) => ({
  threadId,
  input: [{ type: 'text', text, text_elements: [] }]
})
const methods = (p: Proc): string[] =>
  p.lines.map((l) => (l.method as string) ?? `#${String(l.id)}`)
const completed = (m: Msg): boolean => m.method === 'turn/completed'

describe('fake codex app-server — process', () => {
  it('reports the pinned CLI version, the one the protocol surface was generated from', () => {
    const out = spawnSync(path.join(fake.binDir, 'codex'), ['--version'], { encoding: 'utf8' })
    expect(out.stdout.trim()).toBe(`codex-cli ${FAKE_CODEX_VERSION}`)
    expect(readCodexProtocolSurface().cliVersion).toBe(FAKE_CODEX_VERSION)
  })

  it('exits 2 (argv drift) when not spawned as `app-server`', async () => {
    const epoch = fake.setScenario({ processes: [{}] })
    const p = start(['exec', 'hi'])
    expect((await p.exited).code).toBe(FAKE_CODEX_EXIT.argvDrift)
    expect(epoch.argvDrift()).toHaveLength(1)
  })

  it('exits 3 for a spawn past the scripted processes, and before any scenario', async () => {
    const p0 = start()
    expect((await p0.exited).code).toBe(FAKE_CODEX_EXIT.unscripted)
    expect(fake.orphans().filter((e) => e.kind === 'unscripted')).toHaveLength(1)
    const epoch = fake.setScenario({ processes: [] })
    const p1 = start()
    expect((await p1.exited).code).toBe(FAKE_CODEX_EXIT.unscripted)
    expect(epoch.unscripted()).toHaveLength(1)
  })

  it('answers without a `jsonrpc` field, like the real server, and announces the thread', async () => {
    fake.setScenario({ processes: [{}] })
    const p = start()
    const init = await p.request('initialize', {})
    expect(init).not.toHaveProperty('jsonrpc')
    expect(init.result).toMatchObject({ platformFamily: 'unix' })
    p.send({ method: 'initialized' })
    const res = await p.request('thread/start', { cwd: root, model: 'gpt-6-luna' })
    const thread = (res.result as Msg).thread as Msg
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((res.result as Msg).model).toBe('gpt-6-luna')
    await p.waitFor((m) => m.method === 'thread/started')
  })

  it('exits 0 at once when stdin closes, even mid-turn (recipe stdin-close-mid-turn)', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: [cstep.hang()] }] })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    await p.waitFor((m) => m.method === 'turn/started')
    p.child.stdin.end()
    expect((await p.exited).code).toBe(0)
    expect(p.lines.some(completed)).toBe(false)
    expect(epoch.run(0)?.has('stdin-end')).toBe(true)
  })

  it('exits 0 on SIGTERM with nothing more on stdout (recipe sigterm-mid-turn); onSigterm can talk first', async () => {
    fake.setScenario({
      processes: [
        { defaultTurn: [cstep.hang()] },
        {
          defaultTurn: [cstep.hang()],
          onSigterm: [cstep.emit(cx.error('late'))],
          sigtermExitCode: 143
        }
      ]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    await p.waitFor((m) => m.method === 'turn/started')
    const before = p.lines.length
    p.child.kill('SIGTERM')
    expect((await p.exited).code).toBe(0)
    expect(p.lines.length).toBe(before)

    const q = start()
    const t2 = await q.handshake()
    await q.request('turn/start', turnStart(t2, 'x'))
    await q.waitFor((m) => m.method === 'turn/started')
    q.child.kill('SIGTERM')
    expect((await q.exited).code).toBe(143)
    expect(q.lines.at(-1)?.method).toBe('error')
  })
})

describe('fake codex app-server — turns', () => {
  it('answers turn/start at once, then streams the turn and ends it (recipe simple-turn order)', async () => {
    const epoch = fake.setScenario({ processes: [{ turns: [codexReply('Hello there')] }] })
    const p = start()
    const thread = await p.handshake()
    const res = await p.request('turn/start', turnStart(thread, 'hi'))
    const turnId = ((res.result as Msg).turn as Msg).id
    expect((res.result as Msg).turn).toMatchObject({ status: 'inProgress' })
    const done = await p.waitFor(completed)
    expect(done.params).toMatchObject({
      threadId: thread,
      turn: { id: turnId, status: 'completed' }
    })
    const sent = methods(p).filter((m) => !m.startsWith('#'))
    expect(sent).toEqual([
      'thread/started',
      'thread/status/changed',
      'turn/started',
      'item/started',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
      'item/completed',
      'thread/tokenUsage/updated',
      'thread/status/changed',
      'turn/completed'
    ])
    const deltas = p.lines.filter((l) => l.method === 'item/agentMessage/delta')
    expect(deltas.map((d) => (d.params as Msg).delta)).toEqual(['Hello ', 'there'])
    expect((deltas[0].params as Msg).turnId).toBe(turnId)
    const run = await epoch.waitForRun(0)
    expect(run.userTexts()).toEqual(['hi'])
    expect(run.turnIds()).toEqual([turnId])
    expect(run.notifications()).toEqual(['initialized'])
  })

  it('substitutes {{userText}} and falls back to defaultTurn', async () => {
    fake.setScenario({
      processes: [{ turns: [codexReply('first')], defaultTurn: codexEchoTurn() }]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'one'))
    await p.waitFor(completed)
    await p.request('turn/start', turnStart(thread, 'two'))
    const item = await p.waitFor(
      (m) => m.method === 'item/completed' && JSON.stringify(m).includes('echo: two')
    )
    expect(((item.params as Msg).item as Msg).text).toBe('echo: two')
  })

  it('a turn past the script fails with an error naming it', async () => {
    fake.setScenario({ processes: [{ turns: [] }] })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    const done = await p.waitFor(completed)
    expect((done.params as { turn: Msg }).turn.status).toBe('failed')
    expect(p.lines.some((l) => l.method === 'error')).toBe(true)
  })

  it('plays a command with live output', async () => {
    fake.setScenario({
      processes: [{ turns: [commandTurn({ id: 'exec-1', command: 'ls', chunks: ['a\n', 'b\n'] })] }]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    await p.waitFor(completed)
    const out = p.lines.filter((l) => l.method === 'item/commandExecution/outputDelta')
    expect(out.map((o) => (o.params as Msg).delta)).toEqual(['a\n', 'b\n'])
    const done = p.lines.find(
      (l) =>
        l.method === 'item/completed' && ((l.params as Msg).item as Msg).type === 'commandExecution'
    )
    expect(done).toBeDefined()
    expect((done!.params as Msg).item).toMatchObject({
      aggregatedOutput: 'a\nb\n',
      exitCode: 0,
      status: 'completed'
    })
  })

  it('holds back the turn/start reply AND turn/started with turnStart.replyDelayMs', async () => {
    fake.setScenario({
      processes: [{ turnStart: { replyDelayMs: 400 }, turns: [codexReply('ok')] }]
    })
    const p = start()
    const thread = await p.handshake()
    const sentAt = Date.now()
    const res = p.request('turn/start', turnStart(thread, 'x'))
    await new Promise((r) => setTimeout(r, 200))
    expect(p.lines.some((l) => l.method === 'turn/started')).toBe(false)
    await res
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(380)
  })

  it('handshake replies can fail or hang', async () => {
    fake.setScenario({
      processes: [
        { handshake: { threadStart: { error: { code: -32000, message: 'auth expired' } } } },
        { handshake: { initialize: { hang: true } } }
      ]
    })
    const p = start()
    await p.request('initialize', {})
    const res = await p.request('thread/start', {})
    expect(res.error).toEqual({ code: -32000, message: 'auth expired' })
    const q = start()
    q.send({ id: 1, method: 'initialize', params: {} })
    await expect(q.waitFor((m) => m.id === 1, 500)).rejects.toThrow(/timeout/)
  })

  it('answers an unknown client method -32601 and logs it', async () => {
    const epoch = fake.setScenario({
      processes: [{ methods: { 'model/list': { result: { data: [] } } } }]
    })
    const p = start()
    expect((await p.request('model/list', {})).result).toEqual({ data: [] })
    // thread/fork is implemented now (X1); an API chat never calls stands in.
    expect((await p.request('thread/archive', {})).error).toMatchObject({ code: -32601 })
    expect((await epoch.waitForRun(0)).unknownMethods()).toEqual(['thread/archive'])
  })
})

describe('fake codex app-server — approvals', () => {
  const cmd = { id: 'exec-a', command: 'touch a.txt' }
  const scenario = (): CodexScenario => ({
    processes: [
      {
        defaultTurn: [
          cstep.emit(cx.commandStarted(cmd)),
          cstep.approveCommand(cmd, {
            accept: [cstep.emit(cx.commandCompleted(cmd)), ...codexReply('ran it')],
            acceptForSession: [
              cstep.emit(cx.commandCompleted(cmd)),
              ...codexReply('ran it, always')
            ],
            decline: [
              cstep.emit(cx.commandCompleted({ ...cmd, status: 'declined' })),
              ...codexReply('declined')
            ]
          })
        ]
      }
    ]
  })

  for (const decision of ['accept', 'acceptForSession', 'decline'] as const) {
    it(`blocks until the app replies, resolves the request, runs the ${decision} branch`, async () => {
      const epoch = fake.setScenario(scenario())
      const p = start()
      const thread = await p.handshake()
      await p.request('turn/start', turnStart(thread, 'x'))
      const req = await p.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
      expect(req.id).toBe(0) // server request ids count from 0 (0.159.2)
      expect(p.lines.some(completed)).toBe(false)
      p.send({ id: req.id as number, result: { decision } })
      await p.waitFor(completed)
      const resolvedAt = p.lines.findIndex((l) => l.method === 'serverRequest/resolved')
      expect((p.lines[resolvedAt].params as Msg).requestId).toBe(0)
      const run = await epoch.waitForRun(0)
      expect(run.requestReplies()).toMatchObject([
        { requestId: 0, method: 'item/commandExecution/requestApproval', decision }
      ])
      const text = { accept: 'ran it', acceptForSession: 'ran it, always', decline: 'declined' }[
        decision
      ]
      expect(JSON.stringify(p.lines)).toContain(text)
    })
  }

  it('an error reply runs the error branch', async () => {
    fake.setScenario({
      processes: [
        {
          defaultTurn: [
            cstep.approveCommand(cmd, {
              error: codexReply('saw an error'),
              accept: codexReply('no')
            })
          ]
        }
      ]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    const req = await p.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    p.send({ id: req.id as number, error: { code: -1, message: 'nope' } })
    await p.waitFor(completed)
    expect(JSON.stringify(p.lines)).toContain('saw an error')
  })
})

describe('fake codex app-server — interrupt', () => {
  it('acks {}, ends the turn interrupted, with no item/completed for the open item (recipe interrupt-command)', async () => {
    const cmd = { id: 'exec-s', command: 'sleep 20' }
    const epoch = fake.setScenario({
      processes: [{ defaultTurn: [cstep.emit(cx.commandStarted(cmd)), cstep.hang()] }]
    })
    const p = start()
    const thread = await p.handshake()
    const res = await p.request('turn/start', turnStart(thread, 'x'))
    const turnId = ((res.result as Msg).turn as Msg).id as string
    await p.waitFor((m) => m.method === 'item/started')
    const ack = await p.request('turn/interrupt', { threadId: thread, turnId })
    expect(ack.result).toEqual({})
    const done = await p.waitFor(completed)
    expect((done.params as { turn: Msg }).turn.status).toBe('interrupted')
    expect(p.lines.some((l) => l.method === 'item/completed')).toBe(false)
    const run = await epoch.waitForRun(0)
    expect(run.interrupts()).toEqual([{ turnId, current: turnId }])
    expect(run.interruptedTurns()).toEqual([turnId])
  })

  it('an unanswered request is resolved AFTER turn/completed (recipe approval-interrupt); a late reply is logged', async () => {
    const cmd = { id: 'exec-z', command: 'touch z.txt' }
    const epoch = fake.setScenario({
      processes: [{ defaultTurn: [cstep.emit(cx.commandStarted(cmd)), cstep.approveCommand(cmd)] }]
    })
    const p = start()
    const thread = await p.handshake()
    const res = await p.request('turn/start', turnStart(thread, 'x'))
    const turnId = ((res.result as Msg).turn as Msg).id as string
    const req = await p.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    await p.request('turn/interrupt', { threadId: thread, turnId })
    await p.waitFor((m) => m.method === 'serverRequest/resolved')
    const order = methods(p)
    expect(order.indexOf('turn/completed')).toBeLessThan(order.indexOf('serverRequest/resolved'))
    p.send({ id: req.id as number, result: { decision: 'accept' } })
    const run = await epoch.waitForRun(0, (r) => r.lateReplies().length > 0)
    expect(run.abandonedRequests()).toEqual([0])
  })

  it('refuses an interrupt without a turn id (required by the schema); the turn runs on', async () => {
    const epoch = fake.setScenario({
      processes: [{ defaultTurn: [cstep.sleep(300), ...codexReply('ok')] }]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    const ack = await p.request('turn/interrupt', { threadId: thread })
    expect(ack.error).toMatchObject({ code: -32600 })
    const done = await p.waitFor(completed)
    expect((done.params as { turn: Msg }).turn.status).toBe('completed')
    expect((await epoch.waitForRun(0)).interrupts()).toEqual([
      { turnId: null, current: expect.any(String) }
    ])
  })
})

describe('fake codex app-server — resume', () => {
  it('resumes a thread an earlier spawn started; an unknown one fails like 0.159.2 (recipe resume-missing)', async () => {
    const epoch = fake.setScenario({ processes: [{}, {}, {}] })
    const a = start()
    const thread = await a.handshake()
    a.child.stdin.end()
    await a.exited

    const b = start()
    await b.request('initialize', {})
    const ok = await b.request('thread/resume', { threadId: thread, cwd: root })
    expect(((ok.result as Msg).thread as Msg).id).toBe(thread)
    expect((await epoch.waitForRun(1)).resumedThread).toBe(thread)

    const c = start()
    await c.request('initialize', {})
    const missing = await c.request('thread/resume', { threadId: 'nope-123' })
    expect(missing.error).toEqual({
      code: -32600,
      message: 'no rollout found for thread id nope-123'
    })
  })

  it('accepts scenario.threads (a seeded conversation)', async () => {
    fake.setScenario({ processes: [{}], threads: ['seeded-1'] })
    const p = start()
    await p.request('initialize', {})
    const ok = await p.request('thread/resume', { threadId: 'seeded-1' })
    expect(ok.result).toBeDefined()
  })
})

describe('fake codex app-server — replay', () => {
  it('replays a recorded approval turn: blocks on the request under a fresh id, logs a different answer', async () => {
    const epoch = fake.setScenario({
      processes: [{ turns: [[cstep.replay(codexTranscriptPath('approval-exec'), { turn: 3 })]] }]
    })
    const p = start()
    const thread = await p.handshake()
    await p.request('turn/start', turnStart(thread, 'x'))
    const req = await p.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    expect(req.id).toBe(0)
    expect((req.params as Msg).threadId).toBe(thread)
    p.send({ id: 0, result: { decision: 'accept' } })
    const done = await p.waitFor(completed)
    expect((done.params as Msg).threadId).toBe(thread)
    const resolved = p.lines.filter((l) => l.method === 'serverRequest/resolved')
    expect(resolved.map((r) => (r.params as Msg).requestId)).toEqual([0])
    const run = await epoch.waitForRun(0)
    // The recording declined (turn 3); the replay continues with the recorded output.
    expect(run.replayMismatches()).toEqual([{ requestId: 2, recorded: 'decline', got: 'accept' }])
  })
})

describe('fake codex app-server — thread commands (X1)', () => {
  it('turns are kept by clientUserMessageId; revert, fork and turns/list agree', async () => {
    const epoch = fake.setScenario({
      processes: [{ turns: [codexReply('one'), codexReply('two')] }]
    })
    const p = start()
    await p.request('initialize', {})
    const thread = (
      (await p.request('thread/start', { cwd: root })).result as {
        thread: { id: string }
      }
    ).thread.id
    for (const [text, id] of [
      ['first', 'm1'],
      ['second', 'm2']
    ]) {
      await p.request('turn/start', {
        threadId: thread,
        input: [{ type: 'text', text, text_elements: [] }],
        clientUserMessageId: id
      })
      await p.waitFor(
        (m) =>
          m.method === 'turn/completed' &&
          p.lines.filter((l) => l.method === 'turn/completed').length === Number(id[1])
      )
    }
    const list = (await p.request('thread/turns/list', { threadId: thread, sortDirection: 'asc' }))
      .result as { data: Array<{ id: string; items: Array<{ clientId: string }> }> }
    expect(list.data.map((t) => t.items[0].clientId)).toEqual(['m1', 'm2'])
    const forked = (
      await p.request('thread/fork', { threadId: thread, lastTurnId: list.data[0].id })
    ).result as { thread: { id: string; forkedFromId: string } }
    expect(forked.thread.forkedFromId).toBe(thread)
    await p.request('thread/revert', { threadId: thread, beforeTurnId: list.data[1].id })
    const run = await epoch.waitForRun(0)
    expect(run.clientMessageIds()).toEqual(['m1', 'm2'])
    expect(run.forks()).toEqual([{ from: thread, threadId: forked.thread.id, kept: 1 }])
    expect(run.reverts()).toEqual([{ threadId: thread, beforeTurnId: list.data[1].id, dropped: 1 }])
  })
})
