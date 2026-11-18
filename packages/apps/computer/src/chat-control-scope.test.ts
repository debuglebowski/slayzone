import { expect, test } from 'vitest'
import { ComputerTransportErrorCodes } from '@slayzone/computer-transport/shared'
import { assertChatControlScope, isChatControlRequest } from './chat-control-scope'

const identity = { id: 'c', taskId: 'task-b', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const prepare = {
  kind: 'control.prepare',
  token: '00000000-0000-4000-8000-000000000001',
  identity,
  value: {}
}
const control = { kind: 'control', identity, spawnId: 'spawn', action: 'interrupt' }
const actor = (pathScope?: unknown) =>
  ({ userId: null, route: 'test', ...(pathScope ? { pathScope } : {}) }) as never

test('only the four control kinds are controls', () => {
  for (const kind of ['control', 'control.prepare', 'control.renew', 'control.cancel'])
    expect(isChatControlRequest({ kind })).toBe(true)
  for (const params of [{ kind: 'invoke' }, { kind: 'bootstrap' }, null, undefined])
    expect(isChatControlRequest(params)).toBe(false)
})

test.each([prepare, control])('a control scoped to its own task passes (%#)', (params) => {
  expect(() =>
    assertChatControlScope(actor({ kind: 'task', taskId: 'task-b', projectId: null }), params)
  ).not.toThrow()
})

test.each([
  ['no scope', undefined],
  ['another task', { kind: 'task', taskId: 'task-a', projectId: null }],
  ['a project', { kind: 'project', projectId: 'p' }]
])('a control with %s is refused by the computer', (_name, scope) => {
  for (const params of [prepare, control]) {
    let error: unknown
    try {
      assertChatControlScope(actor(scope), params)
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({
      code: ComputerTransportErrorCodes.refusedByComputer,
      message: 'Chat control task scope mismatch'
    })
  }
})
