import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ChatQueuePushOptions } from '@slayzone/terminal/runtime'
import { createComputerChatRuntime } from './computer-runtime'

const roots: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const identity = { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function fixture(root = mkdtempSync(join(realpathSync(tmpdir()), 'queue-message-identities-'))) {
  if (!roots.includes(root)) roots.push(root)
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'hub', computerId: 'pc' })
  runtimes.push(r)
  r.bootstrap({
    identity,
    projectId: null,
    cwd: root,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  return {
    r,
    root,
    push: (
      operationId: string,
      send = 'private text',
      original = send,
      opts: ChatQueuePushOptions = { id: 'stable' }
    ) =>
      r.invoke({
        route: { id: 'store', epoch: 1 },
        target: 'queue',
        method: 'push',
        args: ['tab', send, original, opts],
        operationId
      })
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of runtimes.splice(0)) await r.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('an undelivered message keeps one queue row and stable acceptance across restart and operation IDs', async () => {
  const f = fixture(),
    accepted = await f.push('first')
  await f.r.close()
  const next = fixture(f.root)
  expect(await next.push('retry')).toEqual(accepted)
  expect(await next.r.local.queue.list('tab')).toEqual([accepted])
  expect((await next.r.local.queue.pop('tab'))?.id).toBe('stable')
})

test.each(['send', 'original', 'content', 'conversation'] as const)(
  'a stable message ID rejects changed %s without changing its queued payload',
  async (field) => {
    const f = fixture(),
      accepted = await f.push('first')
    await expect(
      f.push(
        'conflict',
        field === 'send' ? 'changed' : 'private text',
        field === 'original' ? 'changed command' : 'private text',
        {
          id: 'stable',
          ...(field === 'content'
            ? { content: [{ type: 'text' as const, text: 'changed content' }] }
            : {}),
          ...(field === 'conversation' ? { expectedConversationId: 'other-session' } : {})
        }
      )
    ).rejects.toThrow(/different input/)
    expect(await f.r.local.queue.list('tab')).toEqual([accepted])
  }
)

test.each(['remove', 'clear', 'retention'] as const)(
  'retired message identity survives %s and cannot recreate an unsent row',
  async (kind) => {
    const f = fixture(),
      now = Date.now(),
      clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const accepted = await f.push('first')
    if (kind === 'remove') await f.r.local.queue.remove('stable')
    if (kind === 'clear') await f.r.local.queue.clear('tab')
    if (kind === 'retention') {
      f.r.retention.configure(1)
      await f.r.retention.runNow(now + 3 * 86_400_000)
    }
    await f.r.close()
    clock.mockRestore()
    const next = fixture(f.root)
    expect(await next.push('retry')).toEqual(accepted)
    expect(await next.r.local.queue.list('tab')).toEqual([])
    await next.push('later', 'later', 'later', { id: 'later' })
    expect((await next.r.local.queue.pop('tab'))?.id).toBe('later')
  }
)

test('handed-off attachment acceptance replays after its events and pins expire without keeping user content in the ledger', async () => {
  const f = fixture(),
    now = Date.now(),
    clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const bytes = Buffer.from('private attachment bytes')
  const sealed = f.r.attachments.put(
    'tab',
    {
      artifactId: 'file',
      name: 'private-name.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  const { contentHash: _hash, ...bare } = sealed
  const opts = { id: 'stable', content: [{ type: 'attachment' as const, attachment: bare }] }
  const accepted = (await f.push('first', 'private command', 'private command', opts)) as {
    content: NonNullable<ChatQueuePushOptions['content']>
  }
  expect(accepted.content[0]).toMatchObject({ attachment: { contentHash: sealed.contentHash } })
  f.r.local.data.persistChatEventSync!(
    'tab',
    0,
    {
      kind: 'user-message',
      id: 'stable',
      text: '',
      content: accepted.content
    },
    now
  )
  expect(await f.r.local.queue.list('tab')).toEqual([])
  f.r.retention.configure(1)
  await f.r.retention.runNow(now + 3 * 86_400_000)
  expect(f.r.storage.read('store', -1)).toEqual([])
  expect(f.r.storage.records('store', 'attachment')).toEqual([])
  const ledger = JSON.stringify(
    f.r.storage.findRecords('settings', 'task', { idPrefix: 'queue-message:' })
  )
  expect(ledger).not.toContain('private command')
  expect(ledger).not.toContain('private-name.txt')
  expect(ledger).not.toContain(bytes.toString())
  await f.r.close()
  clock.mockRestore()
  const next = fixture(f.root)
  expect(await next.push('retry', 'private command', 'private command', opts)).toEqual(accepted)
  expect(await next.r.local.queue.list('tab')).toEqual([])
})

test('legacy receipt/history repair removes only proven duplicate rows and preserves later undelivered messages', async () => {
  const f = fixture(),
    accepted = await f.push('first')
  f.r.local.data.persistChatEventSync!(
    'tab',
    0,
    { kind: 'user-message', id: 'stable', text: 'private text' },
    Date.now()
  )
  await f.push('later', 'later', 'later', { id: 'later' })
  f.r.storage.putRecord('store', 1, {
    kind: 'queue',
    id: 'stable',
    value: accepted,
    at: Date.now()
  })
  f.r.storage.compose((db) =>
    db
      .prepare(
        "DELETE FROM records WHERE kind='settings' AND (id LIKE 'queue-message:%' OR id='queue-message-identities-v5')"
      )
      .run()
  )
  await f.r.close()
  const next = fixture(f.root)
  expect(await next.push('retry')).toEqual(accepted)
  expect((await next.r.local.queue.list('tab')).map((item) => item.id)).toEqual(['later'])
})

test('legacy receipt proves a bare attachment retry without selecting newer bytes or blocking later messages', async () => {
  const f = fixture(),
    bytes = Buffer.from('frozen old version')
  const ref = f.r.attachments.put(
    'tab',
    {
      artifactId: 'file',
      name: 'saved.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  const { contentHash: _hash, ...bare } = ref
  const opts = { id: 'stable', content: [{ type: 'attachment' as const, attachment: bare }] }
  const accepted = (await f.push('first', '', '', opts)) as {
    content: NonNullable<ChatQueuePushOptions['content']>
  }
  f.r.local.data.persistChatEventSync!(
    'tab',
    0,
    { kind: 'user-message', id: 'stable', text: '', content: accepted.content },
    Date.now()
  )
  f.r.attachments.put('tab', { ...bare }, Buffer.from('newer live version'))
  f.r.storage.compose((db) =>
    db
      .prepare(
        "DELETE FROM records WHERE kind='settings' AND (id LIKE 'queue-message:%' OR id='queue-message-identities-v5')"
      )
      .run()
  )
  await f.r.close()
  const next = fixture(f.root)
  expect(await next.push('retry', '', '', opts)).toEqual(accepted)
  expect(await next.r.local.queue.list('tab')).toEqual([])
  await next.push('later', 'later', 'later', { id: 'later' })
  expect((await next.r.local.queue.pop('tab'))?.id).toBe('later')
})

test('a replay cannot consume a reservation belonging to a different message ID', async () => {
  const f = fixture()
  await f.push('first')
  await f.r.local.queue.remove('stable')
  const reservation = await f.r.local.queue.reserve('tab', 'another', 'another-slot')
  await f.push('retry', 'private text', 'private text', { id: 'stable', admission: reservation })
  expect(f.r.local.get('tab', 'settings', 'queue-admission:another-slot')).toMatchObject({
    id: 'another'
  })
})

test('legacy unversioned receipt/duplicate rows reconcile only against their actual saved event', async () => {
  const f = fixture(),
    bytes = Buffer.from('version that was sent')
  const ref = f.r.attachments.put(
    'tab',
    {
      artifactId: 'file',
      name: 'saved.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  const { contentHash: _hash, ...bare } = ref
  const opts = { id: 'stable', content: [{ type: 'attachment' as const, attachment: bare }] }
  const accepted = (await f.push('first', '', '', opts)) as {
    content: NonNullable<ChatQueuePushOptions['content']>
  }
  f.r.local.data.persistChatEventSync!(
    'tab',
    0,
    { kind: 'user-message', id: 'stable', text: '', content: accepted.content },
    Date.now()
  )
  const newer = f.r.attachments.put('tab', bare, Buffer.from('newer version now live'))
  const legacyAccepted = { ...accepted, content: opts.content }
  f.r.storage.compose((db) => {
    // Pre-fix row: today's writer correctly rejects an ambiguous bare pin.
    db.prepare("INSERT INTO records VALUES(?,'queue',?,?,?)").run(
      'store',
      'stable',
      JSON.stringify(legacyAccepted),
      Date.now()
    )
    db.prepare('UPDATE receipts SET result=? WHERE id=?').run(
      JSON.stringify(legacyAccepted),
      'first'
    )
    db.prepare(
      "DELETE FROM records WHERE kind='settings' AND (id LIKE 'queue-message:%' OR id='queue-message-identities-v5')"
    ).run()
  })
  await f.r.close()
  const next = fixture(f.root)
  expect(await next.r.local.queue.list('tab')).toEqual([])
  expect(await next.push('retry', '', '', opts)).toEqual(legacyAccepted)
  await expect(
    next.push('changed-version', '', '', {
      id: 'stable',
      content: [{ type: 'attachment', attachment: newer }]
    })
  ).rejects.toThrow(/different input/)
  await next.push('later', 'later', 'later', { id: 'later' })
  expect((await next.r.local.queue.pop('tab'))?.id).toBe('later')
})

test('an acknowledged identity remains replayable after its reservation expires', async () => {
  const f = fixture(),
    accepted = await f.push('first')
  await f.r.local.queue.remove('stable')
  expect(
    await f.push('retry', 'private text', 'private text', {
      id: 'stable',
      admission: { key: 'expired', token: 'expired' }
    })
  ).toEqual(accepted)
  expect(await f.r.local.queue.list('tab')).toEqual([])
})

test('imported initialized ledgers retain their task identity after the archived owner is deleted and backed up', async () => {
  const source = fixture()
  await source.push('first')
  source.r.local.data.persistChatEventSync!(
    'tab',
    0,
    {
      kind: 'user-message',
      id: 'stable',
      text: 'private text'
    },
    Date.now()
  )
  expect(source.r.local.get('tab', 'settings', 'queue-message-identities-v5')).toBe(true)
  source.r.storage.freeze('store', 1, 'migration')
  const snapshot = source.r.storage.exportConversation('store', 1, 'migration')
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'queue-message-import-'))
  roots.push(root)
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'hub', computerId: 'pc' })
  runtimes.push(r)
  r.storage.stage(snapshot)
  r.storage.activate('store', 'migration', 2, snapshot.hash)
  const from = { ...identity, epoch: 2 },
    to = { ...from, tabId: 'archived', epoch: 3 },
    next = { ...identity, id: 'next', mode: 'codex-chat' }
  await r.transitionTab({ id: 'provider-change', from, to, next })
  r.bootstrap({
    identity: next,
    projectId: null,
    cwd: root,
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  await r.deleteConversation(to)
  expect(r.storage.records('store')).toEqual([])
  await expect(
    r.queueOps.push('tab', 'private text', 'private text', { id: 'stable' })
  ).rejects.toThrow(/already accepted.*deleted/)
  expect(await r.queueOps.list('tab')).toEqual([])
  const backup = await r.backups.create(),
    archive = await r.backups.restore(backup.id)
  const db = new Database(join(r.backups.archiveDir, archive.id, 'chat.sqlite'), { readonly: true })
  try {
    const row = db
      .prepare(
        'SELECT conversation_id,value FROM queue_message_identities WHERE task_id=? AND id=?'
      )
      .get('task', 'stable') as { conversation_id: string; value: string }
    expect(row.conversation_id).toBe('store')
    expect(row.value).not.toContain('private text')
  } finally {
    db.close()
  }
})

test('editing a queued message preserves its original admission identity without reverting later content', async () => {
  const f = fixture(),
    accepted = await f.push('first')
  await f.r.local.queue.update('stable', {
    send: 'edited',
    original: 'edited',
    content: [{ type: 'text', text: 'edited' }]
  })
  expect(await f.push('retry')).toEqual(accepted)
  expect(await f.r.local.queue.list('tab')).toMatchObject([{ id: 'stable', send: 'edited' }])
  await f.r.local.queue.clear('tab')
  await f.r.local.queue.requeue(accepted as Awaited<ReturnType<typeof f.r.local.queue.push>>)
  expect(await f.r.local.queue.list('tab')).toEqual([])
})
