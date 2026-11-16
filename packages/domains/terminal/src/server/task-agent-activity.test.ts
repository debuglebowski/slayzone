import { expect, test } from 'vitest'
import { isMidReplyState, midReplySessionIds } from './task-agent-activity'

test('only `running` is mid-reply; idle, background, starting, exited are not', () => {
  expect(isMidReplyState('running')).toBe(true)
  for (const s of [
    'idle',
    'background',
    'starting',
    'error',
    'dead',
    'hibernated',
    'not-spawned'
  ] as const) {
    expect(isMidReplyState(s), s).toBe(false)
  }
})

test("midReplySessionIds picks the task's running PTYs and chats only", () => {
  expect(
    midReplySessionIds('t1', [
      { sessionId: 't1', taskId: 't1', state: 'running' },
      { sessionId: 't1:chat', taskId: 't1', state: 'running' },
      { sessionId: 't1:pane', taskId: 't1', state: 'idle' },
      { sessionId: 't2', taskId: 't2', state: 'running' }
    ])
  ).toEqual(['t1', 't1:chat'])
})
