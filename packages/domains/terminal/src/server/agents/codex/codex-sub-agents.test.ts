/**
 * Codex sub-agents (`multi_agent`): the driver against REAL recorded runs
 * (fake-codex transcripts `sub-agent`, `sub-agent-interrupt`, codex-cli 0.159.2).
 *
 * Wire facts, as recorded: the parent's `subAgentActivity` item (`started`)
 * names the child's thread (`agentThreadId`); the child's own notifications
 * (turn, items, token usage) then arrive on the SAME connection, carrying the
 * child's thread id; `subAgentActivity` (`completed`) and the child's own
 * `turn/completed` end it. A Stop of the parent's turn does not end the child.
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { recordedCodexMessages } from '@slayzone/test-utils/fake-codex/recorded'
import { initialState, reducer, type TimelineItem } from '../../../shared/chat-timeline'
import { codexChatBackend } from './codex-chat-session'
import type { ChatDriverContext, ChatSessionDriver } from '../types'

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
const MAIN = '{{threadId}}'
const CHILD = '{{subThread1}}'

interface Harness {
  driver: ChatSessionDriver
  sent: Record<string, unknown>[]
  emitted: AgentEvent[]
}

async function started(): Promise<Harness> {
  const sent: Record<string, unknown>[] = []
  const emitted: AgentEvent[] = []
  const ctx: ChatDriverContext = {
    write: (line) => sent.push(JSON.parse(line)),
    emit: (event) => emitted.push(event),
    cwd: '/work',
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'full-access',
    chatCollaboration: null,
    chatFastMode: false
  }
  const driver = codexChatBackend.createDriver()
  void driver.start(ctx)
  await flush()
  driver.handleLine(
    JSON.stringify({ id: 1, result: { userAgent: 'codex/0.159.2', codexHome: '/h' } })
  )
  await flush()
  driver.handleLine(
    JSON.stringify({ id: 2, result: { thread: { id: MAIN }, model: 'gpt-6-luna', cwd: '/work' } })
  )
  await flush()
  return { driver, sent, emitted }
}

/** Feed a recorded run's notifications (everything the CLI printed with a `method`). */
async function replay(h: Harness, recipe: string): Promise<void> {
  for (const m of recordedCodexMessages(recipe)) {
    if (m.id !== undefined) continue
    h.driver.handleLine(JSON.stringify({ jsonrpc: '2.0', method: m.method, params: m.params }))
  }
  await flush()
}

function timelineOf(events: AgentEvent[]) {
  return reducer(initialState(), { type: 'events', events })
}

type SubAgentRow = Extract<TimelineItem, { kind: 'sub-agent' }>
const subAgentRows = (rows: ReadonlyArray<TimelineItem | undefined>): SubAgentRow[] =>
  rows.filter((r): r is SubAgentRow => r?.kind === 'sub-agent')

/** The spawn's item id (the row's id): the parent's `subAgentActivity` `started`. */
function spawnId(recipe: string): string {
  const m = recordedCodexMessages(recipe).find(
    (x) =>
      x.method === 'item/started' &&
      (x.params.item as { type?: string; kind?: string })?.type === 'subAgentActivity'
  )
  return (m!.params.item as { id: string }).id
}

describe('Codex sub-agents (recorded: sub-agent)', () => {
  test('one sub-agent row: named after the agent, backgrounded, completed with its usage', async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const state = timelineOf(h.emitted)
    const rows = subAgentRows(state.timeline)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      toolUseId: spawnId('sub-agent'),
      phase: 'completed',
      status: 'completed',
      description: 'pong',
      backgrounded: true
    })
    expect(rows[0].totalTokens).toBeGreaterThan(0)
    expect(rows[0].parentToolUseId).toBeUndefined()
  })

  test("the child's reply nests under its row; the parent's reply stays at the root", async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const state = timelineOf(h.emitted)
    const id = spawnId('sub-agent')
    const children = (state.childIndex.get(id) ?? []).map((i) => state.timeline[i])
    expect(children.some((c) => c?.kind === 'text' && c.text === 'PONG')).toBe(true)
    const rootTexts = state.timeline.filter(
      (r) => r?.kind === 'text' && r.role === 'assistant' && !r.parentToolUseId
    )
    expect(rootTexts.map((r) => (r as { text: string }).text)).toEqual(['PONG'])
  })

  test("the child's turn ending does not end the parent's turn: one result, the parent's", async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const results = h.emitted.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(1)
    // The parent's `turn/completed` is the LAST thing the run printed about a turn.
    expect(h.emitted.findLastIndex((e) => e.kind === 'result')).toBeGreaterThan(
      h.emitted.findLastIndex((e) => e.kind === 'sub-agent')
    )
  })

  test("the child's text never streams into the parent's message", async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const childMessageIds = recordedCodexMessages('sub-agent')
      .filter((m) => m.params.threadId === CHILD && m.method === 'item/started')
      .map((m) => (m.params.item as { id: string }).id)
    expect(childMessageIds.length).toBeGreaterThan(0)
    const streamed = h.emitted.filter(
      (e) => e.kind === 'stream-message-start' && childMessageIds.includes(e.messageId)
    )
    expect(streamed).toEqual([])
  })

  test("the context meter is the parent's: a child's token usage never moves it", async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const parentLast = recordedCodexMessages('sub-agent')
      .filter((m) => m.method === 'thread/tokenUsage/updated' && m.params.threadId === MAIN)
      .map((m) => (m.params.tokenUsage as { last: { totalTokens: number } }).last.totalTokens)
    const childTotals = recordedCodexMessages('sub-agent')
      .filter((m) => m.method === 'thread/tokenUsage/updated' && m.params.threadId === CHILD)
      .map((m) => (m.params.tokenUsage as { last: { totalTokens: number } }).last.totalTokens)
    const meter = h.emitted.flatMap((e) => (e.kind === 'context-usage' ? [e.contextTokens] : []))
    expect(meter.at(-1)).toBe(parentLast.at(-1))
    for (const t of childTotals) if (!parentLast.includes(t)) expect(meter).not.toContain(t)
  })

  test("the parent's wait is a tool card at the root, closed when the wait ends", async () => {
    const h = await started()
    await replay(h, 'sub-agent')
    const state = timelineOf(h.emitted)
    const waits = state.timeline.filter(
      (r) => r?.kind === 'tool' && r.invocation.name === 'codex/agent/wait'
    )
    expect(waits).toHaveLength(1)
    const wait = waits[0] as Extract<TimelineItem, { kind: 'tool' }>
    expect(wait.parentToolUseId).toBeUndefined()
    expect(wait.invocation.result).toBeDefined()
    expect(wait.invocation.result?.isError).toBe(false)
  })
})

describe('Codex sub-agents (recorded: sub-agent-interrupt)', () => {
  test("a Stop of the parent's turn leaves the sub-agent running (it is), its command nested", async () => {
    const h = await started()
    await replay(h, 'sub-agent-interrupt')
    const state = timelineOf(h.emitted)
    const rows = subAgentRows(state.timeline)
    expect(rows).toHaveLength(1)
    expect(rows[0].phase).toBe('in-flight')
    const id = spawnId('sub-agent-interrupt')
    const children = (state.childIndex.get(id) ?? []).map((i) => state.timeline[i])
    expect(
      children.some((c) => c?.kind === 'tool' && c.invocation.name === 'codex/commandExecution')
    ).toBe(true)
    expect(h.emitted.filter((e) => e.kind === 'result')).toHaveLength(1)
  })

  test("Stop stops the running sub-agents' turns too", async () => {
    const h = await started()
    // Up to (not including) the parent's interrupted turn/completed: all still running.
    const msgs = recordedCodexMessages('sub-agent-interrupt').filter((m) => m.id === undefined)
    const cut = msgs.findIndex((m) => m.method === 'turn/completed')
    for (const m of msgs.slice(0, cut))
      h.driver.handleLine(JSON.stringify({ jsonrpc: '2.0', method: m.method, params: m.params }))
    await flush()
    void h.driver.applyControl?.({ subtype: 'interrupt' }, 1_000)
    await flush()
    const interrupts = h.sent.filter((m) => m.method === 'turn/interrupt')
    const threads = interrupts.map((m) => (m.params as { threadId: string }).threadId)
    expect(threads).toContain(MAIN)
    expect(threads).toContain(CHILD)
  })

  test('stopping one sub-agent interrupts its own turn only', async () => {
    const h = await started()
    await replay(h, 'sub-agent-interrupt')
    const before = h.sent.length
    void h.driver.stopSubAgent?.(spawnId('sub-agent-interrupt'))
    await flush()
    const sent = h.sent.slice(before).filter((m) => m.method === 'turn/interrupt')
    expect(sent.map((m) => (m.params as { threadId: string }).threadId)).toEqual([CHILD])
    expect((sent[0].params as { turnId?: string }).turnId).toBeTruthy()
  })

  test('a Stop between its turns waits for its next turn, then interrupts it', async () => {
    const h = await started()
    await replay(h, 'sub-agent-interrupt')
    const line = (method: string, params: unknown) =>
      h.driver.handleLine(JSON.stringify({ jsonrpc: '2.0', method, params }))
    // Its turn over, the row still open (a status Codex has not told us the meaning of).
    line('turn/completed', {
      threadId: CHILD,
      turn: { id: 'child-turn', status: 'other', items: [] }
    })
    await flush()
    const before = h.sent.length
    await h.driver.stopSubAgent?.(spawnId('sub-agent-interrupt'))
    expect(h.sent.slice(before).filter((m) => m.method === 'turn/interrupt')).toEqual([])
    line('turn/started', { threadId: CHILD, turn: { id: 'child-turn-2' } })
    await flush()
    expect(
      h.sent
        .slice(before)
        .filter((m) => m.method === 'turn/interrupt')
        .map((m) => m.params)
    ).toEqual([{ threadId: CHILD, turnId: 'child-turn-2' }])
  })

  test('stopping a sub-agent that is not running refuses', async () => {
    const h = await started()
    await replay(h, 'sub-agent-interrupt')
    await expect(h.driver.stopSubAgent?.('no-such-row')).rejects.toThrow(/not running/)
    h.driver.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: CHILD, turn: { id: 'child-turn', status: 'completed', items: [] } }
      })
    )
    await flush()
    await expect(h.driver.stopSubAgent?.(spawnId('sub-agent-interrupt'))).rejects.toThrow(
      /not running/
    )
  })

  test("a sub-agent's turn ending interrupted fails its row", async () => {
    const h = await started()
    await replay(h, 'sub-agent-interrupt')
    h.driver.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: CHILD, turn: { id: 'child-turn', status: 'interrupted', items: [] } }
      })
    )
    await flush()
    const rows = subAgentRows(timelineOf(h.emitted).timeline)
    expect(rows[0]).toMatchObject({ phase: 'failed', status: 'interrupted' })
    expect(h.emitted.filter((e) => e.kind === 'result')).toHaveLength(1)
  })
})

describe('Codex sub-agents: wire variants', () => {
  test('a v1 spawnAgent call (collabAgentToolCall) is the row; its child events, early ones too, nest', async () => {
    const h = await started()
    const send = (method: string, params: Record<string, unknown>): void =>
      h.driver.handleLine(JSON.stringify({ jsonrpc: '2.0', method, params }))
    const spawn = {
      type: 'collabAgentToolCall',
      id: 'call_spawn',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: MAIN,
      receiverThreadIds: [] as string[],
      prompt: 'Count the files in src.\nThen report.',
      model: null,
      reasoningEffort: null,
      agentsStates: {}
    }
    send('turn/started', { threadId: MAIN, turn: { id: 't1', status: 'inProgress', items: [] } })
    send('item/started', { threadId: MAIN, turnId: 't1', item: spawn })
    // The child speaks before the spawn call named it.
    send('item/completed', {
      threadId: 'child-x',
      turnId: 'ct',
      item: { type: 'agentMessage', id: 'm-child', text: 'early' }
    })
    send('item/completed', {
      threadId: MAIN,
      turnId: 't1',
      item: {
        ...spawn,
        status: 'completed',
        receiverThreadIds: ['child-x'],
        agentsStates: { 'child-x': { status: 'running', message: null } }
      }
    })
    send('item/completed', {
      threadId: 'child-x',
      turnId: 'ct',
      item: { type: 'agentMessage', id: 'm-child-2', text: 'done: 12' }
    })
    send('turn/completed', {
      threadId: 'child-x',
      turn: { id: 'ct', status: 'completed', items: [] }
    })
    await flush()
    const state = timelineOf(h.emitted)
    const rows = subAgentRows(state.timeline)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      toolUseId: 'call_spawn',
      phase: 'completed',
      description: 'Count the files in src.'
    })
    const texts = (state.childIndex.get('call_spawn') ?? []).flatMap((i) => {
      const r = state.timeline[i]
      return r?.kind === 'text' ? [r.text] : []
    })
    expect(texts).toEqual(['early', 'done: 12'])
    expect(state.timeline.some((r) => r?.kind === 'tool' && r.invocation.id === 'call_spawn')).toBe(
      false
    )
    expect(h.emitted.filter((e) => e.kind === 'result')).toHaveLength(0)
  })

  test("a sub-agent's own sub-agent nests under its parent row", async () => {
    const h = await started()
    const send = (method: string, params: Record<string, unknown>): void =>
      h.driver.handleLine(JSON.stringify({ jsonrpc: '2.0', method, params }))
    const activity = (id: string, agentThreadId: string, agentPath: string) => ({
      type: 'subAgentActivity',
      id,
      kind: 'started',
      agentThreadId,
      agentPath,
      model: null,
      reasoningEffort: null
    })
    send('item/started', {
      threadId: MAIN,
      turnId: 't1',
      item: activity('a1', 'c1', '/root/scout')
    })
    send('item/started', {
      threadId: 'c1',
      turnId: 'ct1',
      item: activity('a2', 'c2', '/root/scout/helper')
    })
    send('item/completed', {
      threadId: 'c2',
      turnId: 'ct2',
      item: { type: 'agentMessage', id: 'deep', text: 'deep reply' }
    })
    await flush()
    const state = timelineOf(h.emitted)
    const rows = subAgentRows(state.timeline)
    expect(rows.map((r) => [r.toolUseId, r.description, r.parentToolUseId])).toEqual([
      ['a1', 'scout', undefined],
      ['a2', 'helper', 'a1']
    ])
    const deep = state.timeline.find((r) => r?.kind === 'text' && r.text === 'deep reply')
    expect(deep?.parentToolUseId).toBe('a2')
  })

  test('notifications of a thread nobody spawned never reach the parent timeline', async () => {
    const h = await started()
    h.driver.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'stranger', turn: { id: 'x', status: 'completed', items: [] } }
      })
    )
    h.driver.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { threadId: 'stranger', turnId: 'x', itemId: 'm', delta: 'hi' }
      })
    )
    await flush()
    expect(h.emitted.filter((e) => e.kind === 'result' || e.kind.startsWith('stream-'))).toEqual([])
  })
})
