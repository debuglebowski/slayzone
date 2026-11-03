import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { emulateWindowsFsync } from '../../../../shared/test-utils/windows-fsync'
import { createComputerChatRuntime } from './computer-runtime'

// FlushFileBuffers needs a writable handle; read-only opens made these file syncs EPERM on Windows.
test('Windows flush semantics: computer artifact writes, backup and restore all complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-windows-fsync-')),
    r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  const restore = emulateWindowsFsync()
  try {
    r.bootstrap({
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: 'c', epoch: 1 }
    const artifact = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [
        { taskId: 'task', title: 'notes.txt', data: Buffer.from('uploaded').toString('base64') }
      ]
    })) as { id: string }
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      operationId: randomUUID(),
      args: [{ id: artifact.id, content: 'edited' }]
    })
    expect(
      await r.artifacts.invoke({ route, method: 'readArtifactContent', args: [artifact.id] })
    ).toBe('edited')
    // A user may mark the working file read-only; the backup's private copy must still flush.
    const working = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith(`${artifact.id}.txt`) && !file.includes('.transactions'))
      .map((file) => join(dir, file))
    expect(working).toHaveLength(1)
    chmodSync(working[0], 0o444)
    const backup = await r.backups.create('manual')
    chmodSync(working[0], 0o600)
    const archive = await r.backups.restore(backup.id)
    expect(r.backups.listArchives()).toMatchObject([{ id: archive.id }])
  } finally {
    restore()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
