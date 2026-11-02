import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
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
