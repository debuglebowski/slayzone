import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createStandaloneArtifacts } from './standalone'

test('computer artifact storage preserves folders, editing and binary version history without hub schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-artifacts-')),
    raw = new Database(join(dir, 'chat.sqlite'))
  try {
    const { db, store } = createStandaloneArtifacts(raw, dir)
    const folder = await store.getOrCreateFolderByName(db, { taskId: 't', name: 'Uploads' })
    const bytes = Buffer.from([0, 255, 128, 10]),
      a = await store.uploadArtifactBlob(db, {
        taskId: 't',
        title: 'file.bin',
        bytes,
        folderId: folder!.id
      })
    expect(a?.title).toBe('file.bin')
    const version = await store.getCurrentArtifactVersion(db, { artifactId: a!.id })
    expect(version?.size).toBe(4)
    expect(
      (await store.resolveArtifactVersion(db, { artifactId: a!.id, versionRef: 'current' })).version
        .content_hash
    ).toBe(version!.content_hash)
    await store.updateArtifact(db, { id: a!.id, title: 'note.txt', content: 'edited' })
    expect(await store.readArtifactContent(db, a!.id)).toBe('edited')
    expect(
      (await store.listArtifactVersions(db, { artifactId: a!.id })).length
    ).toBeGreaterThanOrEqual(1)
    expect((await store.listArtifactsByTask(db, 't'))[0].folder_id).toBe(folder!.id)
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()
    ).toBeUndefined()
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
