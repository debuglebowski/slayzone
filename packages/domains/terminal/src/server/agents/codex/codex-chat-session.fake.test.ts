/**
 * CodexChatSession against the fake `codex app-server` (`@slayzone/test-utils/
 * fake-codex`) as a real child process, including the driver bugs the X0
 * safety net found (all fixed now: plain assertions).
 *
 * Wire facts used below are codex-cli 0.159.2's, as recorded
 * (fake-codex/transcripts): server request ids count from 0, an answered or
 * withdrawn request is followed by `serverRequest/resolved`, `error`
 * notifications carry the raw API error JSON as their message.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  codexReply,
  commandTurn,
  createFakeCodex,
  cstep,
  cx,
  type CodexScenario,
  type FakeCodex
} from '@slayzone/test-utils/fake-codex'
import type { ChatDriverContext, ChatSessionDriver } from '../types'
import { codexChatBackend } from './codex-chat-session'

type CodexDriver = ChatSessionDriver &
  Required<Pick<ChatSessionDriver, 'applyControl' | 'respondPermission'>>
type Json = Record<string, unknown>

let root: string
let fake: FakeCodex
const children: ChildProcessWithoutNullStreams[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-driver-fake-'))
  fake = createFakeCodex({ root })
})

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  fake.dispose()
})

interface Live {
  driver: CodexDriver
  events: AgentEvent[]
  waitFor(pred: (e: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>
}

/** Spawn the fake the way chat does (`codex app-server`) and drive it with the real driver. */
async function live(scenario: CodexScenario, ctx: Partial<ChatDriverContext> = {}): Promise<Live> {
  fake.setScenario(scenario)
  const { args } = codexChatBackend.buildSpawnArgs({
    sessionId: '',
    resume: false,
    cwd: root,
    providerFlags: []
  })
  const child = spawn(path.join(fake.binDir, codexChatBackend.binaryName), args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const driver = codexChatBackend.createDriver() as CodexDriver
  const events: AgentEvent[] = []
  const waiters = new Set<() => void>()
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      driver.handleLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  void driver.start({
    write: (line) => child.stdin.write(`${line}\n`),
    emit: (e) => {
      events.push(e)
      for (const w of [...waiters]) w()
    },
    cwd: root,
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: 'gpt-6-luna',
    chatEffort: null,
    chatMode: 'auto-accept-edits',
    chatCollaboration: null,
    chatFastMode: false,
    ...ctx
  })
  const waitFor = (pred: (e: AgentEvent) => boolean, timeoutMs = 5000): Promise<AgentEvent> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = events.find(pred)
        if (!hit) return
        waiters.delete(check)
        clearTimeout(timer)
        resolve(hit)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`timeout; events: ${events.map((e) => e.kind).join(',')}`))
      }, timeoutMs)
      waiters.add(check)
      check()
    })
  await waitFor((e) => e.kind === 'turn-init')
  return { driver, events, waitFor }
}

const isResult = (e: AgentEvent): boolean => e.kind === 'result'

describe('CodexChatSession ⇄ fake codex app-server', () => {
  it('handshake, a streamed reply, the result — through the real child process', async () => {
    const l = await live({ processes: [{ turns: [codexReply('Hello from the fake')] }] })
    l.driver.sendUserMessage('hi')
    await l.waitFor(isResult)
    const kinds = l.events.map((e) => e.kind)
    expect(kinds).toEqual([
      'turn-init',
      'cli-models',
      'stream-message-start',
      'stream-block-start',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-stop',
      'stream-message-stop',
      'context-usage',
      'result'
    ])
    const text = l.events
      .filter(
        (e): e is Extract<AgentEvent, { kind: 'stream-block-delta' }> =>
          e.kind === 'stream-block-delta'
      )
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hello from the fake')
    const run = fake.current().run(0)!
    expect(run.userTexts()).toEqual(['hi'])
    expect(run.requests('thread/start')[0].params).toMatchObject({
      cwd: root,
      approvalPolicy: 'on-request'
    })
  })

  it('a command: tool-call at start, tool-result with the output at the end', async () => {
    const l = await live({
      processes: [{ turns: [commandTurn({ id: 'exec-1', command: 'ls', chunks: ['a\n', 'b\n'] })] }]
    })
    l.driver.sendUserMessage('run ls')
    await l.waitFor(isResult)
    expect(l.events.find((e) => e.kind === 'tool-call')).toMatchObject({
      id: 'exec-1',
      name: 'codex/commandExecution'
    })
    expect(l.events.find((e) => e.kind === 'tool-result')).toMatchObject({
      toolUseId: 'exec-1',
      isError: false,
      rawContent: 'a\nb\n'
    })
  })

  it('an approval: permission-request, the answer reaches the server as accept / decline', async () => {
    const cmd = { id: 'exec-a', command: 'touch a' }
    const l = await live({
      processes: [
        {
          defaultTurn: [
            cstep.emit(cx.commandStarted(cmd)),
            cstep.approveCommand(cmd, { accept: codexReply('ok'), decline: codexReply('no') })
          ]
        }
      ]
    })
    l.driver.sendUserMessage('one')
    const req = await l.waitFor((e) => e.kind === 'permission-request')
    expect(req).toMatchObject({
      requestId: '0',
      toolName: 'item/commandExecution/requestApproval',
      toolUseId: 'exec-a'
    })
    expect(l.driver.respondPermission({ requestId: '0', decision: { behavior: 'allow' } })).toBe(
      true
    )
    await l.waitFor(isResult)
    l.driver.sendUserMessage('two')
    await l.waitFor((e) => e.kind === 'permission-request' && e.requestId === '1')
    l.driver.respondPermission({ requestId: '1', decision: { behavior: 'deny', message: 'no' } })
    await l.waitFor((e) => e.kind === 'result' && l.events.filter(isResult).length === 2)
    expect(
      fake
        .current()
        .run(0)!
        .requestReplies()
        .map((r) => r.decision)
    ).toEqual(['accept', 'decline'])
  })

  it('an answer is recorded (permission-resolved, with the row picked): the card closes at once and a reload knows it', async () => {
    // Like Claude's driver: without it the card stays until a tool result or the
    // server's withdrawal — and a "No, stop" (cancel) brings neither.
    const cmd = { id: 'exec-r', command: 'rm -rf build' }
    const l = await live({
      processes: [
        {
          defaultTurn: [
            cstep.emit(cx.commandStarted(cmd)),
            cstep.approveCommand(cmd, { cancel: [cstep.endTurn('interrupted')] })
          ]
        }
      ]
    })
    l.driver.sendUserMessage('clean')
    await l.waitFor((e) => e.kind === 'permission-request')
    const decision = { behavior: 'deny' as const, message: '', interrupt: true }
    expect(l.driver.respondPermission({ requestId: '0', decision, optionId: 'cancel' })).toBe(true)
    expect(l.events.find((e) => e.kind === 'permission-resolved')).toEqual({
      kind: 'permission-resolved',
      requestId: '0',
      decision,
      optionId: 'cancel'
    })
    await l.waitFor(isResult)
    expect(fake.current().run(0)!.requestReplies()[0].decision).toBe('cancel')
  })

  it('Stop mid-turn: turn/interrupt names the running turn; the turn ends interrupted', async () => {
    const l = await live({
      processes: [
        {
          defaultTurn: [
            cstep.emit(cx.commandStarted({ id: 'e', command: 'sleep 20' })),
            cstep.hang()
          ]
        }
      ]
    })
    l.driver.sendUserMessage('go')
    await l.waitFor((e) => e.kind === 'tool-call')
    await l.driver.applyControl({ subtype: 'interrupt' }, 1000)
    const result = await l.waitFor(isResult)
    expect(result).toMatchObject({ subtype: 'interrupted' })
    const run = fake.current().run(0)!
    expect(run.interrupts()).toEqual([{ turnId: run.turnIds()[0], current: run.turnIds()[0] }])
  })
})

describe('CodexChatSession — open bugs (X0)', () => {
  it('Stop before the turn has an id interrupts once the id is known (like the TUI)', async () => {
    const l = await live({
      processes: [{ turnStart: { replyDelayMs: 500 }, defaultTurn: [cstep.hang()] }]
    })
    l.driver.sendUserMessage('go')
    // The turn/start reply (and turn/started) are still on their way: no id yet.
    await l.driver.applyControl({ subtype: 'interrupt' }, 1000)
    await new Promise((r) => setTimeout(r, 900))
    const run = fake.current().run(0)!
    expect(run.turnIds()).toHaveLength(1)
    // Audit "Codex Stop does nothing": the interrupt waits for the id, then goes.
    expect(run.interrupts().map((i) => i.turnId)).toEqual([run.turnIds()[0]])
    expect(l.events.find(isResult)).toMatchObject({ subtype: 'interrupted' })
  })

  it('a message is sent with its id (clientUserMessageId), so its turn can be found again', async () => {
    const l = await live({ processes: [{ turns: [codexReply('one')] }] })
    await l.driver.sendUserTurn!({ id: 'msg-1', content: [{ type: 'text', text: 'hi' }] })
    await l.waitFor(isResult)
    const run = fake.current().run(0)!
    expect(run.userTexts()).toEqual(['hi'])
    expect(run.clientMessageIds()).toEqual(['msg-1'])
  })

  it('Stop before any output, then forget the message: its turn is reverted (rewind_conversation)', async () => {
    const l = await live({
      processes: [{ turns: [codexReply('one')], defaultTurn: [cstep.hang()] }]
    })
    await l.driver.sendUserTurn!({ id: 'msg-1', content: [{ type: 'text', text: 'first' }] })
    await l.waitFor(isResult)
    await l.driver.sendUserTurn!({ id: 'msg-2', content: [{ type: 'text', text: 'second' }] })
    await l.driver.applyControl({ subtype: 'interrupt' }, 2000)
    const res = await l.driver.applyControl(
      { subtype: 'rewind_conversation', target_message_uuid: 'msg-2' },
      2000
    )
    expect(res).toEqual({ response: { rewound: true, prefillText: 'second' } })
    const run = fake.current().run(0)!
    expect(run.reverts()).toEqual([
      { threadId: run.threadId, beforeTurnId: run.turnIds()[1], dropped: 1 }
    ])
  })

  it('forgetting a message the thread never had answers target_not_found', async () => {
    const l = await live({ processes: [{ turns: [codexReply('one')] }] })
    const res = await l.driver.applyControl(
      { subtype: 'rewind_conversation', target_message_uuid: 'nope' },
      2000
    )
    expect(res).toEqual({ response: { rewound: false, reason: 'target_not_found' } })
    expect(fake.current().run(0)!.reverts()).toEqual([])
  })

  it('"always allow" answers acceptForSession', async () => {
    const cmd = { id: 'exec-s', command: 'touch s' }
    const l = await live({
      processes: [
        {
          defaultTurn: [
            cstep.emit(cx.commandStarted(cmd)),
            cstep.approveCommand(cmd, { default: codexReply('ok') })
          ]
        }
      ]
    })
    l.driver.sendUserMessage('go')
    await l.waitFor((e) => e.kind === 'permission-request')
    l.driver.respondPermission({
      requestId: '0',
      decision: { behavior: 'allow', scope: 'session' }
    })
    await l.waitFor(isResult)
    const run = fake.current().run(0)!
    expect(run.requestReplies()).toHaveLength(1)
    expect(run.requestReplies()[0].decision).toBe('acceptForSession')
  })

  it('a request the server withdrew (serverRequest/resolved after an interrupt) cancels its card', async () => {
    const cmd = { id: 'exec-z', command: 'touch z' }
    const l = await live({
      processes: [{ defaultTurn: [cstep.emit(cx.commandStarted(cmd)), cstep.approveCommand(cmd)] }]
    })
    l.driver.sendUserMessage('go')
    await l.waitFor((e) => e.kind === 'permission-request')
    await l.driver.applyControl({ subtype: 'interrupt' }, 1000)
    await l.waitFor(isResult)
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.current().run(0)!.sentMethods()).toContain('serverRequest/resolved')
    expect(l.events.some((e) => e.kind === 'permission-cancelled' && e.requestId === '0')).toBe(
      true
    )
  })

  it('live command output (item/commandExecution/outputDelta) reaches chat while the command runs', async () => {
    // The command-task path (plan 3.9, contract X1 → X2): a `command-task` for the
    // tool id while it runs, and `commandTaskOutput` serves what it printed so far.
    const cmd = { id: 'exec-o', command: 'build' }
    const l = await live({
      processes: [
        {
          turns: [
            [
              cstep.emit(cx.commandStarted(cmd)),
              cstep.emit(cx.commandOutput(cmd.id, 'step 1\n')),
              cstep.sleep(1_500),
              cstep.emit(cx.commandOutput(cmd.id, 'step 2\n')),
              cstep.emit(cx.commandCompleted({ ...cmd, output: 'step 1\nstep 2\n' })),
              ...codexReply('Built.')
            ]
          ]
        }
      ]
    })
    l.driver.sendUserMessage('build')
    await l.waitFor(
      (e) => e.kind === 'command-task' && e.toolUseId === cmd.id && e.status === 'running'
    )
    expect(l.driver.commandTaskOutput).toBeDefined()
    const read = () => l.driver.commandTaskOutput!(cmd.id)
    // While it runs (before its result): the output so far.
    let running = await read()
    for (let i = 0; i < 50 && !('output' in running && running.output.includes('step 1')); i++) {
      await new Promise((r) => setTimeout(r, 20))
      running = await read()
    }
    expect(running).toMatchObject({ state: 'running', output: 'step 1\n', truncated: false })
    expect(l.events.some((e) => e.kind === 'tool-result' && e.toolUseId === cmd.id)).toBe(false)
    // Once it ended: the whole output, and its command-task says so.
    await l.waitFor(isResult)
    expect(await read()).toMatchObject({ state: 'ended', output: 'step 1\nstep 2\n' })
    expect(
      l.events.some(
        (e) => e.kind === 'command-task' && e.toolUseId === cmd.id && e.status === 'completed'
      )
    ).toBe(true)
  })

  it('an API error is shown as its message, not as the raw JSON blob 0.159.2 sends (recipe bad-model)', async () => {
    const raw =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-x\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}'
    const l = await live({
      processes: [{ defaultTurn: [cstep.emit(cx.error(raw)), cstep.endTurn('failed', raw)] }]
    })
    l.driver.sendUserMessage('go')
    const err = (await l.waitFor((e) => e.kind === 'error')) as Extract<
      AgentEvent,
      { kind: 'error' }
    >
    expect(err.message).toContain('not supported')
    expect(err.message.trimStart().startsWith('{')).toBe(false)
  })

  it('a resume that fails for another reason than a missing thread is not reported as "not found"', async () => {
    const l = await liveResume({
      error: { code: -32000, message: 'stream disconnected before completion' }
    })
    const shown = await l.waitFor((e) => e.kind === 'stderr' || e.kind === 'error')
    const text = shown.kind === 'stderr' ? shown.text : shown.kind === 'error' ? shown.message : ''
    // Audit #2: only a missing thread may read as "not found" (a fresh start).
    expect(text).not.toMatch(/no conversation found/i)
    expect(shown).toMatchObject({
      kind: 'error',
      detail: { phase: 'resume', fatal: true, reason: 'stream disconnected before completion' }
    })
  })

  it('a thread the server does not have is reported as "not found" (recipe resume-missing)', async () => {
    const l = await liveResume({}, [])
    const shown = await l.waitFor((e) => e.kind === 'stderr' || e.kind === 'error')
    expect(shown).toMatchObject({ kind: 'stderr' })
    expect(shown.kind === 'stderr' && shown.text).toMatch(/no conversation found/i)
  })
})

/** Resume of a stored thread whose `thread/resume` answers `reply` (`threads`: what the server has). */
async function liveResume(reply: Json, threads: string[] = ['stored-thread']): Promise<Live> {
  fake.setScenario({
    processes: [{ handshake: { threadResume: reply } }],
    threads
  })
  const child = spawn(path.join(fake.binDir, 'codex'), ['app-server'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const driver = codexChatBackend.createDriver() as CodexDriver
  const events: AgentEvent[] = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      driver.handleLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  void driver.start({
    write: (line) => child.stdin.write(`${line}\n`),
    emit: (e) => events.push(e),
    cwd: root,
    sessionId: 'stored-thread',
    resume: true,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'auto-accept-edits',
    chatCollaboration: null,
    chatFastMode: false
  })
  return {
    driver,
    events,
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = events.find(pred)
        if (hit) return hit
        if (Date.now() > deadline)
          throw new Error(`timeout; events: ${events.map((e) => e.kind).join(',')}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  }
}

describe('CodexChatSession — thread commands', () => {
  it('/compact runs thread/compact/start: compact-status started → boundary + succeeded → result', async () => {
    const l = await live({ processes: [{ turns: [codexReply('one')] }] })
    await l.driver.sendUserTurn!({ id: 'msg-c', content: [{ type: 'text', text: '/compact' }] })
    await l.waitFor(isResult)
    const run = fake.current().run(0)!
    expect(run.compactions()).toBe(1)
    expect(run.requests('turn/start')).toHaveLength(0)
    const kinds = l.events
      .map((e) => e.kind)
      .filter((k) => k.startsWith('compact') || k === 'result')
    expect(kinds).toEqual(['compact-status', 'compact-boundary', 'compact-status', 'result'])
    expect(l.events.filter((e) => e.kind === 'compact-status')).toEqual([
      { kind: 'compact-status', phase: 'started' },
      { kind: 'compact-status', phase: 'succeeded' }
    ])
    expect(l.events.find((e) => e.kind === 'compact-boundary')).toEqual({
      kind: 'compact-boundary',
      trigger: 'manual'
    })
  })

  it('rewind before a message gives its text back (edit & resend)', async () => {
    const l = await live({ processes: [{ turns: [codexReply('one'), codexReply('two')] }] })
    await l.driver.sendUserTurn!({ id: 'm1', content: [{ type: 'text', text: 'first' }] })
    await l.waitFor(isResult)
    await l.driver.sendUserTurn!({ id: 'm2', content: [{ type: 'text', text: 'second' }] })
    await l.waitFor((e) => e.kind === 'result' && l.events.filter(isResult).length === 2)
    const res = await l.driver.applyControl(
      { subtype: 'rewind_conversation', target_message_uuid: 'm2' },
      2000
    )
    expect(res).toEqual({ response: { rewound: true, prefillText: 'second' } })
  })

  it('Codex keeps no file checkpoints: rewind_files says so (nothing to restore)', async () => {
    const l = await live({ processes: [{ turns: [codexReply('one')] }] })
    const res = await l.driver.applyControl(
      { subtype: 'rewind_files', user_message_id: 'm1', dry_run: true },
      2000
    )
    expect(res).toMatchObject({ response: { canRewind: false } })
    expect((res as { response: { error: string } }).response.error).toMatch(/Codex/)
  })
})
