import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { ChatThread } from '@slayzone/terminal-contracts'
import { createComputerChatRuntime } from './computer-runtime'

const NATIVE = '33333333-4444-4555-8666-777777777777'

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-thread-close-'))
  const runtime = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'test',
    computerId: 'pc',
    transport: {
      spawn: () => {
        throw new Error('Provider execution forbidden')
      }
    }
  })
  runtime.bootstrap({
    identity: { id: 'conv', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: dir,
    revision: 1,
    providerConfig: { chatConversationId: NATIVE },
    defaultFlags: null,
    env: {}
  })
  let op = 0
  const call = (method: string, ...args: unknown[]) =>
    runtime.invoke({
      route: { id: 'conv', epoch: 1 },
      target: 'ops',
      method,
      operationId: `op-${++op}`,
      args
    })
  return {
    runtime,
    dir,
    call,
    opts: { tabId: 'tab', taskId: 'task', mode: 'claude-chat', cwd: dir },
    async close() {
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const thread = (over: Partial<ChatThread> = {}): ChatThread => ({
  id: 'child',
  parentTabId: 'tab',
  taskId: 'task',
  mode: 'claude-chat',
  parentConversationId: NATIVE,
  answerId: 'a1:0',
  sourceMessageId: 'u1',
  sourceUuid: 'uuid-1',
  title: 'side question',
  conversationId: null,
  closedAt: null,
  createdAt: 10,
  ...over
})

test('a thread closes and reopens, announcing each change; closed state persists', async () => {
  const f = fixture()
  try {
    await f.runtime.local.data.threads!.create(thread())
    const changed: string[] = []
    f.runtime.events.on('threads-changed', (tabId) => changed.push(tabId))
    expect(await f.call('listThreads', f.opts)).toEqual([thread()])
    await f.call('setThreadClosed', { ...f.opts, threadId: 'child', closed: true })
    expect(await f.call('listThreads', f.opts)).toEqual([thread({ closedAt: expect.any(Number) })])
    await f.call('setThreadClosed', { ...f.opts, threadId: 'child', closed: false })
    expect(await f.call('listThreads', f.opts)).toEqual([thread()])
    expect(changed).toEqual(['tab', 'tab'])
  } finally {
    await f.close()
  }
})

test('closing stops the thread session', async () => {
  const f = fixture()
  try {
    await f.runtime.local.data.threads!.create(thread())
    const child = f.runtime.storage.forTab('child')!
    await f.runtime.invoke({
      route: { id: child.identity.id, epoch: child.identity.epoch },
      target: 'ops',
      method: 'hydrate',
      operationId: 'hydrate-child',
      args: [{ ...f.opts, tabId: 'child' }]
    })
    expect(f.runtime.transport.getSessionInfo('child')).toBeTruthy()
    await f.call('setThreadClosed', { ...f.opts, threadId: 'child', closed: true })
    expect(f.runtime.transport.getSessionInfo('child')).toBeFalsy()
  } finally {
    await f.close()
  }
})

test('a thread is closed only from its own parent tab', async () => {
  const f = fixture()
  try {
    await f.runtime.local.data.threads!.create(thread({ parentTabId: 'tab' }))
    await expect(
      f.call('setThreadClosed', { ...f.opts, threadId: 'missing', closed: true })
    ).rejects.toThrow(/not found/i)
  } finally {
    await f.close()
  }
})

test('a thread stored before closing existed reads as open', async () => {
  const f = fixture()
  try {
    const { closedAt: _closedAt, ...legacy } = thread()
    f.runtime.storage.putRecord('conv', 1, { kind: 'thread', id: 'child', value: legacy, at: 10 })
    expect(await f.runtime.local.data.threads!.get('child')).toEqual(thread())
    expect(await f.runtime.local.data.threads!.listForParent('tab')).toEqual([thread()])
  } finally {
    await f.close()
  }
})
