import { expect, test } from 'vitest'
import { parseChatInvocation } from './protocol'
const route = { id: 'conversation', epoch: 1 }
test('computer invocation rejects unknown methods and malformed message content', () => {
  expect(() =>
    parseChatInvocation({ route, target: 'ops', method: 'constructor', args: [] })
  ).toThrow()
  expect(() =>
    parseChatInvocation({
      route,
      target: 'ops',
      method: 'send',
      args: [
        'tab',
        { id: 'message', content: [{ type: 'attachment', attachment: { artifactId: 'file' } }] }
      ]
    })
  ).toThrow()
  expect(() =>
    parseChatInvocation({
      route: { ...route, epoch: 0 },
      target: 'ops',
      method: 'kill',
      args: ['tab']
    })
  ).toThrow()
})
test('computer invocation accepts shared message and queue shapes', () => {
  const send = {
    route,
    target: 'ops',
    method: 'send',
    operationId: 'send-1',
    args: ['tab', { id: 'message', content: [{ type: 'text', text: 'hello' }] }]
  }
  expect(parseChatInvocation(send)).toEqual(send)
  expect(
    parseChatInvocation({
      route,
      target: 'queue',
      method: 'hold',
      operationId: 'hold-1',
      args: ['item']
    })
  ).toMatchObject({ method: 'hold' })
})

test('new main operations cross the computer boundary with their full input', () => {
  expect(
    parseChatInvocation({ route, target: 'ops', method: 'getInfo', args: ['tab', 'codex-chat'] })
  ).toMatchObject({ args: ['tab', 'codex-chat'] })
  expect(
    parseChatInvocation({
      route,
      target: 'ops',
      method: 'askSideQuestion',
      operationId: 'btw-1',
      args: [
        {
          tabId: 'tab',
          taskId: 'task',
          mode: 'claude-chat',
          cwd: '/tmp',
          requestId: 'q',
          question: 'why?',
          history: []
        }
      ]
    })
  ).toMatchObject({ method: 'askSideQuestion' })
  expect(
    parseChatInvocation({
      route,
      target: 'ops',
      method: 'cancelSideQuestion',
      operationId: 'cancel-1',
      args: [{ tabId: 'tab', requestId: 'q' }]
    })
  ).toMatchObject({ method: 'cancelSideQuestion' })
})

test('getTurnStatus is a tab-keyed read that crosses the computer boundary', async () => {
  const { CHAT_READ_OPERATIONS } = await import('./protocol')
  expect(
    parseChatInvocation({ route, target: 'ops', method: 'getTurnStatus', args: ['tab'] })
  ).toMatchObject({ method: 'getTurnStatus', args: ['tab'] })
  expect(() =>
    parseChatInvocation({ route, target: 'ops', method: 'getTurnStatus', args: [] })
  ).toThrow()
  expect(CHAT_READ_OPERATIONS.has('getTurnStatus')).toBe(true)
})
