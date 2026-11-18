import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { ClaudeTurnAttribution } from './claude-turn-attribution'
import { claudeCodeAdapter } from './claude-code-adapter'

const result = (uuid: string, result_index?: number, parent_tool_use_id?: string): AgentEvent =>
  claudeCodeAdapter.parseLine(
    JSON.stringify({
      type: 'result',
      uuid,
      result_index,
      parent_tool_use_id,
      subtype: 'success',
      is_error: false
    })
  )!

test('child result indices cannot poison the main execution duplicate fence', () => {
  const s = new ClaudeTurnAttribution(() => {})
  s.begin('A')
  s.attribute(result('child-result', 100, 'helper'))
  expect(s.attribute(result('main-result', 1))?.execution?.turnId).toBe('A')
})

test('native delivery acknowledgements retain their own message correlation', () => {
  const s = new ClaudeTurnAttribution(() => {})
  s.begin('B')
  expect(
    s.attribute({ kind: 'command-lifecycle', commandUuid: 'A', state: 'completed' })?.execution
  ).toBeUndefined()
  s.attribute({ kind: 'command-lifecycle', commandUuid: 'B', state: 'cancelled' })
  expect(
    s.attribute({ kind: 'assistant-text', messageId: 'autonomous', text: 'autonomous' })?.execution
      ?.turnId
  ).not.toBe('B')
})

test('background job final output keeps its original request after a newer request starts', () => {
  const s = new ClaudeTurnAttribution(() => {})
  s.begin('A')
  s.attribute({
    kind: 'command-task',
    taskId: 'job',
    toolUseId: 'job-tool',
    status: 'running',
    backgrounded: true
  })
  s.attribute(result('result-A'))
  s.begin('B')
  s.attribute({
    kind: 'command-task',
    taskId: 'job',
    toolUseId: 'job-tool',
    status: 'completed',
    backgrounded: true
  })
  expect(
    s.attribute({
      kind: 'command-task-output',
      taskId: 'job',
      toolUseId: 'job-tool',
      output: 'finished',
      totalBytes: 8,
      truncated: false
    })?.execution?.turnId
  ).toBe('A')
})

test('new host writes replace abandoned ownership while steering keeps the original execution', () => {
  const s = new ClaudeTurnAttribution(() => {})
  const output = (): AgentEvent => ({
    kind: 'assistant-text',
    messageId: 'response',
    text: 'response'
  })
  s.begin('A')
  s.begin('steer-A', true)
  expect(s.attribute(output())?.execution?.turnId).toBe('A')
  s.begin('B') // A write failed or was cancelled without a provider result.
  expect(s.attribute(output())?.execution?.turnId).toBe('B')
})

test('helper progress and approvals retain child ownership across root requests', () => {
  const s = new ClaudeTurnAttribution(() => {})
  s.begin('A')
  s.attribute({
    kind: 'sub-agent',
    toolUseId: 'helper',
    phase: 'in-flight',
    backgrounded: true,
    raw: null
  })
  s.attribute({
    kind: 'tool-call',
    id: 'child-tool',
    name: 'Bash',
    input: {},
    parentToolUseId: 'helper'
  })
  s.attribute(result('result-A'))
  s.begin('B')
  expect(
    s.attribute({
      kind: 'permission-request',
      requestId: 'approval',
      toolUseId: 'child-tool',
      toolName: 'Bash',
      input: {}
    })
  ).toMatchObject({ execution: { turnId: 'A' }, parentToolUseId: 'helper' })
  expect(
    s.attribute({
      kind: 'sub-agent',
      toolUseId: 'helper',
      phase: 'completed',
      backgrounded: true,
      raw: null
    })?.parentToolUseId
  ).toBeUndefined()
})

test.each([false, true])(
  'only background helper ownership outlives root completion (background %s)',
  (backgrounded) => {
    const s = new ClaudeTurnAttribution(() => {})
    s.begin('A')
    s.attribute({
      kind: 'sub-agent',
      toolUseId: 'helper',
      phase: 'in-flight',
      ...(backgrounded ? { backgrounded: true as const } : {}),
      raw: null
    })
    s.attribute(result('result-A'))
    s.begin('B')
    expect(
      s.attribute({
        kind: 'assistant-text',
        messageId: 'late-child',
        text: 'child',
        parentToolUseId: 'helper'
      })?.execution?.turnId
    ).toBe(backgrounded ? 'A' : undefined)
  }
)

// Orderings measured on Claude Code 2.1.326: `command_lifecycle started` precedes
// every output of its message; a turn's result precedes the next message's
// `started`; a message taken mid-turn (steering) starts inside the running turn.
describe('command_lifecycle boundaries', () => {
  const lifecycle = (
    commandUuid: string,
    state: 'queued' | 'started' | 'completed' | 'cancelled'
  ): AgentEvent => ({
    kind: 'command-lifecycle',
    commandUuid,
    state
  })
  const text = (t: string): AgentEvent => ({ kind: 'assistant-text', messageId: t, text: t })
  const owner = (s: ClaudeTurnAttribution, e: AgentEvent) => s.attribute(e)?.execution

  test('a stopped request keeps its late output after the next write', () => {
    const starts: AgentEvent[] = []
    const s = new ClaudeTurnAttribution((e) => starts.push(e))
    s.begin('A')
    s.attribute(lifecycle('A', 'queued'))
    s.attribute(lifecycle('A', 'started'))
    expect(owner(s, text('a1'))?.messageId).toBe('A')
    s.begin('B') // written after Stop, before A's aborted result arrived
    s.attribute(lifecycle('B', 'queued'))
    expect(owner(s, text('a-late'))?.messageId).toBe('A')
    expect(owner(s, result('result-A', 0))?.messageId).toBe('A')
    s.attribute(lifecycle('A', 'cancelled'))
    // B has not started: no turn of its own before its `started`.
    expect(
      starts.filter((e) => e.kind === 'turn-started' && e.execution.messageId === 'B')
    ).toHaveLength(0)
    s.attribute(lifecycle('B', 'started'))
    expect(starts.at(-1)).toMatchObject({
      kind: 'turn-started',
      execution: { turnId: 'B', messageId: 'B', source: 'lifecycle' }
    })
    expect(owner(s, text('b1'))).toMatchObject({ turnId: 'B', messageId: 'B', source: 'lifecycle' })
    expect(owner(s, result('result-B', 1))?.messageId).toBe('B')
  })

  test('a self-started turn before the written message starts owns its output', () => {
    const s = new ClaudeTurnAttribution(() => {})
    s.begin('A')
    s.attribute(lifecycle('A', 'started'))
    s.attribute(result('result-A', 0))
    s.attribute(lifecycle('A', 'completed'))
    s.begin('B')
    s.attribute(lifecycle('B', 'queued'))
    const self = owner(s, text('task finished'))
    expect(self?.messageId).toBeUndefined()
    expect(self?.turnId).not.toBe('B')
    expect(owner(s, result('result-self', 1))?.turnId).toBe(self?.turnId)
    s.attribute(lifecycle('B', 'started'))
    expect(owner(s, text('b1'))).toMatchObject({ turnId: 'B', messageId: 'B' })
  })

  test('a steered message started mid-turn joins the running execution', () => {
    const s = new ClaudeTurnAttribution(() => {})
    s.begin('A')
    s.attribute(lifecycle('A', 'started'))
    s.begin('S', true)
    s.attribute(lifecycle('S', 'queued'))
    s.attribute(lifecycle('S', 'started'))
    expect(owner(s, text('after steer'))?.messageId).toBe('A')
    s.attribute(lifecycle('S', 'completed')) // before the turn's result
    expect(owner(s, result('result-A', 0))?.messageId).toBe('A')
    s.attribute(lifecycle('A', 'completed'))
  })

  test('a steer the CLI starts after the turn ended gets its own execution', () => {
    const s = new ClaudeTurnAttribution(() => {})
    s.begin('A')
    s.attribute(lifecycle('A', 'started'))
    s.begin('S', true) // the turn's result was already on its way
    s.attribute(result('result-A', 0))
    s.attribute(lifecycle('A', 'completed'))
    s.attribute(lifecycle('S', 'started'))
    expect(owner(s, text('s1'))).toMatchObject({ turnId: 'S', messageId: 'S' })
  })
})

test('a message written while a self-started turn runs (no lifecycle seen yet) starts after that turn', () => {
  const starts: AgentEvent[] = []
  const s = new ClaudeTurnAttribution((e) => starts.push(e))
  const text = (t: string): AgentEvent => ({ kind: 'assistant-text', messageId: t, text: t })
  const self = s.attribute(text('on my own'))?.execution
  expect(self?.messageId).toBeUndefined()
  s.begin('m1')
  expect(s.attribute(text('still mine'))?.execution?.turnId).toBe(self?.turnId)
  expect(s.attribute(result('self-end', 0))?.execution?.turnId).toBe(self?.turnId)
  s.settle()
  expect(starts.at(-1)).toMatchObject({ kind: 'turn-started', execution: { messageId: 'm1' } })
  expect(s.attribute(text('answer'))?.execution?.messageId).toBe('m1')
})

test('a first write begun before lifecycle was seen is announced as CLI-bounded at its started', () => {
  const starts: AgentEvent[] = []
  const s = new ClaudeTurnAttribution((e) => starts.push(e))
  s.begin('m1')
  expect(starts.at(-1)).toMatchObject({ execution: { turnId: 'm1', source: 'ordered' } })
  s.attribute({ kind: 'command-lifecycle', commandUuid: 'm1', state: 'queued' })
  s.attribute({ kind: 'command-lifecycle', commandUuid: 'm1', state: 'started' })
  expect(starts.at(-1)).toMatchObject({ execution: { turnId: 'm1', source: 'lifecycle' } })
})
