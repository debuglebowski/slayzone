import { expect, test } from 'vitest'
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
