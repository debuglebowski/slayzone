/**
 * The Codex driver's turn data (codex-cli 0.159.2 wire): the CLI version from
 * the handshake, the account's models from `model/list`, which model and effort
 * a turn sends, readable errors (the CLI's refusals included), live command
 * output through the command-task path, and the context meter's data.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { ChatDriverContext, ChatSessionDriver } from '../types'
import { codexChatBackend } from './codex-chat-session'

type Json = Record<string, unknown>
type Driver = ChatSessionDriver &
  Required<Pick<ChatSessionDriver, 'applyControl' | 'commandTaskOutput'>>

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** codex-cli 0.159.2's `model/list` rows (recorded account, trimmed). */
const MODELS = [
  {
    id: 'gpt-6.1-sol',
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    description: 'Frontier model',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'max', description: 'Most' },
      { reasoningEffort: 'ultra', description: 'Proactive' }
    ]
  },
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    description: 'Fast and affordable',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'xhigh', description: 'Deep' }
    ]
  },
  {
    id: 'internal',
    model: 'internal',
    displayName: 'Internal',
    description: '',
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: []
  }
]

interface H {
  driver: Driver
  sent: Json[]
  emitted: AgentEvent[]
  feed(msg: Json): Promise<AgentEvent[]>
  request(method: string): Json | undefined
  turnStarts(): Json[]
}

async function harness(
  ctx: Partial<ChatDriverContext> = {},
  opts: { userAgent?: string; models?: unknown[] | null } = {}
): Promise<H> {
  const sent: Json[] = []
  const emitted: AgentEvent[] = []
  const driver = codexChatBackend.createDriver() as Driver
  void driver.start({
    write: (line) => sent.push(JSON.parse(line) as Json),
    emit: (e) => emitted.push(e),
    cwd: '/work',
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'auto-accept-edits',
    chatCollaboration: null,
    chatFastMode: false,
    ...ctx
  })
  const h: H = {
    driver,
    sent,
    emitted,
    async feed(msg) {
      const before = emitted.length
      driver.handleLine(JSON.stringify(msg))
      await flush()
      return emitted.slice(before)
    },
    request: (method) => sent.find((s) => s.method === method && s.id !== undefined),
    turnStarts: () =>
      sent.filter((s) => s.method === 'turn/start').map((s) => (s.params ?? {}) as Json)
  }
  await flush()
  await h.feed({
    id: 1,
    result: {
      userAgent: opts.userAgent ?? 'slayzone/0.159.2 (Mac OS 26.5.2; arm64) x (slayzone; 1.0)'
    }
  })
  await h.feed({ id: 2, result: { thread: { id: 'th' }, model: 'gpt-6.1-sol', cwd: '/work' } })
  const list = h.request('model/list')
  if (list && opts.models !== null) {
    await h.feed({
      id: list.id as number,
      result: { data: opts.models ?? MODELS, nextCursor: null }
    })
  }
  return h
}

async function turn(h: H, text = 'go'): Promise<Json> {
  h.driver.sendUserMessage(text)
  await flush()
  return h.turnStarts().at(-1)!
}

const ofKind = <K extends AgentEvent['kind']>(events: AgentEvent[], kind: K) =>
  events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind)

describe('handshake: CLI version and the account’s models', () => {
  it('turn-init carries the CLI version from the handshake’s userAgent', async () => {
    const h = await harness()
    expect(ofKind(h.emitted, 'turn-init')[0]).toMatchObject({
      sessionId: 'th',
      cliVersion: '0.159.2',
      model: 'gpt-6.1-sol'
    })
  })

  it('model/list → cli-models: visible models, labels, efforts, defaults', async () => {
    const h = await harness()
    expect(h.request('model/list')).toBeDefined()
    expect(ofKind(h.emitted, 'cli-models')).toEqual([
      {
        kind: 'cli-models',
        models: [
          {
            id: 'gpt-6.1-sol',
            label: 'GPT-6.1-Sol',
            description: 'Frontier model',
            supportsEffort: true,
            isDefault: true,
            defaultEffort: 'low',
            efforts: [
              { id: 'low', label: 'Low', description: 'Fast' },
              { id: 'max', label: 'Max', description: 'Most' },
              { id: 'ultra', label: 'Ultra', description: 'Proactive' }
            ]
          },
          {
            id: 'gpt-6-luna',
            label: 'GPT-6-Luna',
            description: 'Fast and affordable',
            supportsEffort: true,
            isDefault: false,
            defaultEffort: 'medium',
            efforts: [
              { id: 'low', label: 'Low', description: 'Fast' },
              { id: 'xhigh', label: 'Xhigh', description: 'Deep' }
            ]
          }
        ]
      }
    ])
  })
})

describe('which model and effort a turn sends', () => {
  it('no stored model: no model param (the account’s default runs), never a hardcoded one', async () => {
    const h = await harness()
    const params = await turn(h)
    expect(params).not.toHaveProperty('model')
    expect(h.request('thread/start')!.params).not.toHaveProperty('model')
  })

  it('a stored model the account offers is sent', async () => {
    const h = await harness({ chatModel: 'gpt-6-luna' })
    expect((await turn(h)).model).toBe('gpt-6-luna')
  })

  it('a stored model the account does not offer: the default runs instead, and a notice says so', async () => {
    const h = await harness({ chatModel: 'gpt-5.5' })
    expect((await turn(h)).model).toBe('gpt-6.1-sol')
    const notice = ofKind(h.emitted, 'notice')[0]
    expect(notice.text).toContain('gpt-5.5')
    expect(notice.text).toContain('GPT-6.1-Sol')
  })

  it('plan mode’s collaborationMode names the thread’s model, not a hardcoded default', async () => {
    const h = await harness({ chatCollaboration: 'plan' })
    const params = await turn(h)
    expect((params.collaborationMode as { settings: Json }).settings.model).toBe('gpt-6.1-sol')
  })

  it('an effort the model lists is sent as is (max is a real Codex effort now)', async () => {
    const h = await harness({ chatModel: 'gpt-6.1-sol', chatEffort: 'max' })
    expect((await turn(h)).effort).toBe('max')
  })

  it('an effort the model does not list is left out (the model’s default applies)', async () => {
    const h = await harness({ chatModel: 'gpt-6-luna', chatEffort: 'max' })
    expect(await turn(h)).not.toHaveProperty('effort')
  })
})

describe('readable errors', () => {
  const blob = (message: string, code = 'model_not_found') =>
    JSON.stringify({
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', message, code }
    })

  it('an API error is its message, not the JSON blob', async () => {
    const h = await harness()
    await turn(h)
    const out = await h.feed({
      method: 'error',
      params: { error: { message: blob('Rate limited.', 'rate_limit') }, willRetry: false }
    })
    expect(ofKind(out, 'error')).toEqual([{ kind: 'error', message: 'Rate limited.' }])
  })

  it('a CLI too old for the model: one clear fatal error with the installed version and the update', async () => {
    const h = await harness({}, { userAgent: 'slayzone/0.139.0 (x)' })
    await turn(h)
    const out = await h.feed({
      method: 'error',
      params: {
        error: { message: blob('The gpt-5.6-luna model requires a newer version of Codex.') },
        willRetry: false
      }
    })
    const [err] = ofKind(out, 'error')
    expect(err.message).toContain('0.139.0')
    expect(err.message).toContain('npm install -g @openai/codex')
    expect(err.message.trimStart().startsWith('{')).toBe(false)
    expect(err.detail).toEqual({ code: 'cli-too-old', installed: '0.139.0', fatal: true })
  })

  it('a model the account may not use: the reason, and what to do', async () => {
    const h = await harness({}, { userAgent: 'slayzone/0.139.0 (x)' })
    await turn(h)
    const out = await h.feed({
      method: 'error',
      params: {
        error: {
          message: blob(
            "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
          )
        },
        willRetry: false
      }
    })
    const [err] = ofKind(out, 'error')
    expect(err.message).toContain("The 'gpt-5.5' model is not supported")
    expect(err.message).toContain('0.139.0')
    expect(err.detail).toEqual({ code: 'model-refused', installed: '0.139.0' })
  })
})

describe('live command output (command-task path)', () => {
  const cmd = (status: string, extra: Json = {}) => ({
    type: 'commandExecution',
    id: 'exec-1',
    command: 'npm test',
    cwd: '/work',
    commandActions: [],
    status,
    aggregatedOutput: null,
    exitCode: null,
    ...extra
  })

  it('a running command: tool-call + command-task running; its output is polled, never emitted per chunk', async () => {
    const h = await harness()
    await turn(h)
    const started = await h.feed({ method: 'item/started', params: { item: cmd('inProgress') } })
    expect(started[0]).toMatchObject({
      kind: 'tool-call',
      id: 'exec-1',
      name: 'codex/commandExecution',
      input: { command: 'npm test', cwd: '/work', commandActions: [] }
    })
    expect(started[1]).toMatchObject({
      kind: 'command-task',
      taskId: 'exec-1',
      toolUseId: 'exec-1',
      status: 'running',
      backgrounded: false
    })
    expect(typeof (started[1] as { startedAt?: number }).startedAt).toBe('number')
    for (const delta of ['step 1\n', 'step 2\n']) {
      const out = await h.feed({
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'exec-1', delta }
      })
      expect(out).toEqual([])
    }
    expect(await h.driver.commandTaskOutput('exec-1')).toEqual({
      state: 'running',
      output: 'step 1\nstep 2\n',
      totalBytes: 14,
      truncated: false
    })
    const done = await h.feed({
      method: 'item/completed',
      params: { item: cmd('completed', { aggregatedOutput: 'step 1\nstep 2\n', exitCode: 0 }) }
    })
    expect(done.map((e) => e.kind)).toEqual(['command-task', 'tool-result'])
    expect(done[0]).toMatchObject({ status: 'completed', taskId: 'exec-1' })
    expect(await h.driver.commandTaskOutput('exec-1')).toMatchObject({ state: 'ended' })
    expect(await h.driver.commandTaskOutput('other')).toEqual({ state: 'gone' })
  })

  it('a failed / declined command ends failed', async () => {
    const h = await harness()
    await turn(h)
    await h.feed({ method: 'item/started', params: { item: cmd('inProgress') } })
    const done = await h.feed({
      method: 'item/completed',
      params: { item: cmd('failed', { exitCode: 1 }) }
    })
    expect(done[0]).toMatchObject({ kind: 'command-task', status: 'failed' })
  })

  it('a command a Stop cut off (no item/completed in 0.159.2) ends killed with the turn', async () => {
    const h = await harness()
    await turn(h)
    await h.feed({ method: 'item/started', params: { item: cmd('inProgress') } })
    const out = await h.feed({
      method: 'turn/completed',
      params: { turn: { id: 't', status: 'interrupted', durationMs: 5 } }
    })
    expect(out.map((e) => e.kind)).toEqual(['command-task', 'result'])
    expect(out[0]).toMatchObject({ status: 'killed', taskId: 'exec-1' })
  })

  it('the output kept is the last 8 KiB', async () => {
    const h = await harness()
    await turn(h)
    await h.feed({ method: 'item/started', params: { item: cmd('inProgress') } })
    await h.feed({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'exec-1', delta: 'x'.repeat(10_000) }
    })
    const out = await h.driver.commandTaskOutput('exec-1')
    expect(out).toMatchObject({ state: 'running', totalBytes: 10_000, truncated: true })
    expect((out as { output: string }).output).toHaveLength(8192)
  })
})

describe('context meter data', () => {
  const usage = (total: number, window: number | null) => ({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'th',
      turnId: 't',
      tokenUsage: {
        total: {
          totalTokens: 99_999,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0
        },
        last: {
          totalTokens: total,
          inputTokens: total - 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0
        },
        modelContextWindow: window
      }
    }
  })

  it('thread/tokenUsage/updated → context-usage (last call’s tokens, the window); unchanged → nothing', async () => {
    const h = await harness()
    expect(await h.feed(usage(4684, 258_400))).toEqual([
      { kind: 'context-usage', contextTokens: 4684, contextWindow: 258_400 }
    ])
    expect(await h.feed(usage(4684, 258_400))).toEqual([])
    expect(await h.feed(usage(5000, null))).toEqual([
      { kind: 'context-usage', contextTokens: 5000, contextWindow: null }
    ])
  })
})

describe('live settings', () => {
  it('apply_flag_settings {effortLevel} (the live effort path) sets the next turn’s effort', async () => {
    const h = await harness({ chatModel: 'gpt-6.1-sol', chatEffort: 'low' })
    await expect(
      h.driver.applyControl(
        { subtype: 'apply_flag_settings', settings: { effortLevel: 'ultra' } },
        1000
      )
    ).resolves.toBeDefined()
    expect((await turn(h)).effort).toBe('ultra')
  })
})
