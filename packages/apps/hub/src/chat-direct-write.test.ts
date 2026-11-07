/**
 * A chat command a client sent straight to the computer (docs/direct-link.md): the
 * hub drains that computer's chat metadata, as after a command it relayed — but only
 * for a notice that matches the tab's current owner and epoch.
 */
import { expect, test } from 'vitest'
import { createChatDirectWriteHandler } from './chat-direct-write'

function setup(
  owner: { computerId: string | null; epoch: number; state: string; id: string } | null
) {
  const drained: string[] = []
  const handle = createChatDirectWriteHandler({
    forTab: async () => (owner ? { ...owner, taskId: 't' } : null),
    drainMetadata: async (computerId) => {
      drained.push(computerId)
    }
  })
  return { handle, drained }
}

const notice = { tabId: 'tab', conversationId: 'conv', epoch: 2, method: 'respondPermission' }

test('drains the owning computer’s metadata', async () => {
  const { handle, drained } = setup({ computerId: 'c1', epoch: 2, state: 'active', id: 'conv' })
  await handle('c1', notice)
  expect(drained).toEqual(['c1'])
})

test('ignores a notice from another computer, a stale epoch, an inactive or unknown tab, or a malformed one', async () => {
  for (const [owner, from, payload] of [
    [{ computerId: 'c2', epoch: 2, state: 'active', id: 'conv' }, 'c1', notice],
    [{ computerId: 'c1', epoch: 3, state: 'active', id: 'conv' }, 'c1', notice],
    [{ computerId: 'c1', epoch: 2, state: 'copying', id: 'conv' }, 'c1', notice],
    [{ computerId: 'c1', epoch: 2, state: 'active', id: 'other' }, 'c1', notice],
    [null, 'c1', notice],
    [{ computerId: 'c1', epoch: 2, state: 'active', id: 'conv' }, 'c1', { tabId: 5 }]
  ] as const) {
    const { handle, drained } = setup(owner)
    await handle(from, payload)
    expect(drained).toEqual([])
  }
})
