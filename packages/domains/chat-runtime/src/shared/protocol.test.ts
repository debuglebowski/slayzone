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
