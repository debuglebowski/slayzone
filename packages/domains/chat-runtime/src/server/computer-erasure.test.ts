import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

test('computer erasure verifies local history, originals and sealed files while preserving another task', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'computer-erasure-'))
  let r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
  try {
    const files: Record<string, { id: string; hash: string }> = {}
    for (const taskId of ['alice', 'bob']) {
      r.bootstrap({
        identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: stateDir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
      const bytes = Buffer.from(`${taskId} private original`)
      const a = (await r.artifacts.invoke({
        route: { id: taskId, epoch: 1 },
        method: 'uploadArtifactBlob',
        args: [{ taskId, title: 'private.txt', data: bytes.toString('base64') }],
        operationId: `upload-${taskId}`
      })) as { id: string; title: string }
      const ref = await r.artifacts.seal(taskId, {
        artifactId: a.id,
        name: a.title,
        kind: 'text',
        mediaType: 'text/plain',
        size: bytes.length
      })
      files[taskId] = { id: a.id, hash: ref.contentHash! }
      r.storage.append(
        taskId,
        1,
        { kind: 'assistant-text', messageId: taskId, text: `${taskId} secret` },
        Date.now()
      )
    }
    const backup = await r.backups.create('manual')
    const archive = await r.backups.restore(backup.id)
    const lease = r.storage.acquireBlobLease('test', 60000)
    // The normal lifecycle push can arrive before the verified erase request.
    await r.applyTaskLifecycle('alice', 'deleted', 2)
    await expect(r.eraseTask('alice', 2)).rejects.toThrow(/lease|backup/i)
    lease.release()
    await r.close()
    r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
    expect(await r.eraseTask('alice', 2)).toEqual({ taskId: 'alice', revision: 2, erased: true })
    expect(existsSync(join(r.storage.dir, 'artifacts', 'alice'))).toBe(false)
    expect(existsSync(join(r.storage.dir, 'blobs', files.alice.hash))).toBe(false)
    expect(r.storage.read('alice', -1)).toEqual([])
    expect(r.storage.read('bob', -1)).toHaveLength(1)
    expect(r.backups.conversations(archive.id).some((c) => c.taskId === 'alice')).toBe(false)
    expect(r.backups.conversations(archive.id).some((c) => c.taskId === 'bob')).toBe(true)
    expect(r.backups.list().some((b) => b.id === backup.id)).toBe(true)
    expect(
      readFileSync(join(r.storage.dir, 'chat.sqlite')).includes(Buffer.from('alice secret'))
    ).toBe(false)
    expect(() =>
      r.storage.append(
        'alice',
        1,
        { kind: 'assistant-text', messageId: 'late', text: 'late secret' },
        Date.now()
      )
    ).toThrow()
  } finally {
    await r.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
