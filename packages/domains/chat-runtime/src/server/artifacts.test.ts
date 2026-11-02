import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

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
