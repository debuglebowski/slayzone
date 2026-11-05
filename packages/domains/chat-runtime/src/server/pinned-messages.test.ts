import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'
import Database from 'better-sqlite3'
import { createComputerChatRuntime } from './computer-runtime'
import { bumpTaskStateVersion, openChatStorage } from './storage'

const NATIVE = '33333333-4444-4555-8666-777777777777'

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-pinned-messages-'))
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
  const identity = { id: 'conv', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  runtime.bootstrap({
    identity,
    projectId: null,
    cwd: dir,
    revision: 1,
    providerConfig: { chatConversationId: NATIVE },
    defaultFlags: null,
    env: {}
  })
  return {
    runtime,
    identity,
    dir,
    pins: runtime.local.data.pinnedMessages!,
    async close() {
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const pin = (over: Partial<ChatPinnedMessage> = {}): ChatPinnedMessage => ({
  conversationId: 'session-a',
  key: 'user-text:u1',
  target: 'user',
  messageId: 'u1',
  row: 3,
  excerpt: 'fix the login bug',
  pinnedAt: 100,
  ...over
})

test('pins list per provider conversation, oldest first', async () => {
  const f = fixture()
  try {
    await f.pins.pin(
      'tab',
      pin({ key: 'text:a1:0', target: 'answer', messageId: 'a1', pinnedAt: 200 })
    )
    await f.pins.pin('tab', pin())
    await f.pins.pin('tab', pin({ conversationId: 'session-b', key: 'user-text:u9', pinnedAt: 50 }))
    expect((await f.pins.list('tab', 'session-a')).map((p) => p.key)).toEqual([
      'user-text:u1',
      'text:a1:0'
    ])
    expect((await f.pins.list('tab', 'session-b')).map((p) => p.key)).toEqual(['user-text:u9'])
    expect(await f.pins.list('tab', 'session-none')).toEqual([])
  } finally {
    await f.close()
  }
})

test('pinning a pinned row again keeps one pin; unpin removes it', async () => {
  const f = fixture()
  try {
    await f.pins.pin('tab', pin())
    await f.pins.pin('tab', pin({ excerpt: 'edited', pinnedAt: 300 }))
    expect(await f.pins.list('tab', 'session-a')).toEqual([
      pin({ excerpt: 'edited', pinnedAt: 300 })
    ])
    await f.pins.unpin('tab', 'session-a', 'user-text:u1')
    expect(await f.pins.list('tab', 'session-a')).toEqual([])
    // Unpinning what is not pinned is a no-op.
    await f.pins.unpin('tab', 'session-a', 'user-text:u1')
  } finally {
    await f.close()
  }
})

test('a database created before pins gets the local-only triggers of this build', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-pinned-triggers-'))
  try {
    const identity = { id: 'conv', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
    const first = openChatStorage({ stateDir: dir, hubScope: 'test' })
    first.createConversation(identity)
    first.close()
    // The trigger an older build left: every kind but its own local-only ones bumps.
    const raw = new Database(join(first.dir, 'chat.sqlite'))
    raw.exec(`DROP TRIGGER records_state_version_insert;
      CREATE TRIGGER records_state_version_insert AFTER INSERT ON records
      WHEN NOT (NEW.kind IN ('draft')) BEGIN ${bumpTaskStateVersion(`(SELECT task_id FROM conversations WHERE id=NEW.conversation_id)`)} END;`)
    raw.close()
    const reopened = openChatStorage({ stateDir: dir, hubScope: 'test' })
    try {
      const before = reopened.stateVersion('task')
      reopened.putRecord('conv', 1, { kind: 'pinned-message', id: 'p', value: pin(), at: 1 })
      expect(reopened.stateVersion('task')).toBe(before)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pins are conversation content: no hub state version bump, counted as content', async () => {
  const f = fixture()
  try {
    const before = f.runtime.storage.stateVersion('task')
    expect(f.runtime.storage.hasConversationContent('conv')).toBeFalsy()
    await f.pins.pin('tab', pin())
    expect(f.runtime.storage.stateVersion('task')).toBe(before)
    expect(f.runtime.storage.hasConversationContent('conv')).toBeTruthy()
  } finally {
    await f.close()
  }
})

test('chat ops pin, list and unpin in the conversation on screen, announcing each change', async () => {
  const f = fixture()
  try {
    const opts = { tabId: 'tab', taskId: 'task', mode: 'claude-chat', cwd: f.dir }
    let op = 0
    const call = (method: string, ...args: unknown[]) =>
      f.runtime.invoke({
        route: { id: 'conv', epoch: 1 },
        target: 'ops',
        method,
        operationId: `op-${++op}`,
        args
      })
    const changed: string[] = []
    f.runtime.events.on('pinned-messages-changed', (tabId) => changed.push(tabId))
    const info = (await call('hydrate', opts)) as { sessionId: string }
    const input = {
      conversationId: info.sessionId,
      key: 'user-text:u1',
      target: 'user',
      messageId: 'u1',
      row: 0,
      excerpt: 'fix the login bug'
    }
    await call('pinMessage', { ...opts, pin: input })
    expect(await call('listPinnedMessages', opts)).toEqual([
      { ...input, pinnedAt: expect.any(Number) }
    ])
    // A pin for a conversation no longer on screen is refused, not filed under it.
    await expect(
      call('pinMessage', { ...opts, pin: { ...input, conversationId: 'stale-session' } })
    ).rejects.toThrow(/conversation changed/i)
    await call('unpinMessage', { ...opts, conversationId: info.sessionId, key: 'user-text:u1' })
    expect(await call('listPinnedMessages', opts)).toEqual([])
    expect(changed).toEqual(['tab', 'tab'])
  } finally {
    await f.close()
  }
})
