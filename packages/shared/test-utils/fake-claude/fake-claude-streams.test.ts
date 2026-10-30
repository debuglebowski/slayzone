/**
 * The fake CLI's token streaming (stream.ts) and command tasks (tasks.ts +
 * fake-claude-tasks.mjs) against the shapes Claude Code 2.1.312 writes (spike
 * items 9 and 14). Process basics, turns and prompts: fake-claude.test.ts.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFakeClaude,
  ev,
  type FakeClaude,
  FAKE_CLAUDE_EXIT,
  step,
  streamMessage,
  taskStep
} from './index'

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
  '--include-partial-messages',
  '--session-id',
  'sess-1'
]

type Line = Record<string, unknown>

interface Proc {
  lines: Line[]
  send: (msg: unknown) => void
  waitFor: (pred: (l: Line) => boolean, timeoutMs?: number) => Promise<Line>
  exited: Promise<number | null>
  stderr: () => string
}

let root: string
let fake: FakeClaude
const children: ChildProcessWithoutNullStreams[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-streams-'))
  fake = createFakeClaude({ root })
})

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  fake.dispose()
})

function start(args = CHAT_ARGV): Proc {
  const child = spawn(path.join(fake.binDir, 'claude'), args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const lines: Line[] = []
  const decoder = new StringDecoder('utf8')
  let buf = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += decoder.write(d)
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)) as Line)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString('utf8')
  })
  return {
    lines,
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    stderr: () => err,
    async waitFor(pred, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = lines.find(pred)
        if (hit) return hit
        if (Date.now() > deadline) throw new Error(`no matching line; got ${JSON.stringify(lines)}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  }
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const isResult = (l: Line) => l.type === 'result'
const sys = (subtype: string) => (l: Line) => l.type === 'system' && l.subtype === subtype

/** A compact label per line: `stream:<inner>[:<block|delta>]`, `assistant:<block>`, … */
function label(l: Line): string {
  if (l.type === 'stream_event') {
    const e = l.event as Record<string, unknown>
    const block = (e.content_block as { type?: string } | undefined)?.type
    const delta = (e.delta as { type?: string } | undefined)?.type
    return ['stream', e.type, block ?? (e.type === 'content_block_delta' ? delta : undefined)]
      .filter(Boolean)
      .join(':')
  }
  if (l.type === 'assistant') {
    const c = (l.message as { content: Array<{ type: string }> }).content[0]
    return `assistant:${c.type}`
  }
  if (l.type === 'system') return `system:${l.subtype as string}`
  return String(l.type)
}

let reqSeq = 0
async function control(p: Proc, request: Record<string, unknown>): Promise<Line> {
  const id = `host_${++reqSeq}`
  p.send({ type: 'control_request', request_id: id, request })
  const res = await p.waitFor(
    (l) => l.type === 'control_response' && (l.response as Line).request_id === id
  )
  return res.response as Line
}

describe('fake-claude — token streaming (--include-partial-messages)', () => {
  it('requires --include-partial-messages (adapter drift otherwise)', async () => {
    fake.setScenario({ processes: [{ turns: [] }] })
    const p = start(CHAT_ARGV.filter((a) => a !== '--include-partial-messages'))
    expect(await p.exited).toBe(FAKE_CLAUDE_EXIT.argvDrift)
    expect(p.stderr()).toContain('missing --include-partial-messages')
  })

  it('streamMessage plays the CLI order: deltas → saved block event → block stop', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.emit(ev.init()),
              ...streamMessage('msg_s1', [
                { thinking: ['Let me ', 'check.'] },
                { toolUse: { id: 'toolu_1', name: 'Bash', input: { command: 'ls' } } }
              ]),
              ...streamMessage('msg_s2', [{ text: ['Hel', 'lo'] }]),
              step.emit(ev.result({ text: 'Hello' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(isResult)
    const labels = p.lines.map(label).filter((l) => l !== 'system:init' && l !== 'result')
    expect(labels).toEqual([
      'stream:message_start',
      'stream:content_block_start:thinking',
      'stream:content_block_delta:thinking_delta',
      'stream:content_block_delta:thinking_delta',
      'stream:content_block_delta:signature_delta',
      'assistant:thinking',
      'stream:content_block_stop',
      'stream:content_block_start:tool_use',
      'stream:content_block_delta:input_json_delta',
      'stream:content_block_delta:input_json_delta',
      'stream:content_block_delta:input_json_delta',
      'assistant:tool_use',
      'stream:content_block_stop',
      'stream:message_delta',
      'stream:message_stop',
      'stream:message_start',
      'stream:content_block_start:text',
      'stream:content_block_delta:text_delta',
      'stream:content_block_delta:text_delta',
      'assistant:text',
      'stream:content_block_stop',
      'stream:message_delta',
      'stream:message_stop'
    ])
    // The saved block events carry the streamed message's id and the full text.
    const saved = p.lines.filter((l) => l.type === 'assistant')
    expect(saved.map((l) => (l.message as { id: string }).id)).toEqual([
      'msg_s1',
      'msg_s1',
      'msg_s2'
    ])
    const thinking = (saved[0].message as { content: Array<{ thinking: string }> }).content[0]
    expect(thinking.thinking).toBe('Let me check.')
    const json = p.lines
      .filter((l) => label(l) === 'stream:content_block_delta:input_json_delta')
      .map((l) => ((l.event as Line).delta as { partial_json: string }).partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ command: 'ls' })
  })

  it('open: true leaves the last block streaming (no saved event, no stop)', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [...streamMessage('msg_o', [{ text: ['par', 'tial'] }], { open: true }), step.hang()]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(
      (l) =>
        label(l) === 'stream:content_block_delta:text_delta' && JSON.stringify(l).includes('tial')
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(p.lines.some((l) => l.type === 'assistant')).toBe(false)
    expect(p.lines.some((l) => label(l) === 'stream:content_block_stop')).toBe(false)
  })
})

describe('fake-claude — command tasks (2.1.312, spike item 14)', () => {
  const bashUse = (id: string, input: Record<string, unknown>) =>
    step.emit(ev.toolUse({ id, name: 'Bash', input }))

  it('foreground: task_started, output grows on get_task_output, notification then tool_result', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              step.emit(ev.init()),
              bashUse('toolu_fg', { command: 'ticks', description: 'Ticks' }),
              taskStep({
                taskId: 'tfg',
                toolUseId: 'toolu_fg',
                description: 'Ticks',
                startAfterMs: 100,
                output: [
                  { atMs: 50, text: 'tick 1\n' },
                  { atMs: 400, text: 'tick 2\n' }
                ],
                endAtMs: 700
              }),
              step.emit(ev.text('done'), ev.result({ text: 'done' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    const started = await p.waitFor(sys('task_started'))
    expect(started).toMatchObject({
      task_id: 'tfg',
      tool_use_id: 'toolu_fg',
      is_backgrounded: false,
      task_type: 'local_bash',
      description: 'Ticks'
    })
    const first = await control(p, { subtype: 'get_task_output', task_id: 'tfg' })
    expect(first.response).toEqual({ output: 'tick 1\n', total_bytes: 7, truncated: false })
    await new Promise((r) => setTimeout(r, 400))
    const second = await control(p, { subtype: 'get_task_output', task_id: 'tfg' })
    expect((second.response as Line).output).toBe('tick 1\ntick 2\n')

    await p.waitFor(isResult)
    const order = p.lines.map(label)
    const note = order.indexOf('system:task_notification')
    const result = p.lines.findIndex(
      (l) => l.type === 'user' && JSON.stringify(l).includes('toolu_fg')
    )
    expect(note).toBeGreaterThan(-1)
    expect(result).toBeGreaterThan(note)
    expect(p.lines[result]).toMatchObject({
      message: { content: [{ tool_use_id: 'toolu_fg', content: 'tick 1\ntick 2' }] }
    })
    // A finished foreground command's output is dropped.
    const after = await control(p, { subtype: 'get_task_output', task_id: 'tfg' })
    expect(after.response).toEqual({ output: '', total_bytes: 0, truncated: false })
  })

  it('a command done before startAfterMs never becomes a task', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              bashUse('toolu_q', { command: 'echo hi' }),
              taskStep({
                taskId: 'tq',
                toolUseId: 'toolu_q',
                startAfterMs: 500,
                output: [{ atMs: 10, text: 'hi\n' }],
                endAtMs: 50
              }),
              step.emit(ev.result())
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(isResult)
    expect(p.lines.some(sys('task_started'))).toBe(false)
    expect(JSON.stringify(p.lines)).toContain('"content":"hi"')
    const res = await control(p, { subtype: 'get_task_output', task_id: 'tq' })
    expect(res.subtype).toBe('error')
  })

  it('run_in_background: started at once, turn ends, output kept after exit, CLI starts its own turn', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              bashUse('toolu_bg', { command: 'loop', run_in_background: true }),
              taskStep({
                taskId: 'tbg',
                toolUseId: 'toolu_bg',
                description: 'Loop',
                background: true,
                output: [
                  { atMs: 20, text: 'tick 1\n' },
                  { atMs: 300, text: 'tick 2\n' }
                ],
                endAtMs: 400,
                afterBackgroundExit: [
                  step.emit(
                    ev.init(),
                    ev.text('The loop finished.'),
                    ev.result({ text: 'The loop finished.' })
                  )
                ]
              }),
              step.emit(ev.text('STARTED'), ev.result({ text: 'STARTED' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor((l) => isResult(l) && l.result === 'STARTED')
    const order = p.lines.map(label)
    expect(order.indexOf('system:background_tasks_changed')).toBeLessThan(
      order.indexOf('system:task_started')
    )
    expect(p.lines.find(sys('task_started'))).toMatchObject({ is_backgrounded: true })
    expect(JSON.stringify(p.lines)).toContain('Command running in background with ID: tbg')

    await p.waitFor((l) => isResult(l) && l.result === 'The loop finished.')
    expect(p.lines.find(sys('task_updated'))).toMatchObject({
      task_id: 'tbg',
      patch: { status: 'completed' }
    })
    expect(p.lines.find(sys('task_notification'))).toMatchObject({
      task_id: 'tbg',
      tool_use_id: 'toolu_bg',
      status: 'completed'
    })
    const lists = p.lines.filter(sys('background_tasks_changed')).map((l) => l.tasks)
    expect(lists.at(-1)).toEqual([])
    const res = await control(p, { subtype: 'get_task_output', task_id: 'tbg' })
    expect((res.response as Line).output).toBe('tick 1\ntick 2\n\n[exited with code 0]\n')
  })

  it('background_tasks moves a running foreground command to the background', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              bashUse('toolu_mv', { command: 'long' }),
              taskStep({
                taskId: 'tmv',
                toolUseId: 'toolu_mv',
                startAfterMs: 50,
                output: [{ atMs: 10, text: 'a\n' }],
                endAtMs: 600
              }),
              step.emit(ev.text('moved on'), ev.result({ text: 'moved on' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(sys('task_started'))
    const ack = await control(p, { subtype: 'background_tasks', tool_use_id: 'toolu_mv' })
    expect(ack.response).toEqual({ backgrounded: true })
    expect(p.lines.find(sys('task_updated'))).toMatchObject({ patch: { is_backgrounded: true } })
    await p.waitFor((l) => isResult(l) && l.result === 'moved on')
    expect(JSON.stringify(p.lines)).toContain(
      'Command was manually backgrounded by user with ID: tmv'
    )
    // It keeps running in the background and finishes on its own.
    await p.waitFor((l) => sys('task_notification')(l) && l.status === 'completed')
    expect(
      await control(p, { subtype: 'background_tasks', tool_use_id: 'toolu_mv' })
    ).toMatchObject({
      response: { backgrounded: false }
    })
  })

  it('stop_task kills a background command: killed + stopped, output ends with [killed]', async () => {
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              bashUse('toolu_st', { command: 'loop', run_in_background: true }),
              taskStep({
                taskId: 'tst',
                toolUseId: 'toolu_st',
                background: true,
                output: [{ atMs: 10, text: 'tick 1\n' }],
                endAtMs: 60_000
              }),
              step.emit(ev.result({ text: 'STARTED' }))
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(isResult)
    await new Promise((r) => setTimeout(r, 50))
    const ack = await control(p, { subtype: 'stop_task', task_id: 'tst' })
    expect(ack).toMatchObject({ subtype: 'success', response: {} })
    expect(p.lines.find(sys('task_updated'))).toMatchObject({ patch: { status: 'killed' } })
    expect(p.lines.find(sys('task_notification'))).toMatchObject({ status: 'stopped' })
    const res = await control(p, { subtype: 'get_task_output', task_id: 'tst' })
    expect((res.response as Line).output).toBe('tick 1\n\n[killed]\n')
    expect((await control(p, { subtype: 'stop_task', task_id: 'tst' })).subtype).toBe('error')
  })

  it('get_task_output keeps the last 8 KiB and reports the total', async () => {
    const big = 'x'.repeat(10_000)
    fake.setScenario({
      processes: [
        {
          turns: [
            [
              taskStep({
                taskId: 'tbig',
                toolUseId: 'toolu_big',
                background: true,
                output: [{ atMs: 0, text: big }],
                endAtMs: 60_000
              }),
              step.emit(ev.result())
            ]
          ]
        }
      ]
    })
    const p = start()
    p.send(user('go'))
    await p.waitFor(isResult)
    await new Promise((r) => setTimeout(r, 30))
    const res = (await control(p, { subtype: 'get_task_output', task_id: 'tbig' })).response as Line
    expect(res).toMatchObject({ total_bytes: 10_000, truncated: true })
    expect((res.output as string).length).toBe(8192)
  })

  it('get_task_output for an unknown task is an error reply, like the real CLI', async () => {
    fake.setScenario({ processes: [{ turns: [] }] })
    const p = start()
    const res = await control(p, { subtype: 'get_task_output', task_id: 'nope' })
    expect(res).toMatchObject({ subtype: 'error' })
    expect(res.error).toContain('no shell or Monitor task with that task_id')
  })
})
