import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFakeClaude,
  ev,
  fileSha256,
  readSessionFile,
  sessionFilePath,
  writeSessionFile,
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
  'stdio',
  '--replay-user-messages',
  '--include-partial-messages'
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
  args = CHAT_ARGV,
  env: Record<string, string> = {}
): Proc {
  const child = spawn(path.join(fake.binDir, 'claude'), [...args, ...extraArgs], {
    cwd: root,
    env: { ...process.env, ...env },
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

describe('fake-claude — delivery acks (2.1.312, --replay-user-messages)', () => {
  const tagged = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    message: { role: 'user', content: text }
  })
  const acks = (lines: Array<Record<string, unknown>>) =>
    lines.flatMap((e) =>
      e.type === 'command_lifecycle'
        ? [`${String(e.command_uuid)}:${String(e.state)}`]
        : e.type === 'user' && e.isReplay
          ? [`${String(e.uuid)}:replay`]
          : e.type === 'result'
            ? ['result']
            : []
    )

  it('a message with a uuid: queued, started + replay, result, completed', async () => {
    fake.setScenario({ processes: [{ turns: [reply('ok')] }] })
    const p = start()
    p.send(tagged('m-1', 'hello'))
    await p.waitFor((e) => e.type === 'command_lifecycle' && e.state === 'completed')
    expect(acks(p.lines)).toEqual([
      'm-1:queued',
      'm-1:started',
      'm-1:replay',
      'result',
      'm-1:completed'
    ])
  })

  it('a message sent mid-turn is acked queued at once, then runs after', async () => {
    fake.setScenario({
      processes: [{ turns: [[step.sleep(300), ...reply('one')], reply('two')] }]
    })
    const p = start()
    p.send(tagged('a', 'first'))
    await p.waitFor((e) => e.type === 'command_lifecycle' && e.state === 'started')
    p.send(tagged('b', 'second'))
    await p.waitFor(
      (e) => e.type === 'command_lifecycle' && e.command_uuid === 'b' && e.state === 'completed'
    )
    expect(acks(p.lines)).toEqual([
      'a:queued',
      'a:started',
      'a:replay',
      'b:queued',
      'result',
      'a:completed',
      'b:started',
      'b:replay',
      'result',
      'b:completed'
    ])
  })

  it('lifecycle: none plays a CLI that acks nothing', async () => {
    fake.setScenario({ processes: [{ lifecycle: 'none', turns: [reply('ok')] }] })
    const p = start()
    p.send(tagged('m-1', 'hello'))
    await p.waitFor(isResult)
    await new Promise((r) => setTimeout(r, 100))
    expect(acks(p.lines)).toEqual(['result'])
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

describe('fake-claude — conversation control (chat A, as CLI 2.1.312)', () => {
  let configDir: string
  let cwd: string
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-config-'))
    // The fake keys its session dir by its own process.cwd(), which is the real path.
    cwd = fs.realpathSync(root)
  })
  afterEach(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const withConfig = (): Record<string, string> => ({ CLAUDE_CONFIG_DIR: configDir })
  const userWith = (text: string, uuid: string) => ({ ...user(text), uuid })
  const control = (p: Proc, id: string, request: Record<string, unknown>) => {
    p.send({ type: 'control_request', request_id: id, request })
    return p.waitFor((e) => e.type === 'control_response' && JSON.stringify(e).includes(`"${id}"`))
  }

  it('writes no session file without CLAUDE_CONFIG_DIR', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start()
    p.send(userWith('hi', 'u1'))
    await p.waitFor(isResult)
    expect(fs.existsSync(sessionFilePath(configDir, cwd, 'sess-1'))).toBe(false)
  })

  it('records the conversation in its session file as one parentUuid chain', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(undefined, undefined, withConfig())
    p.send(userWith('one', 'u1'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: one')
    p.send(userWith('two', 'u2'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: two')
    const records = readSessionFile(sessionFilePath(configDir, cwd, 'sess-1'))
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(records[0]).toMatchObject({ uuid: 'u1', parentUuid: null, sessionId: 'sess-1' })
    expect(records[2]).toMatchObject({ uuid: 'u2', parentUuid: records[1].uuid })
  })

  it('rewind_conversation drops the message and what follows; the next turn branches', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(undefined, undefined, withConfig())
    p.send(userWith('one', 'u1'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: one')
    p.send(userWith('two', 'u2'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: two')
    const a1 = readSessionFile(sessionFilePath(configDir, cwd, 'sess-1'))[1].uuid
    expect(
      await control(p, 'rw1', { subtype: 'rewind_conversation', target_message_uuid: 'u2' })
    ).toMatchObject({
      response: {
        subtype: 'success',
        response: {
          rewound: true,
          targetMessageUuid: 'u2',
          prefillText: 'two',
          precedingAssistantUuid: a1
        }
      }
    })
    expect(
      await control(p, 'rw2', { subtype: 'rewind_conversation', target_message_uuid: String(a1) })
    ).toMatchObject({ response: { response: { rewound: false, reason: 'target_not_found' } } })
    p.send(userWith('three', 'u3'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: three')
    const records = readSessionFile(sessionFilePath(configDir, cwd, 'sess-1'))
    // Append-only: the rewound turn stays on disk; the new message hangs off turn 1.
    expect(records.filter((r) => r.uuid === 'u2')).toHaveLength(1)
    expect(records.find((r) => r.uuid === 'u3')).toMatchObject({ parentUuid: a1 })
    expect((await epoch.waitForRun(0)).rewound()).toEqual(['u2'])
  })

  it('--resume-session-at + --fork-session: a new conversation with the history; the original is untouched', async () => {
    const seeded = writeSessionFile({
      configDir,
      cwd,
      sessionId: 'orig',
      turns: [
        { user: 'remember APPLE', assistant: 'OK' },
        { user: 'remember BANANA', assistant: 'OK' }
      ]
    })
    const before = fileSha256(seeded.file)
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(
      [
        '--resume',
        'orig',
        '--resume-session-at',
        seeded.assistantUuids[0],
        '--fork-session',
        '--session-id',
        'forked'
      ],
      undefined,
      withConfig()
    )
    p.send(userWith('three', 'u3'))
    expect(await p.waitFor((e) => e.type === 'system' && e.subtype === 'init')).toMatchObject({
      session_id: 'forked'
    })
    await p.waitFor(isResult)
    expect(fileSha256(seeded.file)).toBe(before)
    const fork = readSessionFile(sessionFilePath(configDir, cwd, 'forked'))
    const users = fork.filter(
      (r) => r.type === 'user' && typeof (r.message as { content?: unknown }).content === 'string'
    )
    expect(users.map((r) => (r.message as { content: string }).content)).toEqual([
      'remember APPLE',
      'three'
    ])
    expect((await epoch.waitForRun(0)).forked).toBe(true)
  })

  it('streamed assistant lines carry the uuid of their session record (what a fork resumes at)', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(undefined, undefined, withConfig())
    p.send(userWith('one', 'u1'))
    const line = await p.waitFor((e) => e.type === 'assistant')
    await p.waitFor(isResult)
    const record = readSessionFile(sessionFilePath(configDir, cwd, 'sess-1'))[1]
    expect(typeof line.uuid).toBe('string')
    expect(line.uuid).toBe(record.uuid)
  })

  it('a scripted turn played again gets new record uuids, as every CLI record has its own', async () => {
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }, { defaultTurn: echoTurn() }] })
    const p = start(undefined, undefined, withConfig())
    p.send(userWith('one', 'u1'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: one')
    p.send(userWith('two', 'u2'))
    await p.waitFor((e) => isResult(e) && e.result === 'echo: two')
    p.child.kill('SIGTERM')
    const q = start(['--resume', 'sess-1'], undefined, withConfig())
    q.send(userWith('three', 'u3'))
    await q.waitFor((e) => isResult(e) && e.result === 'echo: three')
    const uuids = readSessionFile(sessionFilePath(configDir, cwd, 'sess-1'))
      .filter((r) => r.type === 'assistant')
      .map((r) => r.uuid)
    expect(uuids).toHaveLength(3)
    expect(new Set(uuids).size).toBe(3)
  })

  it('a fork writes nothing before its first message (2.1.312, chat-a check R3b)', async () => {
    const seeded = writeSessionFile({
      configDir,
      cwd,
      sessionId: 'orig',
      turns: [{ user: 'remember APPLE', assistant: 'OK' }]
    })
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    start(
      [
        '--resume',
        'orig',
        '--resume-session-at',
        seeded.assistantUuids[0],
        '--fork-session',
        '--session-id',
        'forked'
      ],
      undefined,
      withConfig()
    )
    await epoch.waitForRun(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(fs.existsSync(sessionFilePath(configDir, cwd, 'forked'))).toBe(false)
  })

  it('--resume-session-at an unknown uuid fails like the real CLI', async () => {
    writeSessionFile({ configDir, cwd, sessionId: 'orig', turns: [{ user: 'a', assistant: 'b' }] })
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(
      ['--resume', 'orig', '--resume-session-at', 'msg_nope'],
      undefined,
      withConfig()
    )
    expect((await p.exited).code).toBe(1)
    expect(p.stderr()).toContain('No message found with message.uuid of: msg_nope')
  })

  it('rewind_files: refused without checkpointing; dry run reports; a real run restores', async () => {
    const checkpoints = {
      '0': {
        filesChanged: ['a.txt'],
        insertions: 1,
        deletions: 2,
        restore: { 'a.txt': 'v1', 'b.txt': null }
      }
    }
    fake.setScenario({
      processes: [{ defaultTurn: echoTurn(), fileCheckpoints: checkpoints }],
      repeatLast: true
    })
    const off = start(undefined, undefined, withConfig())
    off.send(userWith('edit', 'u1'))
    await off.waitFor(isResult)
    expect(
      await control(off, 'f0', { subtype: 'rewind_files', user_message_id: 'u1', dry_run: true })
    ).toMatchObject({
      response: { response: { canRewind: false, error: 'File rewinding is not enabled.' } }
    })
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2')
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    const on = start(['--session-id', 'sess-2'], undefined, {
      ...withConfig(),
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true'
    })
    on.send(userWith('edit', 'u9'))
    await on.waitFor(isResult)
    expect(
      await control(on, 'f1', { subtype: 'rewind_files', user_message_id: 'u9', dry_run: true })
    ).toMatchObject({
      response: {
        response: {
          canRewind: true,
          filesChanged: [path.join(cwd, 'a.txt')],
          insertions: 1,
          deletions: 2
        }
      }
    })
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v2')
    expect(
      await control(on, 'f2', { subtype: 'rewind_files', user_message_id: 'u9' })
    ).toMatchObject({
      response: { response: { canRewind: true, skippedLinks: 0 } }
    })
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v1')
    expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(false)
    expect(
      await control(on, 'f3', { subtype: 'rewind_files', user_message_id: 'nope', dry_run: true })
    ).toMatchObject({
      response: {
        response: { canRewind: false, error: 'No file checkpoint found for this message.' }
      }
    })
  })

  it('interrupt reports messages queued mid-turn; cancel_async_message withdraws one', async () => {
    fake.setScenario({
      processes: [{ turns: [[step.emit(ev.init()), step.hang()]], defaultTurn: echoTurn() }]
    })
    const p = start()
    p.send(userWith('long', 'u1'))
    await p.waitFor((e) => e.type === 'system')
    p.send(userWith('next', 'u2'))
    p.send(userWith('later', 'u3'))
    await p.waitFor((e) => e.type === 'command_lifecycle' && e.command_uuid === 'u3')
    expect(
      await control(p, 'c1', { subtype: 'cancel_async_message', message_uuid: 'u3' })
    ).toMatchObject({
      response: { response: { cancelled: true } }
    })
    expect(
      await control(p, 'c2', { subtype: 'cancel_async_message', message_uuid: 'u3' })
    ).toMatchObject({
      response: { response: { cancelled: false } }
    })
    expect(await control(p, 'i1', { subtype: 'interrupt' })).toMatchObject({
      response: { response: { still_queued: ['u2'] } }
    })
    await p.waitFor((e) => isResult(e) && e.result === 'echo: next')
  })

  it('apply_flag_settings: acked with no response body; {{effort}} follows', async () => {
    fake.setScenario({
      processes: [{ defaultTurn: [step.emit(ev.init(), ev.result({ text: 'effort={{effort}}' }))] }]
    })
    const p = start()
    const ack = await control(p, 'e1', {
      subtype: 'apply_flag_settings',
      settings: { effortLevel: 'high' }
    })
    expect(ack).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'e1' }
    })
    p.send(user('x'))
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'effort=high' })
  })

  it('controlResponses can answer with a fixed payload or a named error', async () => {
    fake.setScenario({
      processes: [
        {
          controlResponses: {
            get_settings: { success: { applied: { effort: 'low' } } },
            interrupt: { error: 'busy' }
          },
          defaultTurn: echoTurn()
        }
      ]
    })
    const p = start()
    expect(await control(p, 'g1', { subtype: 'get_settings' })).toMatchObject({
      response: { subtype: 'success', response: { applied: { effort: 'low' } } }
    })
    expect(await control(p, 'g2', { subtype: 'interrupt' })).toMatchObject({
      response: { subtype: 'error', error: 'busy' }
    })
  })

  it('ackDelayMs: the message is in the conversation before it is acked; a resumed CLI drops the resend (completed, no turn)', async () => {
    const epoch = fake.setScenario({
      processes: [{ ackDelayMs: 60_000, defaultTurn: echoTurn() }, { defaultTurn: echoTurn() }]
    })
    const p1 = start(undefined, undefined, withConfig())
    p1.send(userWith('hello', 'u1'))
    const run0 = await epoch.waitForRun(0, (r) => r.stdin().length === 1)
    await expect
      .poll(() =>
        readSessionFile(sessionFilePath(configDir, cwd, 'sess-1')).some((r) => r.uuid === 'u1')
      )
      .toBe(true)
    expect(p1.lines.some((e) => e.type === 'command_lifecycle')).toBe(false)
    p1.child.kill('SIGKILL')
    await p1.exited
    const p2 = start(['--resume', 'sess-1'], undefined, withConfig())
    p2.send(userWith('hello', 'u1'))
    expect(
      await p2.waitFor((e) => e.type === 'command_lifecycle' && e.command_uuid === 'u1')
    ).toMatchObject({ state: 'completed' })
    await new Promise((r) => setTimeout(r, 100))
    expect(p2.lines.some(isResult)).toBe(false)
    expect(run0.index).toBe(0)
    expect((await epoch.waitForRun(1)).duplicateUserUuids()).toEqual(['u1'])
    expect(
      readSessionFile(sessionFilePath(configDir, cwd, 'sess-1')).filter((r) => r.uuid === 'u1')
    ).toHaveLength(1)
  })

  it('a tui script plays the interactive CLI: logs, stays up, ends on SIGTERM; peers are reported', async () => {
    const epoch = fake.setScenario({ processes: [{ tui: true }, { tui: true }] })
    const tui = start(['--resume', 'conv-x'], [], withConfig())
    const run = await epoch.waitForRun(0)
    expect(run.tui).toBe(true)
    expect(run.env).toEqual({ CLAUDE_CONFIG_DIR: configDir })
    expect(run.flag('--resume')).toBe('conv-x')
    const second = start(['--resume', 'conv-x'], [])
    expect((await epoch.waitForRun(1)).peersAliveAtStart).toEqual([0])
    tui.child.kill('SIGTERM')
    expect((await tui.exited).code).toBe(143)
    second.child.kill('SIGTERM')
    await second.exited
  })

  it('without a tui script a TUI-style spawn is still argv drift', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start(['--resume', 'x'], [])
    expect((await p.exited).code).toBe(FAKE_CLAUDE_EXIT.argvDrift)
    expect(epoch.argvDrift()).toHaveLength(1)
  })

  it('parallel: both branches run at once (two prompts pending together)', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.parallel(
                [
                  step.request(
                    { tool_name: 'Bash', input: {}, tool_use_id: 't1' },
                    { allow: [step.emit(ev.text('one'))] }
                  )
                ],
                [
                  step.request(
                    { tool_name: 'Bash', input: {}, tool_use_id: 't2' },
                    { allow: [step.emit(ev.text('two'))] }
                  )
                ]
              ),
              step.emit(ev.result({ text: 'both' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor((e) => e.type === 'control_request' && JSON.stringify(e).includes('t2'))
    const reqs = p.lines.filter((e) => e.type === 'control_request')
    expect(reqs).toHaveLength(2)
    for (const r of reqs) {
      p.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: r.request_id,
          response: { behavior: 'allow', updatedInput: {} }
        }
      })
    }
    expect(await p.waitFor(isResult)).toMatchObject({ result: 'both' })
  })
})

describe('fake-claude — composer (initialize, attachments, commands)', () => {
  it('initialize is answered like the CLI: commands[] (empty by default, or scripted)', async () => {
    const commands = [
      { name: 'x', description: 'Spike x (project)', argumentHint: '<fruit> <count>' }
    ]
    fake.setScenario({
      processes: [{ controlPayloads: { initialize: { commands } }, defaultTurn: echoTurn() }]
    })
    const p = start()
    p.send({ type: 'control_request', request_id: 'i1', request: { subtype: 'initialize' } })
    expect(await p.waitFor((e) => e.type === 'control_response')).toMatchObject({
      response: { subtype: 'success', request_id: 'i1', response: { commands } }
    })
    fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const q = start()
    q.send({ type: 'control_request', request_id: 'i2', request: { subtype: 'initialize' } })
    expect(await q.waitFor((e) => e.type === 'control_response')).toMatchObject({
      response: { response: { commands: [] } }
    })
  })

  it('controlRequests() leaves out the spawn-time initialize (session setup); by subtype it is there', async () => {
    const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const p = start()
    p.send({ type: 'control_request', request_id: 'i1', request: { subtype: 'initialize' } })
    await p.waitFor((e) => e.type === 'control_response')
    p.send({
      type: 'control_request',
      request_id: 'm1',
      request: { subtype: 'set_model', model: 'x' }
    })
    await p.waitFor((e) => e.type === 'control_response' && JSON.stringify(e).includes('"m1"'))
    const run = await epoch.waitForRun(0, (r) => r.stdin().length === 2)
    expect(run.controlRequests()).toEqual([{ subtype: 'set_model', model: 'x' }])
    expect(run.controlRequests('initialize')).toEqual([{ subtype: 'initialize' }])
  })

  it('{{command}} follows the CLI rule: a /command only when the LAST block is its text', async () => {
    const epoch = fake.setScenario({
      processes: [{ defaultTurn: [step.emit(ev.result({ text: 'cmd={{command}}' }))] }]
    })
    const p = start()
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    p.send({
      type: 'user',
      message: { role: 'user', content: [img, { type: 'text', text: '/x MANGO' }] }
    })
    expect(await p.waitFor((e) => e.type === 'result')).toMatchObject({ result: 'cmd=x' })
    p.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/x MANGO' }, img] }
    })
    expect(
      await p.waitFor((e) => e.type === 'result' && e !== p.lines.find((l) => l.type === 'result'))
    ).toMatchObject({
      result: 'cmd='
    })
    const run = await epoch.waitForRun(0, (r) => r.userContents().length === 2)
    expect(run.userContents()[0]).toEqual([img, { type: 'text', text: '/x MANGO' }])
  })
})
