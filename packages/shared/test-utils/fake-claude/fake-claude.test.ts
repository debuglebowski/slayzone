import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFakeClaude,
  ev,
  echoTurn,
  type FakeClaude,
  FAKE_CLAUDE_EXIT,
  reply,
  step,
  transcriptPath,
  transcriptStdout
} from './index'

// The flags SlayZone's chat transport always passes (claude-code-adapter.ts). The
// parity check that the adapter really builds these lives in the terminal package
// (claude-stream-drift.test.ts) — this package cannot depend on it.
const CHAT_ARGV = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio'
]

interface Proc {
  child: ChildProcessWithoutNullStreams
  lines: Array<Record<string, unknown>>
  chunks: Buffer[]
  stderr: () => string
  send: (msg: unknown) => void
  waitFor: (
    pred: (ev: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

let root: string
let fake: FakeClaude
const procs: ChildProcessWithoutNullStreams[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  fake = createFakeClaude({ root })
})

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  fake.dispose()
})

function start(
  extraArgs: string[] = ['--session-id', 'sess-1', '--model', 'haiku'],
  args = CHAT_ARGV
): Proc {
  const child = spawn(path.join(fake.binDir, 'claude'), [...args, ...extraArgs], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  procs.push(child)
  const lines: Array<Record<string, unknown>> = []
  const chunks: Buffer[] = []
  let buf = ''
  let err = ''
  // A decoder, not per-chunk toString: the fake splits characters across chunks on
  // purpose (emitSplit), and a per-chunk decode would garble them right here.
  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', (d: Buffer) => {
    chunks.push(d)
    buf += decoder.write(d)
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        lines.push({ raw: line })
      }
    }
  })
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString('utf8')
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  )
  return {
    child,
    lines,
    chunks,
    stderr: () => err,
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    exited,
    async waitFor(pred, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = lines.find(pred)
        if (hit) return hit
        if (Date.now() > deadline) {
          throw new Error(`no matching stdout line; got ${JSON.stringify(lines)} stderr=${err}`)
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  }
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const isResult = (e: Record<string, unknown>) => e.type === 'result'

describe('fake-claude — process basics', () => {
  it('prints a version like the real CLI', async () => {
    const p = start(['--version'], [])
    expect((await p.exited).code).toBe(0)
    expect(p.lines).toEqual([{ raw: expect.stringMatching(/^\d+\.\d+\.\d+ \(Claude Code\)$/) }])
  })

  it('fails loudly (exit 2) when the chat argv is missing a required flag', async () => {
    const epoch = fake.setScenario({ processes: [{ turns: [] }] })
    const p = start(
      ['--session-id', 's'],
      CHAT_ARGV.filter((a) => a !== '--verbose')
    )
    expect((await p.exited).code).toBe(FAKE_CLAUDE_EXIT.argvDrift)
    expect(p.stderr()).toContain('missing --verbose')
    expect(epoch.argvDrift()).toHaveLength(1)
  })

  it('a spawn past the scripted processes exits 3 and is logged', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    start()
    // Spawn order = claim order only once the first has claimed (as in the app,
    // which never spawns a tab's agents concurrently).
    await epoch.waitForRun(0)
    const second = start()
    expect((await second.exited).code).toBe(FAKE_CLAUDE_EXIT.unscripted)
    expect(epoch.unscripted().map((r) => r.index)).toEqual([1])
  })

  it('a spawn before any scenario is set exits 3 and is recorded as an orphan', async () => {
    const p = start()
    expect((await p.exited).code).toBe(FAKE_CLAUDE_EXIT.unscripted)
    expect(fake.orphans().some((e) => e.kind === 'unscripted')).toBe(true)
  })
})

describe('fake-claude — turns', () => {
  it('plays a scripted turn per user message, echoing session id and model', async () => {
    const epoch = fake.setScenario({ processes: [{ turns: [reply('first'), reply('second')] }] })
    const p = start()
    p.send(user('hello'))
    const init = await p.waitFor((e) => e.type === 'system')
    expect(init).toMatchObject({
      subtype: 'init',
      session_id: 'sess-1',
      model: 'haiku',
      cwd: fs.realpathSync(root)
    })
    await p.waitFor(isResult)
    p.send(user('again'))
    await p.waitFor((e) => isResult(e) && e.result === 'second')

    const run = await epoch.waitForRun(0)
    expect(run.userMessages()).toEqual(['hello', 'again'])
    expect(run.sessionId).toBe('sess-1')
    expect(run.resumed).toBe(false)
    expect(run.flag('--model')).toBe('haiku')
  })

  it('substitutes {{userText}} and runs defaultTurn past the scripted turns', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn('you said: ') }] })
    const p = start()
    p.send(user('ping'))
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'you said: ping' })
  })

  it('answers an unscripted turn with an error result that names it', async () => {
    const epoch = fake.setScenario({ processes: [{ turns: [reply('only one')] }] })
    const p = start()
    p.send(user('1'))
    await p.waitFor(isResult)
    p.send(user('2'))
    const err = await p.waitFor((e) => isResult(e) && e.is_error === true)
    expect(err.result).toContain('no script for turn #1')
    expect((await epoch.waitForRun(0)).has('unscripted-turn')).toBe(true)
  })

  it('each spawn claims the next script; --resume is reported', async () => {
    const epoch = fake.setScenario({
      processes: [{ turns: [reply('from spawn 0')] }, { turns: [reply('from spawn 1')] }]
    })
    const a = start()
    a.send(user('x'))
    await a.waitFor(isResult)
    const b = start(['--resume', 'sess-1', '--model', 'haiku'])
    b.send(user('y'))
    expect(await b.waitFor(isResult)).toMatchObject({
      result: 'from spawn 1',
      session_id: 'sess-1'
    })
    expect(epoch.runs().map((r) => r.resumed)).toEqual([false, true])
  })

  it('a new scenario starts a new epoch; earlier runs stay readable', async () => {
    const first = fake.setScenario({ processes: [{ turns: [reply('a')] }] })
    const p = start()
    p.send(user('x'))
    await p.waitFor(isResult)
    const second = fake.setScenario({ processes: [{ turns: [reply('b')] }] })
    const q = start()
    q.send(user('y'))
    expect(await q.waitFor(isResult)).toMatchObject({ result: 'b' })
    expect(first.runs()).toHaveLength(1)
    expect(second.runs()).toHaveLength(1)
  })

  it('exits 0 when stdin closes, like the real CLI', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start()
    p.child.stdin.end()
    expect((await p.exited).code).toBe(0)
  })
})

describe('fake-claude — steps', () => {
  it('stderr + exit steps', async () => {
    const epoch = fake.setScenario({
      processes: [
        { onStart: [step.stderr('No conversation found with session ID: x\n'), step.exit(1)] }
      ]
    })
    const p = start(['--resume', 'x'])
    expect((await p.exited).code).toBe(1)
    expect(p.stderr()).toContain('No conversation found')
    expect((await epoch.waitForRun(0)).exit()).toEqual({ code: 1 })
  })

  it('emitSplit writes one event as two chunks split inside a multi-byte character', async () => {
    fake.setScenario({
      processes: [{ turns: [[step.emitSplit(ev.text('héllo 😀'), 100), step.emit(ev.result())]] }]
    })
    const p = start()
    p.send(user('go'))
    expect(await p.waitFor((e) => e.type === 'assistant')).toMatchObject({
      message: { content: [{ type: 'text', text: 'héllo 😀' }] }
    })
    // The first chunk must end in an incomplete UTF-8 sequence.
    const firstChunk = p.chunks.find((c) => c.includes(0xc3))
    expect(firstChunk?.at(-1)).toBe(0xc3)
  })

  it('request: blocks for the decision, then runs the allow branch', async () => {
    const epoch = fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.emit(ev.toolUse({ id: 'tu1', name: 'Bash', input: { command: 'ls' } })),
              {
                request: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' },
                then: { allow: reply('allowed'), deny: reply('denied') }
              }
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('run ls'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    expect(req).toMatchObject({
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1' }
    })
    p.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { behavior: 'allow', updatedInput: {} }
      }
    })
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'allowed' })
    expect((await epoch.waitForRun(0)).decisions()).toMatchObject([
      { toolName: 'Bash', behavior: 'allow' }
    ])
  })

  it('request: a deny runs the deny branch', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              {
                request: { tool_name: 'Bash', input: {}, tool_use_id: 'tu1' },
                then: { allow: reply('allowed'), deny: reply('denied') }
              }
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('x'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    p.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { behavior: 'deny', message: 'no' }
      }
    })
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'denied' })
  })
})

describe('fake-claude — control requests', () => {
  it('interrupt mid-turn: acks, rejects the open tool, ends the turn, stays alive', async () => {
    const epoch = fake.setScenario({
      processes: [
        {
          turns: [
            [step.emit(ev.init(), ev.toolUse({ id: 'tu1', name: 'Bash', input: {} })), step.hang()]
          ],
          defaultTurn: echoTurn()
        }
      ]
    })
    const p = start()
    p.send(user('long'))
    await p.waitFor((e) => e.type === 'assistant')
    p.send({ type: 'control_request', request_id: 'req_1', request: { subtype: 'interrupt' } })
    expect(await p.waitFor((e) => e.type === 'control_response')).toMatchObject({
      response: { subtype: 'success', request_id: 'req_1', response: { still_queued: [] } }
    })
    expect(
      await p.waitFor((e) => e.type === 'user' && JSON.stringify(e).includes('tool_result'))
    ).toMatchObject({ message: { content: [{ tool_use_id: 'tu1', is_error: true }] } })
    expect(await p.waitFor(isResult)).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools'
    })
    p.send(user('after'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: after')
    expect((await epoch.waitForRun(0)).controlRequests()).toEqual([{ subtype: 'interrupt' }])
  })

  it('set_model ack updates {{model}} for later events', async () => {
    fake.setScenario({
      processes: [{ defaultTurn: [step.emit(ev.init(), ev.result({ text: '{{model}}' }))] }]
    })
    const p = start()
    p.send({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'set_model', model: 'opus' }
    })
    await p.waitFor((e) => e.type === 'control_response')
    p.send(user('x'))
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'opus' })
  })

  it('controlResponses can refuse a request', async () => {
    fake.setScenario({
      processes: [{ controlResponses: { set_model: 'error' }, defaultTurn: echoTurn() }]
    })
    const p = start()
    p.send({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'set_model', model: 'opus' }
    })
    expect(await p.waitFor((e) => e.type === 'control_response')).toMatchObject({
      response: { subtype: 'error', request_id: 'r1' }
    })
  })
})

describe('fake-claude — signals', () => {
  it('SIGTERM exits 143 by default', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start()
    await epoch.waitForRun(0)
    p.child.kill('SIGTERM')
    expect(await p.exited).toMatchObject({ code: 143 })
    expect((await epoch.waitForRun(0)).signals()).toEqual(['SIGTERM'])
  })

  it('onSigterm keeps a replaced process talking before it exits', async () => {
    const epoch = fake.setScenario({
      processes: [{ onSigterm: [step.sleep(100), step.emit(ev.text('late from the old process'))] }]
    })
    const p = start()
    await epoch.waitForRun(0)
    p.child.kill('SIGTERM')
    expect(await p.waitFor((e) => e.type === 'assistant')).toMatchObject({
      message: { content: [{ text: 'late from the old process' }] }
    })
    expect((await p.exited).code).toBe(143)
  })
})

describe('fake-claude — transcript replay', () => {
  it('re-emits a recorded turn with the live session id and cwd', async () => {
    const file = transcriptPath('tool-turn')
    fake.setScenario({
      processes: [{ turns: [[step.replay(file, { turn: 0 })], [step.replay(file, { turn: 1 })]] }]
    })
    const p = start(['--session-id', 'live-sess'])
    p.send(user('read it'))
    await p.waitFor(isResult)
    p.send(user('now bash'))
    await p.waitFor((e) => isResult(e) && e.result === 'recorded-ok')
    const recorded = transcriptStdout(file).filter((l) => !l.includes('"control_response"'))
    expect(p.lines).toHaveLength(recorded.length)
    expect(p.lines[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'live-sess',
      cwd: fs.realpathSync(root)
    })
    expect(JSON.stringify(p.lines)).not.toContain('{{')
  })

  it('a recorded can_use_tool request waits for the app’s answer', async () => {
    const epoch = fake.setScenario({
      processes: [{ turns: [[step.replay(transcriptPath('permission-bash'), { turn: 0 })]] }]
    })
    const p = start()
    p.send(user('touch it'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    expect(req).toMatchObject({ request: { subtype: 'can_use_tool', tool_name: 'Bash' } })
    // Blocked until answered: no result yet.
    await new Promise((r) => setTimeout(r, 300))
    expect(p.lines.some(isResult)).toBe(false)
    p.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { behavior: 'allow', updatedInput: {} }
      }
    })
    await p.waitFor(isResult)
    expect((await epoch.waitForRun(0)).decisions()).toMatchObject([
      { toolName: 'Bash', behavior: 'allow' }
    ])
  })
})

describe('fake-claude — prompt protocol (as CLI 2.1.312)', () => {
  const answer = (p: Proc, requestId: unknown, response: Record<string, unknown>) =>
    p.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
  const isStatus = (mode: string) => (e: Record<string, unknown>) =>
    e.type === 'system' && e.subtype === 'status' && e.permissionMode === mode

  it('step.request carries the display fields; a setMode update switches the mode', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.request(
                {
                  tool_name: 'Edit',
                  input: { file_path: 'f1.txt', old_string: 'a', new_string: 'b' },
                  tool_use_id: 'tu1',
                  description: 'f1.txt',
                  permission_suggestions: [
                    { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
                  ]
                },
                { allow: reply('{{permissionMode}}') }
              )
            ]
          ]
        }
      ]
    })
    const p = start(['--session-id', 's', '--permission-mode', 'default'])
    p.send(user('edit'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    expect(req).toMatchObject({ request: { tool_name: 'Edit', description: 'f1.txt' } })
    answer(p, req.request_id, {
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    })
    await p.waitFor(isStatus('acceptEdits'))
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'acceptEdits' })
  })

  it('approving ExitPlanMode without a mode leaves plan for default', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.request(
                { tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 'tu1' },
                { allow: reply('{{permissionMode}}') }
              )
            ]
          ]
        }
      ]
    })
    const p = start(['--session-id', 's', '--permission-mode', 'plan'])
    p.send(user('plan'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    answer(p, req.request_id, { behavior: 'allow', updatedInput: { plan: 'p' } })
    await p.waitFor(isStatus('default'))
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'default' })
  })

  it('deny + interrupt aborts the turn like the real CLI', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.emit(ev.toolUse({ id: 'tu1', name: 'Bash', input: {} })),
              step.request(
                { tool_name: 'Bash', input: {}, tool_use_id: 'tu1' },
                { deny: reply('carried on') }
              )
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('x'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    answer(p, req.request_id, { behavior: 'deny', message: 'no', interrupt: true })
    expect(await p.waitFor(isResult)).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true
    })
    expect(p.lines.some((e) => isResult(e) && e.result === 'carried on')).toBe(false)
  })

  it('an interrupt withdraws a pending request (control_cancel_request); a late answer is logged, ignored', async () => {
    const epoch = fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.request(
                { tool_name: 'Bash', input: {}, tool_use_id: 'tu1' },
                { allow: reply('ran') }
              )
            ]
          ],
          defaultTurn: echoTurn()
        }
      ]
    })
    const p = start()
    p.send(user('x'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    p.send({ type: 'control_request', request_id: 'int1', request: { subtype: 'interrupt' } })
    expect(await p.waitFor((e) => e.type === 'control_cancel_request')).toEqual({
      type: 'control_cancel_request',
      request_id: req.request_id
    })
    await p.waitFor(isResult)
    answer(p, req.request_id, { behavior: 'allow', updatedInput: {} })
    p.send(user('after'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: after')
    const run = await epoch.waitForRun(0)
    expect(run.decisions()).toEqual([])
    expect(run.lateAnswers()).toEqual([req.request_id])
  })

  it('hostRequest: emits a control_request the app must answer and records the reply', async () => {
    const epoch = fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.hostRequest({ subtype: 'hook_callback', callback_id: 'ups', input: {} }),
              ...reply('done')
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('x'))
    const req = await p.waitFor(
      (e) =>
        e.type === 'control_request' &&
        (e.request as { subtype?: string }).subtype === 'hook_callback'
    )
    p.send({
      type: 'control_response',
      response: { subtype: 'error', request_id: req.request_id, error: 'nope' }
    })
    await p.waitFor(isResult)
    expect((await epoch.waitForRun(0)).hostReplies()).toMatchObject([
      { subtype: 'hook_callback', reply: { subtype: 'error', error: 'nope' } }
    ])
  })

  it('replay records an answer that differs from the recorded one', async () => {
    const epoch = fake.setScenario({
      processes: [{ turns: [[step.replay(transcriptPath('ask-user-question'))]] }]
    })
    const p = start()
    p.send(user('ask'))
    const req = await p.waitFor((e) => e.type === 'control_request')
    answer(p, req.request_id, { behavior: 'deny', message: 'declined' })
    await p.waitFor(isResult)
    expect((await epoch.waitForRun(0)).replayMismatches()).toEqual([
      { requestId: req.request_id, recorded: 'allow', got: 'deny' }
    ])
  })
})
