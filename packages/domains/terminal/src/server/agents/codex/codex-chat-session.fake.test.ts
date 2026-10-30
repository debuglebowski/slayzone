/**
 * CodexChatSession against the fake `codex app-server` (`@slayzone/test-utils/
 * fake-codex`) as a real child process, plus the driver's still-open bugs found
 * by the X0 safety net (each `expectKnownBug`: green while the bug is there,
 * fails once it is fixed — then make it a plain assertion).
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
import { expectKnownBug } from '@slayzone/test-utils/known-bug'
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
      'stream-message-start',
      'stream-block-start',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-delta',
      'stream-block-stop',
      'stream-message-stop',
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
    await expectKnownBug(
      {
        fixedBy: 'Codex stop',
        what: 'Stop before the turn/start reply sends no turn/interrupt (audit: Codex Stop does nothing)'
      },
      () => expect(run.interrupts().map((i) => i.turnId)).toEqual([run.turnIds()[0]])
    )
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
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'addRules', destination: 'session' }]
      }
    })
    await l.waitFor(isResult)
    const run = fake.current().run(0)!
    expect(run.requestReplies()).toHaveLength(1)
    await expectKnownBug(
      {
        fixedBy: 'Codex approvals',
        what: 'allow-for-session is sent as plain accept (acceptForSession never used)'
      },
      () => expect(run.requestReplies()[0].decision).toBe('acceptForSession')
    )
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
    await expectKnownBug(
      {
        fixedBy: 'Codex approvals',
        what: 'serverRequest/resolved ignored: the withdrawn approval stays pending'
      },
      () =>
        expect(l.events.some((e) => e.kind === 'permission-cancelled' && e.requestId === '0')).toBe(
          true
        )
    )
  })

  it('live command output (item/commandExecution/outputDelta) reaches chat while the command runs', async () => {
    const l = await live({
      processes: [
        {
          turns: [
            commandTurn({
              id: 'exec-o',
              command: 'build',
              chunks: ['step 1\n', 'step 2\n'],
              gapMs: 50
            })
          ]
        }
      ]
    })
    l.driver.sendUserMessage('build')
    await l.waitFor(isResult)
    const beforeResult = l.events.slice(
      0,
      l.events.findIndex((e) => e.kind === 'tool-result')
    )
    await expectKnownBug(
      {
        fixedBy: 'Codex live output',
        what: 'outputDelta dropped: nothing shows until the command ends'
      },
      () => expect(JSON.stringify(beforeResult)).toContain('step 1')
    )
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
    await expectKnownBug(
      { fixedBy: 'Codex errors', what: 'error notifications show the raw API JSON as the message' },
      () => expect(err.message.trimStart().startsWith('{')).toBe(false)
    )
  })

  it('a resume that fails for another reason than a missing thread is not reported as "not found"', async () => {
    const l = await liveResume({
      error: { code: -32000, message: 'stream disconnected before completion' }
    })
    const shown = await l.waitFor((e) => e.kind === 'stderr' || e.kind === 'error')
    const text = shown.kind === 'stderr' ? shown.text : shown.kind === 'error' ? shown.message : ''
    await expectKnownBug(
      {
        audit: '#2',
        fixedBy: 'Codex resume',
        what: 'any thread/resume error (timeout, network) is reported as "No conversation found" → the conversation is dropped'
      },
      () => expect(text).not.toMatch(/no conversation found/i)
    )
  })
})

/** Resume of a stored thread whose `thread/resume` answers `reply`. */
async function liveResume(reply: Json): Promise<Live> {
  fake.setScenario({
    processes: [{ handshake: { threadResume: reply } }],
    threads: ['stored-thread']
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
