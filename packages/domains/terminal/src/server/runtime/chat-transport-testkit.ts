/**
 * Test kit for the chat transport: fake children speaking Claude's stream-json
 * (with scripted answers to the host's control requests), and a harness that
 * records broadcasts and saved rows. Shared by the conversation-control suites.
 *
 * @module terminal/server/runtime/chat-transport-testkit
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'

/** Answer to one host control request: a success payload, an error, or none at all. */
export type ControlAnswer =
  | { success: Record<string, unknown> | undefined }
  | { error: string }
  | 'ignore'

export interface FakeChild {
  child: ChildProcess
  emitter: EventEmitter
  stdout: PassThrough
  stderr: PassThrough
  /** Every stdin line, parsed. */
  stdin: Array<Record<string, unknown>>
  kills: string[]
  /** Answer the host's control requests of `subtype` (default: success `{}`). */
  answer(subtype: string, fn: (request: Record<string, unknown>) => ControlAnswer): void
  /**
   * Subtypes of the host's control requests, in order — without the
   * `initialize` the Claude driver writes at every spawn (session setup, not
   * something the conversation did; `controlRequests('initialize')` has it).
   */
  controlSubtypes(): string[]
  controlRequests(subtype: string): Array<Record<string, unknown>>
  exit(code: number | null, signal?: string | null): void
}

export function fakeChild(opts: { exitOnKill?: boolean } = {}): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin: Array<Record<string, unknown>> = []
  const kills: string[] = []
  const answers = new Map<string, (request: Record<string, unknown>) => ControlAnswer>()
  let buf = ''
  const onLine = (msg: Record<string, unknown>): void => {
    if (msg.type !== 'control_request') return
    const request = (msg.request ?? {}) as Record<string, unknown>
    const fn = answers.get(String(request.subtype))
    const answer: ControlAnswer = fn ? fn(request) : { success: {} }
    if (answer === 'ignore') return
    const response =
      'error' in answer
        ? { subtype: 'error', request_id: msg.request_id, error: answer.error }
        : {
            subtype: 'success',
            request_id: msg.request_id,
            ...(answer.success === undefined ? {} : { response: answer.success })
          }
    setImmediate(() => stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n'))
  }
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: {
      write: (s: string, cb?: (err?: Error | null) => void) => {
        buf += s
        let i = buf.indexOf('\n')
        while (i !== -1) {
          const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
          stdin.push(msg)
          onLine(msg)
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
  const controls = (): Array<Record<string, unknown>> =>
    stdin
      .filter((m) => m.type === 'control_request')
      .map((m) => (m.request ?? {}) as Record<string, unknown>)
  return {
    child,
    emitter,
    stdout,
    stderr,
    stdin,
    kills,
    answer: (subtype, fn) => answers.set(subtype, fn),
    controlSubtypes: () =>
      controls()
        .map((r) => String(r.subtype))
        .filter((t) => t !== 'initialize'),
    controlRequests: (subtype) => controls().filter((r) => r.subtype === subtype),
    exit: (code, signal = null) => emitter.emit('exit', code, signal)
  }
}

export const emitLine = (f: FakeChild, obj: unknown): void => {
  f.stdout.write(JSON.stringify(obj) + '\n')
}
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll until `pred` holds (default 2 s). */
export async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time')
    await wait(5)
  }
}

// ---- stream-json lines ----

export const sj = {
  init: (sessionId: string) => ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'haiku',
    cwd: '/tmp',
    tools: [],
    permissionMode: 'default',
    claude_code_version: '2.1.312'
  }),
  text: (t: string, opts: { id?: string; uuid?: string } = {}) => ({
    type: 'assistant',
    message: { id: opts.id ?? 'msg_1', content: [{ type: 'text', text: t }] },
    parent_tool_use_id: null,
    ...(opts.uuid ? { uuid: opts.uuid } : {})
  }),
  toolUse: (id: string, name = 'Bash', input: Record<string, unknown> = {}) => ({
    type: 'assistant',
    message: { id: 'msg_t', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null
  }),
  success: (text = 'ok') => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    result: text
  }),
  /** The result the CLI ends an interrupted turn with (2.1.312). */
  aborted: (reason: 'aborted_streaming' | 'aborted_tools' = 'aborted_streaming') => ({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    terminal_reason: reason
  }),
  lifecycle: (uuid: string, state: string) => ({
    type: 'command_lifecycle',
    command_uuid: uuid,
    state
  }),
  canUseTool: (requestId: string, toolUseId: string) => ({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: toolUseId,
      permission_suggestions: []
    }
  }),
  cancel: (requestId: string) => ({ type: 'control_cancel_request', request_id: requestId })
}

// ---- harness ----

export interface TransportHarness {
  fakes: FakeChild[]
  /** Every broadcast: saved (no `live`) and live. */
  broadcasts: Array<{ kind: string; seq: number; live?: number; event: AgentEvent }>
  rows: Array<{ seq: number; event: AgentEvent }>
  states: mgr.ChatTerminalState[]
  /** Every SAVED event, in order. */
  saved(): AgentEvent[]
  savedKinds(): string[]
}

export function transportHarness(
  opts: {
    exitOnKill?: boolean
    timings?: { startingBoundMs: number; runningStallMs: number; killGraceMs: number }
    /** Configure each new fake before the transport starts talking to it. */
    onFake?: (f: FakeChild, index: number) => void
    /** See each spawn's argv. */
    onSpawn?: (args: string[]) => void
    history?: Array<{ seq: number; event: AgentEvent }>
  } = {}
): TransportHarness {
  mgr.__resetForTests()
  const h: TransportHarness = {
    fakes: [],
    broadcasts: [],
    rows: [],
    states: [],
    saved: () => h.broadcasts.filter((b) => b.live === undefined).map((b) => b.event),
    savedKinds: () => h.saved().map((e) => e.kind)
  }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      opts.onSpawn?.(args)
      const f = fakeChild({ exitOnKill: opts.exitOnKill ?? true })
      opts.onFake?.(f, h.fakes.length)
      h.fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    broadcastEvent: (_tab, event, seq, live) =>
      h.broadcasts.push({ kind: event.kind, seq, ...(live !== undefined ? { live } : {}), event }),
    broadcastExit: () => undefined,
    broadcastStateChange: (_id, state) => h.states.push(state),
    eventStore: {
      load: async () => opts.history ?? [],
      insert: async (_tab, seq, event) => {
        h.rows.push({ seq, event })
        return 'inserted'
      }
    },
    ...(opts.timings ? { watchdogTimings: opts.timings } : {})
  })
  return h
}

export const TAB_OPTS = {
  tabId: 'tab',
  taskId: 'task',
  mode: 'claude-chat',
  cwd: '/tmp',
  conversationId: null as string | null,
  providerFlags: [] as string[]
}

export async function startTab(over: Partial<typeof TAB_OPTS> = {}): Promise<void> {
  await mgr.hydrateSession({ ...TAB_OPTS, ...over })
  await mgr.ensureSpawned(TAB_OPTS.tabId)
}

/** Send a user message through the outbox and let the fake take it (lifecycle queued + started). */
export async function sendAndStart(f: FakeChild, id: string, text = 'hello'): Promise<void> {
  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id, content: [{ type: 'text', text }] })
  await until(() => f.stdin.some((m) => m.type === 'user' && m.uuid === id))
  emitLine(f, sj.lifecycle(id, 'queued'))
  emitLine(f, sj.lifecycle(id, 'started'))
  await wait(10)
}
