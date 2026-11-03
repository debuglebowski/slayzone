import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import type { ChatTabTransition } from '../shared'

test('review: a delayed committed transition cannot quiesce the replacement provider on its reused tab', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'review-transition-replay-'))
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'review',
    computerId: 'pc',
    transport: {
      whichBinary: async () => '/fake/never-spawned',
      spawn: () => {
        throw new Error('No provider may start in this test')
      }
    }
  })
  const from = { id: 'old', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  const value: ChatTabTransition = {
    id: randomUUID(),
    from,
    to: { ...from, tabId: 'archived', epoch: 2 },
    next: { ...from, id: 'selected', mode: 'codex-chat' }
  }
  const bootstrap = (identity: typeof from) =>
    r.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  try {
    bootstrap(from)
    await r.ops.hydrate({ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: dir })
    await r.transitionTab(value)
    bootstrap(value.next)
    await r.ops.hydrate({ taskId: 'task', tabId: 'tab', mode: 'codex-chat', cwd: dir })
    const selected = r.transport.getSessionInfo('tab')
    expect(selected).not.toBeNull()
    await r.transitionTab(value)
    expect(r.transport.getSessionInfo('tab')).toEqual(selected)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'review: stable submission identity survives provider rebinding, handedOff=%s deletedArchive=%s',
  async (handedOff, deletedArchive) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'review-transition-queue-'))
    const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'review', computerId: 'pc' })
    const from = { id: 'old', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
    const value: ChatTabTransition = {
      id: randomUUID(),
      from,
      to: { ...from, tabId: 'archived', epoch: 2 },
      next: { ...from, id: 'selected', mode: 'codex-chat' }
    }
    const bootstrap = (identity: typeof from) =>
      r.bootstrap({
        identity,
        projectId: null,
        cwd: dir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
    const push = (id: string, operationId: string, owner = from) =>
      r.invoke({
        route: { id: owner.id, epoch: owner.epoch },
        target: 'queue',
        method: 'push',
        args: [owner.tabId, 'submit once', 'submit once', { id }],
        operationId
      })
    try {
      bootstrap(from)
      await push('stable', 'accepted-ack-lost')
      if (handedOff)
        r.local.data.persistChatEventSync!(
          'tab',
          0,
          {
            kind: 'user-message',
            id: 'stable',
            text: 'submit once'
          },
          Date.now()
        )
      await r.transitionTab(value)
      bootstrap(value.next)
      if (deletedArchive) await r.deleteConversation(value.to)
      await expect(push('stable', 'retry-new-provider', value.next)).rejects.toThrow(
        /already accepted|original chat/
      )
      expect(await r.local.queue.list('tab')).toEqual([])
      if (!deletedArchive)
        expect((await r.local.queue.list('archived')).map((message) => message.id)).toEqual(
          handedOff ? [] : ['stable']
        )
      await push('intentional-new-message', 'intentional-new-message', value.next)
      expect((await r.local.queue.list('tab')).map((message) => message.id)).toEqual([
        'intentional-new-message'
      ])
    } finally {
      await r.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
