/**
 * chat-timeline reducer — token streaming (plan 3.2) and command tasks (3.9).
 *
 * Streaming contract: a delta only touches `state.live` (never `timeline`), so a
 * delta re-renders the one row that reads it; the provider's saved block event
 * finalizes that same row in place (same index, same key); a reload's snapshot
 * and a cold replay produce the same rows.
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  initialState,
  reducer,
  liveBlockOf,
  streamKeyOf,
  type ChatTimelineState,
  type TimelineItem
} from './chat-timeline'

/** A test state holds every row: its timeline as plain items. */
const rowsOf = (s: { timeline: ReadonlyArray<TimelineItem | undefined> }): TimelineItem[] =>
  s.timeline as TimelineItem[]

const apply = (s: ChatTimelineState, ...events: AgentEvent[]): ChatTimelineState =>
  events.reduce((acc, event) => reducer(acc, { type: 'event', event }), s)

const begin = (): ChatTimelineState =>
  apply(
    initialState(),
    {
      kind: 'turn-init',
      sessionId: 's',
      model: 'haiku',
      cwd: '/tmp',
      tools: []
    },
    { kind: 'user-message', text: 'go' }
  )

const msgStart = (messageId: string): AgentEvent => ({ kind: 'stream-message-start', messageId })
const blockStart = (
  blockIndex: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  tool?: { id: string; name: string }
): AgentEvent => ({
  kind: 'stream-block-start',
  blockIndex,
  blockType,
  ...(tool ? { toolUseId: tool.id, toolName: tool.name } : {})
})
const delta = (
  blockIndex: number,
  text: string,
  deltaType: 'text' | 'thinking' | 'signature' | 'input_json' = 'text'
): AgentEvent => ({ kind: 'stream-block-delta', blockIndex, deltaType, text })
const blockStop = (blockIndex: number): AgentEvent => ({ kind: 'stream-block-stop', blockIndex })
const msgStop: AgentEvent = { kind: 'stream-message-stop' }
const savedText = (messageId: string, text: string): AgentEvent => ({
  kind: 'assistant-text',
  messageId,
  text
})
const savedThinking = (messageId: string, text: string): AgentEvent => ({
  kind: 'assistant-thinking',
  messageId,
  text,
  hasSignature: true
})
const result: AgentEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  durationApiMs: 1,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: 'end_turn',
  terminalReason: null,
  text: 'ok',
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
}

const rows = (s: ChatTimelineState, kind: TimelineItem['kind']) =>
  rowsOf(s).filter((i) => i.kind === kind)

describe('streaming: deltas are live state, not timeline', () => {
  test('a text delta updates state.live only; the timeline keeps its identity', () => {
    let s = apply(begin(), msgStart('m1'), blockStart(0, 'text'), delta(0, 'Hel'))
    const timeline = rowsOf(s)
    const [row] = rows(s, 'text')
    expect(row).toMatchObject({ kind: 'text', messageId: 'm1', blockOrdinal: 0, stream: 'open' })
    const key = streamKeyOf(row)
    expect(key).toBe('text:m1:0')
    expect(liveBlockOf(s.live, key!)).toEqual({ key: 'text:m1:0', text: 'Hel', json: '' })

    s = apply(s, delta(0, 'lo'), delta(0, ' world'))
    expect(rowsOf(s)).toBe(timeline)
    expect(liveBlockOf(s.live, key!)?.text).toBe('Hello world')
  })

  test('the saved block finalizes the streamed row in place (Claude: before the stop)', () => {
    let s = apply(begin(), msgStart('m1'), blockStart(0, 'text'), delta(0, 'Hello'))
    const at = rowsOf(s).findIndex((i) => i.kind === 'text')
    s = apply(s, savedText('m1', 'Hello world'))
    expect(rowsOf(s)[at]).toMatchObject({ kind: 'text', text: 'Hello world', blockOrdinal: 0 })
    expect((rowsOf(s)[at] as { stream?: string }).stream).toBeUndefined()
    expect(liveBlockOf(s.live, 'text:m1:0')).toBeUndefined()
    s = apply(s, blockStop(0), msgStop)
    expect(rows(s, 'text')).toHaveLength(1)
    expect(rowsOf(s)[at]).toMatchObject({ text: 'Hello world' })
  })

  test('two text blocks of one message get their own rows and keys (live = replay)', () => {
    const live = apply(
      begin(),
      msgStart('m1'),
      blockStart(0, 'text'),
      delta(0, 'one'),
      savedText('m1', 'one'),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, 'two'),
      savedText('m1', 'two'),
      blockStop(1),
      msgStop
    )
    const replay = apply(begin(), savedText('m1', 'one'), savedText('m1', 'two'))
    const keys = (s: ChatTimelineState) => rows(s, 'text').map((r) => streamKeyOf(r))
    expect(keys(live)).toEqual(['text:m1:0', 'text:m1:1'])
    expect(keys(replay)).toEqual(keys(live))
    expect(rows(live, 'text').map((r) => (r as { text: string }).text)).toEqual(['one', 'two'])
  })

  test('Codex: the stop commits the live text; the built saved event then finalizes (no duplicate)', () => {
    let s = apply(
      begin(),
      msgStart('item-1'),
      blockStart(0, 'text'),
      delta(0, 'Hel'),
      delta(0, 'lo')
    )
    s = apply(s, blockStop(0))
    const [row] = rows(s, 'text')
    expect(row).toMatchObject({ text: 'Hello', stream: 'closed' })
    s = apply(s, savedText('item-1', 'Hello'), msgStop)
    expect(liveBlockOf(s.live, 'text:item-1:0')).toBeUndefined()
    expect(rows(s, 'text')).toHaveLength(1)
    expect((rows(s, 'text')[0] as { stream?: string }).stream).toBeUndefined()
  })

  test('an empty text block leaves no row; a saved event without deltas appends one', () => {
    let s = apply(begin(), msgStart('m1'), blockStart(0, 'text'), blockStop(0), msgStop)
    expect(rows(s, 'text')).toHaveLength(0)
    s = apply(s, savedText('m1', 'atomic'))
    expect(rows(s, 'text')).toMatchObject([{ text: 'atomic', blockOrdinal: 0 }])
  })

  test('thinking: a row from the block start (timer), live text, signature, finalized in place', () => {
    let s = apply(begin(), msgStart('m1'), blockStart(0, 'thinking'))
    const [row] = rows(s, 'thinking')
    expect(row).toMatchObject({ text: '', stream: 'open', blockOrdinal: 0 })
    s = apply(s, delta(0, 'I should '), delta(0, 'look.'), delta(0, 'sig', 'signature'))
    expect(liveBlockOf(s.live, 'thinking:m1:0')?.text).toBe('I should look.')
    expect(rows(s, 'thinking')[0]).toMatchObject({ hasSignature: true })
    s = apply(s, savedThinking('m1', 'I should look.'), blockStop(0))
    expect(rows(s, 'thinking')).toHaveLength(1)
    expect(rows(s, 'thinking')[0]).toMatchObject({ text: 'I should look.' })
    expect((rows(s, 'thinking')[0] as { stream?: string }).stream).toBeUndefined()
  })

  test('tool input streams into live json; the saved call sets the input', () => {
    let s = apply(
      begin(),
      msgStart('m1'),
      blockStart(0, 'tool_use', { id: 'toolu_1', name: 'Bash' }),
      delta(0, '{"command": "npm ', 'input_json')
    )
    const timeline = rowsOf(s)
    s = apply(s, delta(0, 'run build"}', 'input_json'))
    expect(rowsOf(s)).toBe(timeline)
    const [tool] = rows(s, 'tool')
    expect(tool).toMatchObject({ inputStreaming: true, invocation: { id: 'toolu_1', input: null } })
    expect(streamKeyOf(tool)).toBe('tool:toolu_1')
    expect(liveBlockOf(s.live, 'tool:toolu_1')?.json).toBe('{"command": "npm run build"}')
    s = apply(s, {
      kind: 'tool-call',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'npm run build' }
    })
    expect(rows(s, 'tool')[0]).toMatchObject({
      invocation: { input: { command: 'npm run build' } }
    })
    expect((rows(s, 'tool')[0] as { inputStreaming?: boolean }).inputStreaming).toBeUndefined()
    expect(liveBlockOf(s.live, 'tool:toolu_1')).toBeUndefined()
  })

  test('a tool block stopped without a saved call: its json is parsed (fallback)', () => {
    const s = apply(
      begin(),
      msgStart('m1'),
      blockStart(0, 'tool_use', { id: 'toolu_1', name: 'Read' }),
      delta(0, '{"file_path":"/a"}', 'input_json'),
      blockStop(0)
    )
    expect(rows(s, 'tool')[0]).toMatchObject({ invocation: { input: { file_path: '/a' } } })
    expect(s.live).toHaveLength(0)
  })

  for (const end of [
    ['result', result],
    ['interrupted', { kind: 'interrupted' }],
    ['process-exit', { kind: 'process-exit', code: null, signal: 'SIGKILL' }]
  ] as const) {
    test(`a turn end (${end[0]}) commits open rows with their live text`, () => {
      let s = apply(begin(), msgStart('m1'), blockStart(0, 'text'), delta(0, 'half a'))
      s = apply(s, end[1] as AgentEvent)
      expect(rows(s, 'text')).toMatchObject([{ text: 'half a' }])
      expect((rows(s, 'text')[0] as { stream?: string }).stream).toBeUndefined()
      expect(s.live).toHaveLength(0)
    })
  }

  test('a reload snapshot (start + one whole delta) rebuilds the same row, then deltas continue', () => {
    let s = apply(begin(), msgStart('m1'), blockStart(0, 'text'), delta(0, 'Before the reload, '))
    s = apply(s, delta(0, 'after.'))
    expect(liveBlockOf(s.live, 'text:m1:0')?.text).toBe('Before the reload, after.')
    expect(rows(s, 'text')).toHaveLength(1)
  })

  test('the batch action equals applying its events one by one', () => {
    const events: AgentEvent[] = [
      msgStart('m1'),
      blockStart(0, 'thinking'),
      delta(0, 'hmm'),
      blockStart(1, 'text'),
      delta(1, 'a'),
      delta(1, 'b'),
      savedText('m1', 'ab'),
      blockStop(1),
      msgStop
    ]
    const one = apply(begin(), ...events)
    const batch = reducer(begin(), { type: 'events', events })
    expect(rowsOf(batch).map(({ timestamp: _t, ...rest }) => rest)).toEqual(
      rowsOf(one).map(({ timestamp: _t, ...rest }) => rest)
    )
    expect(batch.live).toEqual(one.live)
  })
})

describe('command tasks', () => {
  const bash = (id: string, input: Record<string, unknown>): AgentEvent => ({
    kind: 'tool-call',
    id,
    name: 'Bash',
    input
  })
  const task = (over: Partial<Extract<AgentEvent, { kind: 'command-task' }>> = {}): AgentEvent => ({
    kind: 'command-task',
    taskId: 't1',
    toolUseId: 'toolu_1',
    status: 'running',
    backgrounded: false,
    description: 'Ticks',
    startedAt: 1_000,
    ...over
  })
  const invocation = (s: ChatTimelineState) =>
    (rows(s, 'tool')[0] as Extract<TimelineItem, { kind: 'tool' }>).invocation

  test('a command task attaches to its tool call; each event is the full snapshot', () => {
    let s = apply(begin(), bash('toolu_1', { command: 'ticks' }), task())
    expect(invocation(s).task).toEqual({
      taskId: 't1',
      status: 'running',
      backgrounded: false,
      description: 'Ticks',
      startedAt: 1_000
    })
    s = apply(s, task({ status: 'completed', endedAt: 5_000 }))
    expect(invocation(s).task).toMatchObject({ status: 'completed', endedAt: 5_000 })
    // A command task is never a sub-agent row.
    expect(rows(s, 'sub-agent')).toHaveLength(0)
  })

  test('a task reported before its tool row exists is applied when the row comes', () => {
    const s = apply(begin(), task(), bash('toolu_1', { command: 'ticks' }))
    expect(invocation(s).task).toMatchObject({ taskId: 't1', status: 'running' })
  })

  test('the saved final output of a background command reaches its card and the banner', () => {
    let s = apply(
      begin(),
      bash('toolu_1', { command: 'loop', run_in_background: true }),
      {
        kind: 'tool-result',
        toolUseId: 'toolu_1',
        isError: false,
        rawContent: 'Command running in background with ID: t1. Output is being written to: /x',
        structured: null
      },
      task({ backgrounded: true })
    )
    expect(s.bgShells.get('toolu_1')).toMatchObject({ shellId: 't1', status: 'running' })
    s = apply(s, task({ backgrounded: true, status: 'completed', endedAt: 9 }), {
      kind: 'command-task-output',
      taskId: 't1',
      toolUseId: 'toolu_1',
      output: 'tick 1\n\n[exited with code 0]\n',
      totalBytes: 29,
      truncated: false
    })
    expect(invocation(s).task?.finalOutput).toEqual({
      output: 'tick 1\n\n[exited with code 0]\n',
      totalBytes: 29,
      truncated: false
    })
    expect(s.bgShells.get('toolu_1')).toMatchObject({
      status: 'completed',
      latestStdout: 'tick 1\n\n[exited with code 0]\n'
    })
  })

  test('a foreground command moved to the background joins the banner; killed → Killed', () => {
    let s = apply(begin(), bash('toolu_1', { command: 'slow', description: 'Slow' }), task())
    expect(s.bgShells.size).toBe(0)
    s = apply(s, task({ backgrounded: true }))
    expect(s.bgShells.get('toolu_1')).toMatchObject({
      shellId: 't1',
      status: 'running',
      command: 'slow'
    })
    s = apply(s, task({ backgrounded: true, status: 'killed', endedAt: 3 }))
    expect(s.bgShells.get('toolu_1')).toMatchObject({ status: 'killed' })
  })

  test('the 2.1.312 spawn result names the background task id', () => {
    const s = apply(begin(), bash('toolu_1', { command: 'loop', run_in_background: true }), {
      kind: 'tool-result',
      toolUseId: 'toolu_1',
      isError: false,
      rawContent:
        'Command running in background with ID: byuzqci1i. Output is being written to: /x',
      structured: null
    })
    expect(s.bgShells.get('toolu_1')).toMatchObject({ shellId: 'byuzqci1i', status: 'running' })
  })

  test('the process ending kills its running commands', () => {
    let s = apply(begin(), bash('toolu_1', { command: 'ticks' }), task())
    s = apply(s, { kind: 'process-exit', code: null, signal: 'SIGKILL' })
    expect(invocation(s).task).toMatchObject({ status: 'killed' })
    let r = apply(begin(), bash('toolu_1', { command: 'ticks' }), task())
    r = apply(r, { kind: 'session-spawn', spawnId: 'next' })
    expect(invocation(r).task).toMatchObject({ status: 'killed' })
  })

  test('a sub-agent event without a tool id (old saved rows) makes no row', () => {
    const s = apply(begin(), {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: '',
      raw: {}
    })
    expect(rows(s, 'sub-agent')).toHaveLength(0)
  })
})
