import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { chatAttachmentSchema } from '../shared/protocol'

test('chat uploads remain computer-local, support editing, and seal historical versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-upload-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: 'c', epoch: 1 },
      bytes = Buffer.from('original')
    const call = {
      route,
      method: 'uploadArtifactBlob',
      args: [{ taskId: 't', title: 'secret.txt', data: bytes.toString('base64') }],
      operationId: 'upload'
    }
    const a = (await r.artifacts.invoke(call)) as { id: string; title: string }
    expect(await r.artifacts.invoke(call)).toEqual(a)
    const ref = await r.artifacts.seal('tab', {
      artifactId: a.id,
      name: a.title,
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    })
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      args: [{ id: a.id, content: 'edited' }],
      operationId: 'edit'
    })
    expect(await r.attachments.reader.read(ref)).toEqual(bytes)
    expect(await r.artifacts.invoke({ route, method: 'readArtifactContent', args: [a.id] })).toBe(
      'edited'
    )
    await expect(
      r.artifacts.invoke({
        route,
        method: 'uploadArtifactBlob',
        args: [{ taskId: 'other', title: 'bad', data: '' }],
        operationId: 'bad'
      })
    ).rejects.toThrow(/task|scope/i)
    await r.applyTaskLifecycle('t', 'deleted', 1)
    await expect(
      r.artifacts.invoke({ route, method: 'readArtifactContent', args: [a.id] })
    ).rejects.toThrow(/deleted|ownership/i)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deleted folder cannot be reimported by a delayed command; duplicate delete remains acknowledged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-folder-fence-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: 'c', epoch: 1 }
    const folder = (await r.artifacts.invoke({
      route,
      method: 'createFolder',
      operationId: 'new',
      args: [{ taskId: 't', name: 'Folder' }]
    })) as { id: string }
    const deletion = { route, method: 'deleteFolder', operationId: 'delete', args: [folder.id] }
    expect(await r.artifacts.invoke(deletion)).toBe(true)
    expect(await r.artifacts.invoke(deletion)).toBe(true)
    await expect(
      r.artifacts.invoke({
        route,
        method: 'importFolder',
        operationId: 'stale-import',
        args: [{ id: folder.id, taskId: 't', name: 'Old', parentId: null }]
      })
    ).rejects.toThrow(/deleted/)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('folder cleanup is atomic across a mixed-task batch and its fences survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-folder-scope-'))
  let r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  try {
    for (const taskId of ['one', 'two'])
      r.bootstrap({
        identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: '/tmp',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
    const create = (id: string) =>
      r.artifacts.invoke({
        route: { id, epoch: 1 },
        method: 'createFolder',
        operationId: 'new',
        args: [{ taskId: id, name: id }]
      }) as Promise<{ id: string }>
    const one = await create('one'),
      two = await create('two')
    expect(() => r.artifacts.deleteFolders('one', [one.id, two.id])).toThrow(/outside.*task/i)
    expect(r.artifacts.deletedFolderInventory(0).rows).toEqual([])
    expect(
      await r.artifacts.invoke({
        route: { id: 'one', epoch: 1 },
        method: 'listFoldersByTask',
        args: ['one']
      })
    ).toHaveLength(1)
    await r.applyTaskLifecycle('one', 'paused', 1)
    // Reconciliation can finish a committed deletion while the task is in Trash.
    r.artifacts.deleteFolders('one', [one.id])
    await r.close()
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
    expect(r.artifacts.deletedFolderInventory(0).rows).toMatchObject([
      { folderId: one.id, taskId: 'one' }
    ])
    await r.applyTaskLifecycle('one', 'active', 2)
    await expect(
      r.artifacts.invoke({
        route: { id: 'one', epoch: 1 },
        method: 'importFolder',
        operationId: 'late',
        args: [{ id: one.id, taskId: 'one', name: 'Old', parentId: null }]
      })
    ).rejects.toThrow(/deleted/i)
    expect(
      await r.artifacts.invoke({
        route: { id: 'two', epoch: 1 },
        method: 'listFoldersByTask',
        args: ['two']
      })
    ).toHaveLength(1)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each(['size', 'type', 'metadata'] as const)(
  'prepared attachments reject %s mismatches before storing bytes',
  async (mismatch) => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-prepared-')),
      source = createComputerChatRuntime({ stateDir: dir, hubScope: 'source', computerId: 'pc' }),
      target = createComputerChatRuntime({ stateDir: dir, hubScope: 'target', computerId: 'pc' })
    try {
      const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
        bytes = Buffer.from('plain text'),
        contentHash = createHash('sha256').update(bytes).digest('hex'),
        ref = {
          artifactId: 'a',
          contentHash,
          name: 'saved.txt',
          size: bytes.length,
          kind: 'text' as const,
          mediaType: 'text/plain' as const
        },
        saved =
          mismatch === 'size'
            ? { ...ref, size: bytes.length + 1 }
            : mismatch === 'type'
              ? {
                  ...ref,
                  name: 'saved.png',
                  kind: 'image' as const,
                  mediaType: 'image/png' as const
                }
              : ref,
        provided = mismatch === 'metadata' ? { ...ref, name: 'different.txt' } : saved
      source.storage.createConversation(identity)
      source.storage.putRecord('c', 1, {
        kind: 'attachment',
        id: `a:${contentHash}`,
        at: 1,
        value: saved
      })
      source.storage.freeze('c', 1, 'move')
      target.storage.stage(source.storage.exportConversation('c', 1, 'move'))
      expect(() => target.attachments.putPrepared('c', 2, provided, bytes)).toThrow(
        /size|type|metadata|match/i
      )
      expect(target.attachments.missing('c')).toHaveLength(1)
    } finally {
      await source.close()
      await target.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('migration verify reports missing attachments as wire refs, not storage records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-missing-')),
    source = createComputerChatRuntime({ stateDir: dir, hubScope: 'source', computerId: 'pc' }),
    target = createComputerChatRuntime({ stateDir: dir, hubScope: 'target', computerId: 'pc' })
  try {
    const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      bytes = Buffer.from('plain text'),
      contentHash = createHash('sha256').update(bytes).digest('hex'),
      ref = {
        artifactId: 'a',
        contentHash,
        name: 'saved.txt',
        size: bytes.length,
        kind: 'text' as const,
        mediaType: 'text/plain' as const
      }
    source.storage.createConversation(identity)
    // Stored attachment records carry their task (legacy source + put() both add it).
    source.storage.putRecord('c', 1, {
      kind: 'attachment',
      id: `a:${contentHash}`,
      at: 1,
      value: { ...ref, taskId: 't' }
    })
    source.storage.freeze('c', 1, 'move')
    target.storage.stage(source.storage.exportConversation('c', 1, 'move'))
    const missing = target.attachments.missing('c')
    // The hub echoes these back as `attachment.put` refs, which the strict schema parses.
    expect(missing.map((m) => chatAttachmentSchema.parse(m))).toEqual([ref])
    target.attachments.putPrepared('c', 2, missing[0]!, bytes)
    expect(target.attachments.missing('c')).toEqual([])
  } finally {
    await source.close()
    await target.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
