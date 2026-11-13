import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { encodeTransfer } from './transfers'
import { openChatStorage } from './storage'
import { createChatBackups } from './backups'

const dirs: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
function directory() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-storage-recovery-'))
  dirs.push(dir)
  return dir
}
function runtime(dir = directory()) {
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
  runtimes.push(r)
  return r
}
const identity = (id: string) => ({ id, taskId: 'task', tabId: id, mode: 'claude-chat', epoch: 1 })
function bootstrap(r: ReturnType<typeof runtime>, id: string) {
  r.bootstrap({
    identity: identity(id),
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
}
function attachment(r: ReturnType<typeof runtime>, text: string) {
  const bytes = Buffer.from(text)
  return r.attachments.put(
    'source',
    {
      artifactId: 'file',
      name: 'saved.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
}
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('upgrade repairs a retained imported reference after its source pin was deleted', async () => {
  const dir = directory(),
    r = runtime(dir)
  bootstrap(r, 'source')
  bootstrap(r, 'destination')
  const ref = attachment(r, 'sealed imported attachment')
  // Simulate the pre-fix importer, which wrote history without destination pins.
  r.storage.compose((db) => {
    db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(
      'destination',
      0,
      1,
      JSON.stringify({
        kind: 'user-message',
        id: 'imported',
        text: 'saved',
        content: [{ type: 'attachment', attachment: ref }]
      })
    )
    db.prepare('DELETE FROM storage_maintenance').run()
  })
  r.storage.applyTombstone({ ...identity('source'), epoch: 2 })
  await r.close()
  const reopened = runtime(dir)
  expect(
    reopened.storage.getRecord('destination', 'attachment', `${ref.artifactId}:${ref.contentHash}`)
  ).toMatchObject(ref)
  reopened.attachments.collectGarbage()
  expect(Buffer.from(await reopened.attachments.reader.read(ref)).toString()).toBe(
    'sealed imported attachment'
  )
  const backup = await reopened.backups.create(),
    archive = await reopened.backups.restore(backup.id)
  expect(reopened.backups.attachment(archive.id, 'destination', ref).toString()).toBe(
    'sealed imported attachment'
  )
})

test('ambiguous old bare attachment references never silently choose different saved bytes', async () => {
  const r = runtime()
  bootstrap(r, 'source')
  const first = attachment(r, 'first!'),
    second = attachment(r, 'second')
  const { contentHash: _hash, ...bare } = second
  await expect(r.attachments.reader.read(bare)).rejects.toThrow(
    /ambiguous.*version|version.*ambiguous/i
  )
  expect(Buffer.from(await r.attachments.reader.read(first)).toString()).toBe('first!')
  expect(Buffer.from(await r.attachments.reader.read(second)).toString()).toBe('second')
})

test('control metadata remains available without parsing unrelated retained content', async () => {
  const r = runtime()
  bootstrap(r, 'source')
  r.storage.compose((db) =>
    db
      .prepare("INSERT INTO records VALUES(?,'settings',?,'{',1)")
      .run('source', 'diagnostic:unreadable-content')
  )
  expect(
    r.storage.findRecords('settings', undefined, { idPrefix: 'metadata:', limit: 500 })
  ).toEqual([])
  expect(r.local.metadataSnapshot('source')).toMatchObject({ identity: identity('source') })
  expect(await r.local.queue.list('source')).toEqual([])
  expect(await r.local.data.getModeDefaultFlags('claude-chat')).toBeNull()
  expect(await r.local.data.getAutocompleteUsage()).toEqual({})
})

test.each([true, false])(
  'legacy configuration is elected before a stale bootstrap overwrites its cache (existing=%s)',
  async (existing) => {
    const r = runtime()
    bootstrap(r, 'current')
    if (existing) bootstrap(r, 'sibling')
    r.storage.putRecord('current', 1, {
      kind: 'settings',
      id: 'provider',
      value: { chatModel: 'new-model' },
      at: 100
    })
    if (existing)
      r.storage.putRecord('sibling', 1, {
        kind: 'settings',
        id: 'provider',
        value: { chatModel: 'old-model' },
        at: 1
      })
    r.storage.compose((db) => db.prepare('DELETE FROM provider_configs').run())
    r.bootstrap({
      identity: identity('sibling'),
      projectId: null,
      cwd: '/tmp',
      revision: 2,
      providerConfig: { chatModel: 'old-model' },
      defaultFlags: null,
      env: {}
    })
    expect(await r.local.data.readProviderConfig('task', 'claude-chat')).toMatchObject({
      chatModel: 'new-model'
    })
  }
)

test('backup refuses malformed live content and preserves its previous verified snapshot', async () => {
  const r = runtime()
  bootstrap(r, 'source')
  r.storage.append('source', 1, { kind: 'assistant-text', messageId: 'm', text: 'recover me' })
  const previous = await r.backups.create()
  r.storage.compose((db) => db.prepare("UPDATE events SET event='{' ").run())
  await expect(r.backups.create()).rejects.toThrow(/JSON|integrity/i)
  expect(r.backups.list().map((b) => b.id)).toEqual([previous.id])
  const archive = await r.backups.restore(previous.id)
  expect(r.backups.read(archive.id, 'source').events[0].event).toMatchObject({ text: 'recover me' })
})

test('backup refuses a retained user attachment whose owning pin is missing', async () => {
  const r = runtime()
  bootstrap(r, 'source')
  const ref = attachment(r, 'attachment still referenced by history')
  r.storage.append('source', 1, {
    kind: 'user-message',
    id: 'm',
    text: 'saved',
    content: [{ type: 'attachment', attachment: ref }]
  })
  r.storage.compose((db) => db.prepare("DELETE FROM records WHERE kind='attachment'").run())
  await expect(r.backups.create()).rejects.toThrow(/attachment|reference|blob/i)
  expect(r.backups.list()).toEqual([])
})

test('v3 upgrade erases old side-answer receipts without erasing other operation outcomes', async () => {
  const dir = directory(),
    r = runtime(dir)
  bootstrap(r, 'source')
  const outcomes = {
    side: { text: 'private ephemeral answer' },
    popped: { popped: true, text: 'queued content', id: 'm', content: [] },
    extra: { text: 'ordinary result', other: true },
    scalar: 'saved scalar'
  }
  for (const [id, result] of Object.entries(outcomes)) {
    r.storage.acceptCommand('source', 1, id, { legacy: id })
    r.storage.completeCommand('source', 1, id, result)
  }
  const hash = r.storage.receipt('source', 'side')!.hash
  r.storage.compose((db) => db.pragma('user_version=3'))
  await r.close()
  const reopened = runtime(dir)
  expect(reopened.storage.receipt('source', 'side')).toMatchObject({
    hash,
    state: 'delivered',
    result: null,
    resultExpired: true
  })
  for (const [id, result] of Object.entries(outcomes))
    if (id !== 'side')
      expect(reopened.storage.receipt('source', id)).toMatchObject({ result, resultExpired: false })
})

test('startup removes abandoned unpublished backup and restore content', async () => {
  const dir = directory(),
    r = runtime(dir),
    abandoned: string[] = []
  for (const root of [r.backups.dir, r.backups.archiveDir]) {
    const pending = join(root, `.pending-${randomUUID()}`)
    mkdirSync(pending)
    writeFileSync(join(pending, 'chat.sqlite'), 'private incomplete snapshot')
    abandoned.push(pending)
  }
  await r.close()
  runtime(dir)
  expect(abandoned.filter(existsSync)).toEqual([])
})

test('opening another backup service preserves an active snapshot staging directory', async () => {
  const r = runtime()
  bootstrap(r, 'source')
  let release!: () => void, ready!: () => void
  const pause = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      ready = resolve
    })
  const original = r.storage.backupTo.bind(r.storage)
  r.storage.backupTo = async (path) => {
    const result = await original(path)
    ready()
    await pause
    return result
  }
  const work = r.backups.create()
  let other: ReturnType<typeof createChatBackups> | undefined
  try {
    await started
    const staging = readdirSync(r.backups.dir).filter((name) => name.startsWith('.pending-'))
    expect(staging).toHaveLength(1)
    other = createChatBackups(r.storage)
    expect(staging.every((name) => existsSync(join(r.backups.dir, name)))).toBe(true)
    release()
    await expect(work).resolves.toMatchObject({ conversations: 1 })
  } finally {
    release()
    await work.catch(() => {})
    await other?.close()
  }
})

test('old acknowledged child tombstones are excluded from parent thread reads after upgrade', async () => {
  const dir = directory(),
    r = runtime(dir)
  bootstrap(r, 'parent')
  bootstrap(r, 'child')
  r.storage.putRecord('parent', 1, {
    kind: 'thread',
    id: 'child',
    value: {
      id: 'child',
      parentTabId: 'parent',
      taskId: 'task',
      mode: 'claude-chat',
      title: 'closed child',
      createdAt: 1
    },
    at: 1
  })
  // Old deletion erased child content but left its parent reference behind.
  r.storage.compose((db) =>
    db.prepare("UPDATE conversations SET state='deleted',epoch=2 WHERE id='child'").run()
  )
  await r.close()
  const reopened = runtime(dir)
  expect(await reopened.local.data.threads!.listForParent('parent')).toEqual([])
  expect(await reopened.local.data.threads!.get('child')).toBeUndefined()
})

test.each(['missing', 'damaged'] as const)(
  'deleted transfer payload is erased even with %s progress metadata',
  async (fault) => {
    const r = runtime(),
      source = openChatStorage({ stateDir: directory(), hubScope: 'source' })
    const i = identity('staged')
    try {
      source.createConversation(i)
      source.append(i.id, i.epoch, {
        kind: 'assistant-text',
        messageId: 'm',
        text: 'private staged history'
      })
      source.freeze(i.id, i.epoch, 'migration')
      const p = encodeTransfer(source.exportConversation(i.id, i.epoch, 'migration'))
      const start = r.transfers.begin(p.manifest)
      r.transfers.chunk(start.id, 0, p.bytes)
      r.transfers.finish(start.id)
      const progress = join(r.storage.dir, 'transfers', `${start.id}.json`)
      if (fault === 'missing') rmSync(progress)
      else {
        const fs = await import('node:fs')
        fs.writeFileSync(progress, '{')
      }
      await r.deleteConversation({ ...i, epoch: 3 })
      expect(() => readFileSync(join(r.storage.dir, 'transfers', `${start.id}.data`))).toThrow(
        /ENOENT/
      )
    } finally {
      source.close()
    }
  }
)
