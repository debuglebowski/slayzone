import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  promises as fsAsync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

test('backup includes consistent history and blobs; restore is a separate read-only archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-backup-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: { chatConversationId: 'provider' },
      defaultFlags: null,
      env: {}
    })
    const bytes = Buffer.from('saved attachment'),
      ref = r.attachments.put(
        'tab',
        {
          artifactId: 'file',
          name: 'notes.txt',
          kind: 'text',
          mediaType: 'text/plain',
          size: bytes.length
        },
        bytes
      )
    r.storage.append(
      'c',
      1,
      { kind: 'assistant-text', messageId: 'answer', text: 'backup history' },
      123
    )
    await r.ops.saveTabDraft('tab', { text: 'saved draft', attachments: [ref] })
    const backup = await r.backups.create('manual')
    expect(backup).toMatchObject({ events: 1, readOnlyRestore: true, providerResumable: false })
    await r.applyTaskLifecycle('task', 'deleted', 1)
    const archive = await r.backups.restore(backup.id)
    expect(r.storage.conversation('c')).toMatchObject({ state: 'deleted' })
    expect(r.backups.read(archive.id, 'c', -1, 10).events).toMatchObject([
      { seq: 0, at: 123, event: { text: 'backup history' } }
    ])
    expect(Buffer.from(r.backups.attachment(archive.id, 'c', ref))).toEqual(bytes)
    expect(r.backups.listArchives()).toMatchObject([
      { id: archive.id, readOnly: true, providerResumable: false }
    ])
    expect(() =>
      r.bootstrap({
        identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
        projectId: null,
        cwd: '/tmp',
        revision: 2,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
    ).toThrow(/deleted/i)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt backups fail verification without creating an archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-backup-corrupt-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    const backup = await r.backups.create('manual'),
      path = join(r.backups.dir, backup.id, 'chat.sqlite'),
      data = readFileSync(path)
    data[data.length - 1] ^= 1
    writeFileSync(path, data)
    await expect(r.backups.restore(backup.id)).rejects.toThrow(/integrity|hash/i)
    expect(r.backups.listArchives()).toEqual([])
    expect(readdirSync(r.backups.archiveDir)).toEqual([])
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting live history during a snapshot cannot collect its referenced blobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-backup-race-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  let release!: () => void, ready!: () => void
  const paused = new Promise<void>((resolve) => {
      release = resolve
    }),
    snapshotted = new Promise<void>((resolve) => {
      ready = resolve
    })
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const bytes = Buffer.from('snapshot pinned file'),
      ref = r.attachments.put(
        'tab',
        {
          artifactId: 'f',
          name: 'file.txt',
          kind: 'text',
          mediaType: 'text/plain',
          size: bytes.length
        },
        bytes
      )
    const original = r.storage.backupTo.bind(r.storage)
    r.storage.backupTo = async (path) => {
      const info = await original(path)
      ready()
      await paused
      return info
    }
    const pending = r.backups.create('manual')
    await snapshotted
    await r.applyTaskLifecycle('task', 'deleted', 1)
    release()
    const backup = await pending,
      archive = await r.backups.restore(backup.id)
    expect(r.backups.attachment(archive.id, 'c', ref)).toEqual(bytes)
    r.attachments.collectGarbage()
  } finally {
    release()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent restore retries share one archive; the archive id cannot switch backups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-restore-retry-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    const a = await r.backups.create(),
      b = await r.backups.create(),
      id = randomUUID()
    const results = await Promise.allSettled([
      r.backups.restore(a.id, id),
      r.backups.restore(a.id, id),
      r.backups.restore(b.id, id)
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Archive id conflict' })
    })
    expect(r.backups.listArchives()).toMatchObject([{ id, backupId: a.id }])
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restore pins its backup immediately and shutdown waits for the durable archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-restore-close-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  let release!: () => void, copying!: () => void
  let restoring: Promise<unknown> | undefined
  const paused = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      copying = resolve
    })
  const original = fsAsync.copyFile.bind(fsAsync)
  const copy = vi.spyOn(fsAsync, 'copyFile').mockImplementation(async (src, dest, mode) => {
    await original(src, dest, mode)
    if (String(dest).includes('/archives/.pending-')) {
      copying()
      await paused
    }
  })
  try {
    const backup = await r.backups.create()
    const work = r.backups.restore(backup.id)
    restoring = work
    const deleting = () => r.backups.delete(backup.id)
    expect(deleting).toThrow(/restor|progress/i)
    await started
    let stopped = false
    const stopping = r.backups.close().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    release()
    const archive = await work
    await stopping
    expect(r.backups.listArchives()).toMatchObject([{ id: archive.id }])
    await expect(r.backups.restore(backup.id)).rejects.toThrow(/closed/i)
  } finally {
    release()
    await Promise.allSettled(restoring ? [restoring] : [])
    copy.mockRestore()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one damaged archive descriptor cannot hide readable archives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-archive-list-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    const backup = await r.backups.create(),
      broken = await r.backups.restore(backup.id),
      readable = await r.backups.restore(backup.id)
    writeFileSync(join(r.backups.archiveDir, broken.id, 'archive.json'), '{}')
    expect(r.backups.listArchives()).toMatchObject([
      expect.objectContaining({ id: readable.id }),
      expect.objectContaining({ id: broken.id, error: expect.any(String) })
    ])
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archives expose unattached task files and every saved version, scoped to their owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-archive-files-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 't', tabId: 'files', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: 'c', epoch: 1 }
    const artifact = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: 'upload',
      args: [
        { taskId: 't', title: 'saved.txt', data: Buffer.from('first version').toString('base64') }
      ]
    })) as { id: string }
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      operationId: 'edit',
      args: [{ id: artifact.id, content: 'second version' }]
    })
    const backup = await r.backups.create(),
      archive = await r.backups.restore(backup.id)
    await r.applyTaskLifecycle('t', 'deleted', 1)
    const rows = r.backups
      .records(archive.id, 'c')
      .records.filter((row) => row.kind === 'artifact-version')
    expect(rows).toHaveLength(2)
    const files = rows.map(
      (row) => row.value as { artifactId: string; contentHash: string; name: string }
    )
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactId: artifact.id, name: 'saved.txt' })
      ])
    )
    expect(
      files.map((file) =>
        r.backups.file(archive.id, 'c', file.artifactId, file.contentHash).data.toString()
      )
    ).toEqual(['first version', 'second version'])
    expect(() => r.backups.file(archive.id, 'other', artifact.id, files[0].contentHash)).toThrow(
      /belong|owner|scope/i
    )
    const first = r.backups.records(archive.id, 'c').records[0]
    expect(
      r.backups
        .records(archive.id, 'c', first.cursor)
        .records.every((row) => row.cursor > first.cursor)
    ).toBe(true)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore verifies copied files before publishing the archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-archive-verify-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  const original = fsAsync.copyFile.bind(fsAsync)
  const copy = vi.spyOn(fsAsync, 'copyFile').mockImplementation(async (src, dest, mode) => {
    await original(src, dest, mode)
    if (String(dest).includes('/archives/.pending-') && String(dest).endsWith('chat.sqlite')) {
      const bytes = readFileSync(dest)
      bytes[bytes.length - 1] ^= 1
      writeFileSync(dest, bytes)
    }
  })
  try {
    const backup = await r.backups.create()
    await expect(r.backups.restore(backup.id)).rejects.toThrow(/integrity|hash/i)
    expect(r.backups.listArchives()).toEqual([])
    expect(readdirSync(r.backups.archiveDir)).toEqual([])
  } finally {
    copy.mockRestore()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
