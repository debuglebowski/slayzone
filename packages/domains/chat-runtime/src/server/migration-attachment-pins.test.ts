import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createArtifactStore, BlobStore } from '@slayzone/task-artifacts/server'
import { createChatOwnershipStore } from './hub-ownership'
import { createLegacyChatSource } from './legacy-source'
import { createChatMigrationAttachmentReader } from './migration-attachments'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import type { ChatRecord } from '../shared'

async function fixture() {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(tmpdir(), 'migration-attachment-pins-'))
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'),('foreign','p','Foreign'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
  )
  const artifacts = createArtifactStore(dir)
  async function original(taskId: string, title: string, text: string): Promise<ChatAttachment> {
    const artifact = (await artifacts.uploadArtifactBlob(h.slayDb, {
      taskId,
      title,
      bytes: Buffer.from(text)
    }))!
    const version = (await artifacts.getCurrentArtifactVersion(h.slayDb, {
      artifactId: artifact.id
    }))!
    return {
      artifactId: artifact.id,
      name: title,
      kind: 'text',
      mediaType: 'text/plain',
      size: version.size,
      contentHash: version.content_hash
    }
  }
  const ref = await original('task', 'attached.txt', 'attached source bytes'),
    unrelated = await original('task', 'unrelated.txt', 'unrelated same task bytes'),
    foreign = await original('foreign', 'foreign.txt', 'foreign task bytes')
  const bare = { ...ref }
  delete bare.contentHash
  h.db
    .prepare("INSERT INTO chat_tab_state(tab_id,draft_attachments,updated_at) VALUES('tab',?,123)")
    .run(JSON.stringify([bare]))
  const owners = createChatOwnershipStore(h.slayDb)
  await owners.register({
    id: 'owner',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    epoch: 1,
    computerId: null
  })
  const owner = await owners.beginMigration('owner', {
    expectedComputerId: null,
    expectedEpoch: 1,
    migrationId: 'move',
    destinationComputerId: 'pc'
  })
  const read = createChatMigrationAttachmentReader(h.slayDb, dir)
  let frozen: ChatRecord[] | null = null
  const source = createLegacyChatSource({
    db: h.slayDb,
    quiesce: async () => {},
    bootstrap: async () => ({
      identity: { id: 'owner', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
      projectId: 'p',
      cwd: dir,
      revision: 0,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }),
    freezeMetadata: async (_owner, _id, candidate) => {
      if (!frozen && candidate) frozen = structuredClone(candidate)
      return frozen
    },
    readAttachment: async () => {
      throw new Error('Generic reader must not handle pinned migration bytes')
    },
    readPinnedAttachment: read,
    collectReleasedAttachments: read.collectGarbage
  })
  const transfer = await source.open(owner, 'move')
  const scope = {
    id: owner.id,
    taskId: owner.taskId,
    tabId: owner.tabId,
    mode: owner.mode,
    epoch: owner.epoch,
    migrationId: 'move'
  }
  return {
    h,
    dir,
    artifacts,
    owners,
    owner,
    ref,
    unrelated,
    foreign,
    source,
    read,
    scope,
    transfer,
    close: () => {
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test.each([
  'owner',
  'task',
  'tab',
  'mode',
  'epoch',
  'token',
  'hash',
  'same-task-artifact',
  'foreign-artifact',
  'deleted'
] as const)('trusted migration reader rejects %s outside the frozen pin scope', async (fault) => {
  const f = await fixture()
  try {
    expect(Buffer.from(await f.read(f.scope, f.ref)).toString()).toBe('attached source bytes')
    const scope = { ...f.scope },
      owner = { ...f.owner },
      ref = { ...f.ref }
    if (fault === 'owner') {
      scope.id = owner.id = 'another-owner'
    }
    if (fault === 'task') {
      scope.taskId = owner.taskId = 'foreign'
    }
    if (fault === 'tab') {
      scope.tabId = owner.tabId = 'another-tab'
    }
    if (fault === 'mode') {
      scope.mode = owner.mode = 'codex-chat'
    }
    if (fault === 'epoch') {
      scope.epoch = owner.epoch = 2
    }
    if (fault === 'token') {
      scope.migrationId = owner.migrationId = 'another-move'
    }
    if (fault === 'hash') ref.contentHash = f.unrelated.contentHash
    if (fault === 'same-task-artifact') Object.assign(ref, f.unrelated)
    if (fault === 'foreign-artifact') Object.assign(ref, f.foreign)
    if (fault === 'deleted') f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    await expect(f.read(scope, ref)).rejects.toThrow(/ownership|frozen source/i)
    await expect(f.source.readAttachment(owner, ref)).rejects.toThrow(/ownership|frozen source/i)
    if (fault === 'same-task-artifact' || fault === 'foreign-artifact')
      await expect(f.source.pinAttachments!(f.owner, [ref], f.transfer.manifest)).rejects.toThrow(
        /frozen source/i
      )
  } finally {
    f.close()
  }
})

test('a frozen attachment remains readable after its original is deleted, then owner deletion releases its blob', async () => {
  const f = await fixture()
  try {
    await f.artifacts.deleteArtifact(f.h.slayDb, f.ref.artifactId)
    await f.h.slayDb.namedTxn('task-artifacts:blobs:collect', { dataDir: f.dir })
    expect(Buffer.from(await f.source.readAttachment(f.owner, f.ref)).toString()).toBe(
      'attached source bytes'
    )
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    expect(
      f.h.db.prepare('SELECT count(*) AS n FROM artifact_blob_pins WHERE owner_id=?').get('owner')
    ).toEqual({ n: 0 })
    await f.read.collectGarbage()
    expect(new BlobStore(f.dir).has(f.ref.contentHash!)).toBe(false)
  } finally {
    f.close()
  }
})

test('a generic artifact lease defers source GC until it is released', async () => {
  const f = await fixture()
  try {
    await f.artifacts.deleteArtifact(f.h.slayDb, f.ref.artifactId)
    f.h.db.prepare("INSERT INTO artifact_blob_leases VALUES('backup',?)").run(Date.now() + 60000)
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    await expect(f.read.collectGarbage()).resolves.toMatchObject({ deferred: true })
    expect(new BlobStore(f.dir).has(f.ref.contentHash!)).toBe(true)
    f.h.db.prepare("DELETE FROM artifact_blob_leases WHERE id='backup'").run()
    await expect(f.read.collectGarbage()).resolves.toMatchObject({ deferred: false })
    expect(new BlobStore(f.dir).has(f.ref.contentHash!)).toBe(false)
  } finally {
    f.close()
  }
})

test('authoritative task deletion releases migration pins while deliberate backup pins retain bytes', async () => {
  const f = await fixture()
  try {
    await f.artifacts.deleteArtifact(f.h.slayDb, f.ref.artifactId)
    f.h.db
      .prepare('INSERT INTO artifact_blob_pins VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        'hub-backup',
        'backup',
        'backup',
        f.ref.artifactId,
        'task',
        f.ref.artifactId,
        0,
        f.ref.contentHash,
        f.ref.size
      )
    f.h.db.prepare("DELETE FROM tasks WHERE id='task'").run()
    expect(f.h.db.prepare('SELECT scope FROM artifact_blob_pins').all()).toEqual([
      { scope: 'hub-backup' }
    ])
    await f.read.collectGarbage()
    expect(new BlobStore(f.dir).has(f.ref.contentHash!)).toBe(true)
    f.h.db.prepare("DELETE FROM artifact_blob_pins WHERE scope='hub-backup'").run()
    f.h.db.prepare('INSERT OR IGNORE INTO artifact_blob_gc_pending VALUES(1)').run()
    await f.read.collectGarbage()
    expect(new BlobStore(f.dir).has(f.ref.contentHash!)).toBe(false)
  } finally {
    f.close()
  }
})

test('a new GC request during finalization survives the older collector and is drained next', async () => {
  const f = await fixture()
  const original = BlobStore.prototype.collectDeleted
  let inserted = false
  try {
    await f.artifacts.deleteArtifact(f.h.slayDb, f.ref.artifactId)
    f.h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    const spy = vi.spyOn(BlobStore.prototype, 'collectDeleted').mockImplementation(function (
      this: BlobStore,
      refs
    ) {
      if (!inserted) {
        inserted = true
        f.h.db
          .prepare('DELETE FROM artifact_versions WHERE artifact_id=?')
          .run(f.unrelated.artifactId)
        f.h.db.prepare('INSERT OR IGNORE INTO artifact_blob_gc_pending VALUES(1)').run()
      }
      return original.call(this, refs)
    })
    await f.read.collectGarbage()
    spy.mockRestore()
    expect(inserted).toBe(true)
    expect(
      f.h.db.prepare('SELECT 1 AS pending FROM artifact_blob_gc_pending WHERE id=1').get()
    ).toEqual({ pending: 1 })
    expect(new BlobStore(f.dir).has(f.unrelated.contentHash!)).toBe(true)
    await f.read.collectGarbage()
    expect(
      f.h.db.prepare('SELECT 1 FROM artifact_blob_gc_pending WHERE id=1').get()
    ).toBeUndefined()
    expect(new BlobStore(f.dir).has(f.unrelated.contentHash!)).toBe(false)
  } finally {
    vi.restoreAllMocks()
    f.close()
  }
})
