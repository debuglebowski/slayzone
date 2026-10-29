/**
 * Live vs saved: streaming fragments go to the screen only; each finished block
 * is saved exactly once — the provider's own consolidated event when it sends one
 * (Claude), else one the splitter builds from the fragments (Codex).
 */
import { expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { ChatEventSplitter } from './chat-event-splitter'

const start = (messageId: string): AgentEvent => ({ kind: 'stream-message-start', messageId })
const blockStart = (
  blockIndex: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  extra: Partial<{ toolUseId: string; toolName: string }> = {}
): AgentEvent => ({ kind: 'stream-block-start', blockIndex, blockType, ...extra })
const delta = (
  blockIndex: number,
  text: string,
  deltaType: 'text' | 'thinking' | 'signature' | 'input_json' = 'text'
): AgentEvent => ({ kind: 'stream-block-delta', blockIndex, deltaType, text })
const blockStop = (blockIndex: number): AgentEvent => ({ kind: 'stream-block-stop', blockIndex })
const stop: AgentEvent = { kind: 'stream-message-stop' }

function run(splitter: ChatEventSplitter, events: AgentEvent[]) {
  const live: AgentEvent[] = []
  const saved: AgentEvent[] = []
  for (const e of events) {
    const r = splitter.route(e)
    live.push(...r.live)
    saved.push(...r.saved)
  }
  return { live, saved }
}

test('a Codex-style stream (no consolidated event) is saved as ONE assistant-text', () => {
  const s = new ChatEventSplitter()
  const { live, saved } = run(s, [
    start('item-1'),
    blockStart(0, 'text'),
    delta(0, 'Hel'),
    delta(0, 'lo '),
    delta(0, 'world'),
    blockStop(0),
    stop
  ])
  expect(live.map((e) => e.kind)).toEqual([
    'stream-message-start',
    'stream-block-start',
    'stream-block-delta',
    'stream-block-delta',
    'stream-block-delta',
    'stream-block-stop',
    'stream-message-stop'
  ])
  expect(saved).toEqual([{ kind: 'assistant-text', messageId: 'item-1', text: 'Hello world' }])
})

test('thinking fragments become one saved assistant-thinking', () => {
  const s = new ChatEventSplitter()
  const { saved } = run(s, [
    start('m'),
    blockStart(0, 'thinking'),
    delta(0, 'hmm '),
    delta(0, 'ok'),
    delta(0, 'sig', 'signature'),
    blockStop(0),
    stop
  ])
  expect(saved).toEqual([
    { kind: 'assistant-thinking', messageId: 'm', text: 'hmm ok', hasSignature: true }
  ])
})

test('a Claude-style block whose consolidated event arrives before its stop is saved once', () => {
  const s = new ChatEventSplitter()
  const consolidated: AgentEvent = { kind: 'assistant-text', messageId: 'msg_1', text: 'Hi there' }
  const { saved } = run(s, [
    start('msg_1'),
    blockStart(0, 'text'),
    delta(0, 'Hi '),
    delta(0, 'there'),
    consolidated,
    blockStop(0),
    stop
  ])
  expect(saved).toEqual([consolidated])
})

test('a streamed tool_use block is saved as the provider’s tool-call, nothing synthesized', () => {
  const s = new ChatEventSplitter()
  const call: AgentEvent = {
    kind: 'tool-call',
    id: 'toolu_1',
    name: 'Bash',
    input: { command: 'ls' }
  }
  const { saved } = run(s, [
    start('msg_2'),
    blockStart(0, 'tool_use', { toolUseId: 'toolu_1', toolName: 'Bash' }),
    delta(0, '{"command":', 'input_json'),
    call,
    blockStop(0),
    stop
  ])
  expect(saved).toEqual([call])
})

test('a turn that ends mid-block saves the partial text before the terminator', () => {
  const s = new ChatEventSplitter()
  const { saved } = run(s, [
    start('item-2'),
    blockStart(0, 'text'),
    delta(0, 'half a sen'),
    { kind: 'interrupted' }
  ])
  expect(saved).toEqual([
    { kind: 'assistant-text', messageId: 'item-2', text: 'half a sen' },
    { kind: 'interrupted' }
  ])
  // Closed: nothing is saved twice.
  expect(run(s, [blockStop(0), stop]).saved).toEqual([])
})

test('closeOpen() saves what an abrupt process end left open', () => {
  const s = new ChatEventSplitter()
  run(s, [start('item-3'), blockStart(0, 'text'), delta(0, 'last words')])
  expect(s.closeOpen()).toEqual([
    { kind: 'assistant-text', messageId: 'item-3', text: 'last words' }
  ])
  expect(s.closeOpen()).toEqual([])
})

test('snapshot() rebuilds the open blocks for a reload mid-stream', () => {
  const s = new ChatEventSplitter()
  run(s, [start('item-4'), blockStart(0, 'text'), delta(0, 'so '), delta(0, 'far')])
  expect(s.snapshot()).toEqual([
    { kind: 'stream-message-start', messageId: 'item-4' },
    { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
    { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'so far' }
  ])
  run(s, [blockStop(0), stop])
  expect(s.snapshot()).toEqual([])
})

test('a new message start closes a message that never stopped', () => {
  const s = new ChatEventSplitter()
  const { saved } = run(s, [
    start('a'),
    blockStart(0, 'text'),
    delta(0, 'orphan'),
    start('b'),
    blockStart(0, 'text'),
    delta(0, 'next'),
    blockStop(0),
    stop
  ])
  expect(saved).toEqual([
    { kind: 'assistant-text', messageId: 'a', text: 'orphan' },
    { kind: 'assistant-text', messageId: 'b', text: 'next' }
  ])
})

test('everything that is not a fragment is saved unchanged and in order', () => {
  const s = new ChatEventSplitter()
  const events: AgentEvent[] = [
    { kind: 'user-message', text: 'hi' },
    { kind: 'tool-result', toolUseId: 't', isError: false, rawContent: 'x', structured: null },
    { kind: 'stderr', text: 'warn' }
  ]
  expect(run(s, events)).toEqual({ live: [], saved: events })
})

test('sub-agent fragments keep their parent', () => {
  const s = new ChatEventSplitter()
  const { saved } = run(s, [
    { kind: 'stream-message-start', messageId: 'm', parentToolUseId: 'task_1' },
    { kind: 'stream-block-start', blockIndex: 0, blockType: 'text', parentToolUseId: 'task_1' },
    {
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'text',
      text: 'x',
      parentToolUseId: 'task_1'
    },
    { kind: 'stream-block-stop', blockIndex: 0, parentToolUseId: 'task_1' }
  ])
  expect(saved).toEqual([
    { kind: 'assistant-text', messageId: 'm', text: 'x', parentToolUseId: 'task_1' }
  ])
})
