/**
 * Plan 3.2 / 3.9 at the transport: the spawn's CLI-version hint (summarized
 * thinking only for a CLI known to accept the flag; a refusal turns it off for
 * the tab), and command tasks — saved `command-task` events, never a raw
 * `cli-task`, and the task entry points (output / stop / background) scoped to
 * the tab's live process. Fake children speak Claude's stream-json.
 */
import { afterEach, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'

interface Fake {
  args: string[]
  emitter: EventEmitter
  stdout: PassThrough
  stderr: PassThrough
  stdin: Array<Record<string, unknown>>
  exit(code: number | null, signal?: string | null): void
}

function fake(args: string[]): { fake: Fake; child: ChildProcess } {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin: Array<Record<string, unknown>> = []
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
    pid: 4343,
    kill: (sig?: string) => {
      setImmediate(() => emitter.emit('exit', null, sig ?? 'SIGTERM'))
      return true
    }
  }) as unknown as ChildProcess
  return {
    child,
    fake: {
      args,
      emitter,
      stdout,
      stderr,
      stdin,
      exit: (code, signal = null) => emitter.emit('exit', code, signal)
    }
  }
}

const line = (f: Fake, obj: unknown): void => {
  f.stdout.write(`${JSON.stringify(obj)}\n`)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const init = (version: string) => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'haiku',
  cwd: '/tmp',
  tools: [],
  claude_code_version: version
})
const taskStarted = (taskId: string, toolUseId: string, taskType = 'local_bash') => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  description: 'Ticks',
  is_backgrounded: false,
  task_type: taskType
})

interface Harness {
  fakes: Fake[]
  broadcasts: Array<{ live?: number; event: AgentEvent }>
}

function harness(): Harness {
  mgr.__resetForTests()
  const h: Harness = { fakes: [], broadcasts: [] }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_bin: string, args: readonly string[]) => {
      const { fake: f, child } = fake([...args])
      h.fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return child
    },
    broadcastEvent: (_tab, event, _seq, live) =>
      h.broadcasts.push({ event, ...(live !== undefined ? { live } : {}) }),
    broadcastExit: () => {},
    broadcastStateChange: () => {},
    eventStore: { load: async () => [], insert: async () => 'inserted', readRange: async () => [] }
  })
  return h
}

const OPTS = {
  tabId: 'tab-b',
  taskId: 'task-b',
  mode: 'claude-chat',
  cwd: '/tmp',
  conversationId: null as string | null,
  providerFlags: [] as string[]
}

async function start(over: Partial<typeof OPTS> & { cliVersion?: string | null } = {}) {
  await mgr.hydrateSession({ ...OPTS, ...over })
  await mgr.ensureSpawned(OPTS.tabId)
}

const thinkingFlag = (f: Fake): string | null => {
  const i = f.args.indexOf('--thinking-display')
  return i < 0 ? null : f.args[i + 1]
}

/** The last control_request the transport wrote to `f`, and a reply line for it. */
function lastControl(f: Fake) {
  const reqs = f.stdin.filter((m) => m.type === 'control_request')
  const req = reqs[reqs.length - 1] as { request_id: string; request: Record<string, unknown> }
  return {
    request: req?.request,
    reply: (response: Record<string, unknown>) =>
      line(f, {
        type: 'control_response',
        response: { subtype: 'success', request_id: req.request_id, response }
      })
  }
}

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

// ---- 3.2: the spawn's CLI version hint ----

test('every Claude spawn asks for partial messages', async () => {
  const h = harness()
  await start()
  expect(h.fakes[0].args).toContain('--include-partial-messages')
})

test('summarized thinking: off for an unknown CLI, on once the tab saw a CLI that takes it', async () => {
  const h = harness()
  await start()
  expect(thinkingFlag(h.fakes[0])).toBe(null)
  line(h.fakes[0], init('2.1.312'))
  await wait(20)
  await mgr.respawn(OPTS.tabId, { ...OPTS })
  expect(thinkingFlag(h.fakes[1])).toBe('summarized')
})

test('summarized thinking from the hydrate hint (last CLI seen for the project)', async () => {
  const h = harness()
  await start({ cliVersion: '2.1.312' })
  expect(thinkingFlag(h.fakes[0])).toBe('summarized')
})

test('an older hint keeps it off', async () => {
  const h = harness()
  await start({ cliVersion: '2.1.200' })
  expect(thinkingFlag(h.fakes[0])).toBe(null)
})

test('a CLI that refuses the option: noticed, and the tab never passes it again', async () => {
  const h = harness()
  await start({ cliVersion: '2.1.312' })
  expect(thinkingFlag(h.fakes[0])).toBe('summarized')
  h.fakes[0].stderr.write("error: unknown option '--thinking-display'\n")
  h.fakes[0].exit(1)
  await wait(200)
  const notice = h.broadcasts
    .map((b) => b.event)
    .find((e) => e.kind === 'notice' && e.code === 'cli-option-refused')
  expect(notice).toBeDefined()
  await mgr.respawn(OPTS.tabId, { ...OPTS, cliVersion: '2.1.312' } as typeof OPTS)
  expect(thinkingFlag(h.fakes[1])).toBe(null)
})

// ---- 3.9: command tasks ----

test('a Bash task is saved as command-task; a raw cli-task never leaves the driver', async () => {
  const h = harness()
  await start()
  line(h.fakes[0], init('2.1.312'))
  line(h.fakes[0], taskStarted('t1', 'toolu_1'))
  await wait(30)
  const kinds = h.broadcasts.map((b) => b.event.kind)
  expect(kinds).toContain('command-task')
  expect(kinds).not.toContain('cli-task')
  expect(kinds).not.toContain('sub-agent')
  const saved = h.broadcasts.find((b) => b.event.kind === 'command-task')
  expect(saved?.live).toBeUndefined()
})

test('commandTaskOutput asks the tab’s live process; no live process → gone', async () => {
  const h = harness()
  expect(await mgr.getCommandTaskOutput(OPTS.tabId, 't1')).toEqual({ state: 'gone' })
  await start()
  line(h.fakes[0], taskStarted('t1', 'toolu_1'))
  await wait(20)
  const out = mgr.getCommandTaskOutput(OPTS.tabId, 't1')
  await wait(10)
  const c = lastControl(h.fakes[0])
  expect(c.request).toEqual({ subtype: 'get_task_output', task_id: 't1' })
  c.reply({ output: 'tick 1\n', total_bytes: 7, truncated: false })
  expect(await out).toEqual({
    state: 'running',
    output: 'tick 1\n',
    totalBytes: 7,
    truncated: false
  })
})

test('after a respawn the old process’s task is gone', async () => {
  const h = harness()
  await start()
  line(h.fakes[0], taskStarted('t1', 'toolu_1'))
  await wait(20)
  await mgr.respawn(OPTS.tabId, { ...OPTS })
  expect(await mgr.getCommandTaskOutput(OPTS.tabId, 't1')).toEqual({ state: 'gone' })
})

test('stop and move-to-background reach the CLI; without a live process they fail', async () => {
  const h = harness()
  await expect(mgr.stopCommandTask(OPTS.tabId, 't1')).rejects.toThrow()
  expect(await mgr.backgroundCommandTask(OPTS.tabId, 'toolu_1')).toBe(false)
  await start()
  line(h.fakes[0], taskStarted('t1', 'toolu_1'))
  await wait(20)
  const moved = mgr.backgroundCommandTask(OPTS.tabId, 'toolu_1')
  await wait(10)
  const bg = lastControl(h.fakes[0])
  expect(bg.request).toEqual({ subtype: 'background_tasks', tool_use_id: 'toolu_1' })
  bg.reply({ backgrounded: true })
  expect(await moved).toBe(true)
  const stopped = mgr.stopCommandTask(OPTS.tabId, 't1')
  await wait(10)
  const stop = lastControl(h.fakes[0])
  expect(stop.request).toEqual({ subtype: 'stop_task', task_id: 't1' })
  stop.reply({})
  await stopped
})
