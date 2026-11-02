/**
 * The Codex driver's turn data (codex-cli 0.159.2 wire): the CLI version from
 * the handshake, the account's models from `model/list`, which model and effort
 * a turn sends, readable errors (the CLI's refusals included), live command
 * output through the command-task path, and the context meter's data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { ChatDriverContext, ChatSessionDriver } from '../types'
import { buildCodexContent } from './codex-content'
import { setChatAttachmentReader } from '../chat-attachment-reader'
import { codexChatBackend } from './codex-chat-session'
import { initialState, reducer } from '../../../shared/chat-timeline'

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
  opts: { userAgent?: string; models?: unknown[] | null; history?: unknown[]; driver?: Driver } = {}
): Promise<H> {
  const sent: Json[] = []
  const emitted: AgentEvent[] = []
  const driver = opts.driver ?? (codexChatBackend.createDriver() as Driver)
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
  const history = h.request('thread/turns/list')
  if (history)
    await h.feed({ id: history.id, result: { data: opts.history ?? [], nextCursor: null } })
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

describe('Plan mode proposal', () => {
  it('uses completed plan item text, even when streamed text differs', async () => {
    const h = await harness({ chatCollaboration: 'plan' })
    await turn(h)
    await h.feed({
      method: 'item/started',
      params: { item: { type: 'plan', id: 'plan-1', text: '' }, turnId: 'turn-1' }
    })
    await h.feed({
      method: 'item/plan/delta',
      params: { itemId: 'plan-1', turnId: 'turn-1', delta: 'draft' }
    })
    await h.feed({
      method: 'item/completed',
      params: { item: { type: 'plan', id: 'plan-1', text: 'final plan' }, turnId: 'turn-1' }
    })
    expect(h.emitted).toContainEqual({
      kind: 'codex-plan',
      planId: 'plan-1',
      turnId: 'turn-1',
      text: 'final plan',
      phase: 'completed'
    })
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

describe('Codex background terminals', () => {
  afterEach(() => vi.useRealTimers())

  async function polling() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await harness()
    await vi.advanceTimersByTimeAsync(1_000)
    const request = h.sent.find((s) => s.method === 'thread/backgroundTerminals/list')
    expect(request).toBeDefined()
    return { h, request: request! }
  }

  const job = { itemId: 'watch', processId: '42', command: 'watch-azure', cwd: '/work' }

  it('discovers jobs on resume, keeps them across turns, and streams their output', async () => {
    const { h, request } = await polling()
    const events = await h.feed({ id: request.id, result: { data: [job], nextCursor: null } })
    expect(ofKind(events, 'tool-call')[0]).toMatchObject({
      id: 'watch',
      input: { command: 'watch-azure' }
    })
    expect(ofKind(events, 'command-task')[0]).toMatchObject({
      taskId: 'watch',
      toolUseId: 'watch',
      backgrounded: true,
      status: 'running'
    })
    const timeline = h.emitted.reduce(
      (state, event) => reducer(state, { type: 'event', event }),
      initialState()
    )
    expect(timeline.bgShells.get('watch')).toMatchObject({
      shellId: 'watch',
      command: 'watch-azure',
      status: 'running'
    })
    const ended = await h.feed({
      method: 'turn/completed',
      params: { turn: { id: 't', status: 'completed' } }
    })
    expect(ofKind(ended, 'command-task')).toEqual([])
    await h.feed({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'watch', delta: 'changed' }
    })
    expect(await h.driver.commandTaskOutput('watch')).toMatchObject({
      state: 'running',
      output: 'changed'
    })
    h.driver.dispose()
  })

  it('only reconciles after all pages; stopping uses the native process id', async () => {
    const { h, request } = await polling()
    await h.feed({ id: request.id, result: { data: [job], nextCursor: 'next' } })
    const page = h.sent.at(-1)!
    expect(page.params).toMatchObject({ threadId: 'th', cursor: 'next' })
    await h.feed({ id: page.id, result: { data: [], nextCursor: null } })
    const stop = h.driver.stopCommandTask!('watch')
    const terminate = h.sent.at(-1)!
    expect(terminate).toMatchObject({
      method: 'thread/backgroundTerminals/terminate',
      params: { threadId: 'th', processId: '42' }
    })
    const events = await h.feed({ id: terminate.id, result: { terminated: true } })
    await stop
    expect(ofKind(events, 'command-task')[0]).toMatchObject({
      status: 'killed',
      backgrounded: true
    })
    h.driver.dispose()
  })

  it('marks disappeared jobs ended; a failed list preserves running jobs', async () => {
    const { h, request } = await polling()
    await h.feed({ id: request.id, result: { data: [job], nextCursor: null } })
    await vi.advanceTimersByTimeAsync(1_000)
    await h.feed({
      id: h.sent.at(-1)!.id,
      error: { code: -32000, message: 'temporarily unavailable' }
    })
    expect(await h.driver.commandTaskOutput('watch')).toMatchObject({ state: 'running' })
    await vi.advanceTimersByTimeAsync(1_000)
    const events = await h.feed({ id: h.sent.at(-1)!.id, result: { data: [], nextCursor: null } })
    expect(ofKind(events, 'command-task')[0]).toMatchObject({
      status: 'completed',
      backgrounded: true
    })
    h.driver.dispose()
  })

  it('discovers a command after its foreground tool returned, and saves final output', async () => {
    const { h, request } = await polling()
    await h.feed({
      method: 'item/started',
      params: {
        item: { type: 'commandExecution', id: 'watch', command: 'watch-azure', cwd: '/work' }
      }
    })
    await h.feed({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'watch', status: 'completed', exitCode: 0 } }
    })
    const events = await h.feed({ id: request.id, result: { data: [job], nextCursor: null } })
    expect(ofKind(events, 'tool-call')).toEqual([])
    expect(ofKind(events, 'command-task')[0]).toMatchObject({
      backgrounded: true,
      status: 'running'
    })
    const ended = await h.feed({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'watch',
          status: 'failed',
          exitCode: 1,
          aggregatedOutput: 'access denied'
        }
      }
    })
    expect(ofKind(ended, 'command-task')[0]).toMatchObject({ backgrounded: true, status: 'failed' })
    expect(ofKind(ended, 'command-task-output')[0]).toMatchObject({
      output: 'access denied',
      totalBytes: 13
    })
    h.driver.dispose()
  })

  it('older CLIs disable polling; disposal cancels scheduled requests', async () => {
    const { h, request } = await polling()
    await h.feed({ id: request.id, error: { code: -32601, message: 'Method not found' } })
    const count = h.sent.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent).toHaveLength(count)
    h.driver.dispose()
    const fresh = await harness()
    fresh.driver.dispose()
    const before = fresh.sent.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fresh.sent).toHaveLength(before)
  })
})

describe('native Codex images', () => {
  afterEach(() => setChatAttachmentReader(undefined))

  it('prepares sealed bytes as native image input and preserves the client message id', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const read = vi.fn(async () => png)
    setChatAttachmentReader({ read })
    const h = await harness()
    const message = {
      id: 'image-message',
      content: [
        {
          type: 'attachment' as const,
          attachment: {
            artifactId: 'image',
            contentHash: 'sealed',
            name: 'shot.png',
            kind: 'image' as const,
            mediaType: 'image/png' as const,
            size: png.length
          }
        },
        { type: 'text' as const, text: 'describe this' }
      ]
    }
    const prepared = await h.driver.prepareUserTurn!(message)
    await h.driver.sendUserTurn!(message, prepared)
    expect(read).toHaveBeenCalledWith({ artifactId: 'image', contentHash: 'sealed' })
    expect(h.turnStarts()[0]).toMatchObject({
      clientUserMessageId: message.id,
      input: [
        { type: 'image', url: `data:image/png;base64,${png.toString('base64')}` },
        { type: 'text', text: 'describe this', text_elements: [] }
      ]
    })
    h.driver.dispose()
  })

  it('retains image-only inputs sent before the handshake finishes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    setChatAttachmentReader({ read: async () => png })
    const driver = codexChatBackend.createDriver() as Driver
    const message = {
      id: 'early-image',
      content: [
        {
          type: 'attachment' as const,
          attachment: {
            artifactId: 'image',
            name: 'shot.png',
            kind: 'image' as const,
            mediaType: 'image/png' as const,
            size: png.length
          }
        }
      ]
    }
    const prepared = await driver.prepareUserTurn!(message)
    await driver.sendUserTurn!(message, prepared)
    const h = await harness({}, { driver })
    expect(h.turnStarts()[0]).toMatchObject({
      clientUserMessageId: 'early-image',
      input: [{ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }]
    })
    driver.dispose()
  })

  it('refuses unreadable files before starting a turn', async () => {
    setChatAttachmentReader({
      read: async () => {
        throw new Error('gone')
      }
    })
    const h = await harness()
    await expect(
      h.driver.prepareUserTurn!({
        id: 'missing',
        content: [
          {
            type: 'attachment',
            attachment: {
              artifactId: 'gone',
              name: 'gone.png',
              kind: 'image',
              mediaType: 'image/png',
              size: 10
            }
          }
        ]
      })
    ).rejects.toThrow(/gone.png.*no longer available/)
    expect(h.turnStarts()).toEqual([])
    h.driver.dispose()
  })
})

describe('native image history', () => {
  it('recovers sealed refs by client id when importing a switched-to or forked thread', async () => {
    const addHistory = vi.fn()
    const content = [
      {
        type: 'attachment' as const,
        attachment: {
          artifactId: 'image',
          contentHash: 'sealed',
          name: 'shot.png',
          kind: 'image' as const,
          mediaType: 'image/png' as const,
          size: 9
        }
      },
      { type: 'text' as const, text: 'describe' }
    ]
    const lookupUserMessages = vi.fn(async () => new Map([['m', content]]))
    const h = await harness(
      { importHistory: true, addHistory, lookupUserMessages },
      {
        history: [
          {
            id: 'turn',
            items: [
              {
                type: 'userMessage',
                id: 'provider-id',
                clientId: 'm',
                content: [
                  { type: 'image', url: 'data:image/png;base64,ignored' },
                  { type: 'text', text: 'describe' }
                ]
              }
            ]
          }
        ]
      }
    )
    expect(lookupUserMessages).toHaveBeenCalledWith(['m'])
    expect(addHistory).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'user-message',
        id: 'm',
        text: 'describe',
        content,
        history: true
      })
    ])
    expect(JSON.stringify(addHistory.mock.calls)).not.toContain('data:image')
    h.driver.dispose()
  })
})

it('Codex image-only input uses sniffed media type; refuses spoofed documents and oversize bytes', async () => {
  const attachment = {
    type: 'attachment' as const,
    attachment: {
      artifactId: 'image',
      name: 'shot.png',
      kind: 'image' as const,
      mediaType: 'image/png' as const,
      size: 9
    }
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])
  expect(await buildCodexContent([attachment], { read: async () => jpeg })).toEqual([
    { type: 'image', url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }
  ])
  await expect(buildCodexContent([attachment], undefined)).rejects.toThrow(
    /cannot read attached files/
  )
  await expect(
    buildCodexContent([attachment], { read: async () => Buffer.from('%PDF-1.7') })
  ).rejects.toThrow(/not a supported image/)
  const huge = Buffer.alloc(6 * 1024 * 1024)
  jpeg.copy(huge)
  await expect(buildCodexContent([attachment], { read: async () => huge })).rejects.toThrow(
    /too large|maximum|limit|MB/i
  )
})
