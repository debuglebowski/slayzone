import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { createStandaloneArtifacts } from './standalone'
import { artifactsTxns } from './artifact-store-txns'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-move-'))
  roots.push(dir)
  const raw = new Database(join(dir, 'data.sqlite'))
  return { dir, raw, ...createStandaloneArtifacts(raw, dir) }
}

test('moves artifacts and folder subtrees to another task, keeping ids, versions and working copies', async () => {
  const { raw, db, store } = setup()
  try {
    const folder = (await store.createFolder(db, { taskId: 'src', name: 'Docs' }))!
    const nested = (await store.createFolder(db, {
      taskId: 'src',
      name: 'Nested',
      parentId: folder.id
    }))!
    const inNested = (await store.createArtifact(db, {
      taskId: 'src',
      title: 'deep.md',
      folderId: nested.id,
      content: 'v1'
    }))!
    await store.updateArtifact(db, { id: inNested.id, content: 'v2' })
    const loose = (await store.createArtifact(db, {
      taskId: 'src',
      title: 'loose.txt',
      content: 'loose'
    }))!
    const stays = (await store.createArtifact(db, {
      taskId: 'src',
      title: 'stay.txt',
      content: 's'
    }))!
    const destFolder = (await store.createFolder(db, { taskId: 'dst', name: 'Inbox' }))!
    await store.createArtifact(db, {
      taskId: 'dst',
      title: 'existing.txt',
      folderId: destFolder.id,
      content: 'e'
    })
    const oldPath = (await store.getArtifactPath(db, inNested.id))!

    const result = await store.moveArtifacts(db, {
      artifactIds: [loose.id],
      folderIds: [folder.id],
      sourceTaskId: 'src',
      destTaskId: 'dst',
      destFolderId: destFolder.id
    })

    expect(result.artifacts.map((a) => a.id).sort()).toEqual([inNested.id, loose.id].sort())
    expect(result.folders.map((f) => f.id).sort()).toEqual([folder.id, nested.id].sort())
    const movedFolder = (await store.listFoldersByTask(db, 'dst')).find((f) => f.id === folder.id)!
    expect(movedFolder.parent_id).toBe(destFolder.id)
    const movedNested = (await store.listFoldersByTask(db, 'dst')).find((f) => f.id === nested.id)!
    expect(movedNested.parent_id).toBe(folder.id)
    const deep = (await store.getArtifact(db, inNested.id))!
    expect(deep).toMatchObject({ task_id: 'dst', folder_id: nested.id })
    const looseMoved = (await store.getArtifact(db, loose.id))!
    // Appended after the destination folder's existing entry.
    expect(looseMoved).toMatchObject({ task_id: 'dst', folder_id: destFolder.id, order: 1 })
    expect((await store.listArtifactVersions(db, { artifactId: inNested.id })).length).toBe(2)
    expect(await store.readArtifactContent(db, inNested.id)).toBe('v2')
    const newPath = (await store.getArtifactPath(db, inNested.id))!
    expect(newPath).not.toBe(oldPath)
    expect(readFileSync(newPath, 'utf8')).toBe('v2')
    expect(existsSync(oldPath)).toBe(false)
    expect((await store.getArtifact(db, stays.id))!.task_id).toBe('src')
    expect(await store.listFoldersByTask(db, 'src')).toEqual([])

    // Retrying a completed move is a no-op.
    const again = await store.moveArtifacts(db, {
      artifactIds: [loose.id],
      folderIds: [folder.id],
      sourceTaskId: 'src',
      destTaskId: 'dst',
      destFolderId: destFolder.id
    })
    expect(again).toEqual({ artifacts: [], folders: [] })
    expect((await store.getArtifact(db, loose.id))!.order).toBe(1)
  } finally {
    raw.close()
  }
})

test('a rolled-back move restores the working copy in the source task', async () => {
  const { dir, raw, db, store } = setup()
  try {
    const a = (await store.createArtifact(db, { taskId: 'src', title: 'a.txt', content: 'A' }))!
    const oldPath = (await store.getArtifactPath(db, a.id))!
    expect(() =>
      raw.transaction(() => {
        artifactsTxns['task-artifacts:move'](raw, {
          dataDir: dir,
          artifactIds: [a.id],
          folderIds: [],
          sourceTaskId: 'src',
          destTaskId: 'dst',
          destFolderId: null
        })
        throw new Error('rollback')
      })()
    ).toThrow('rollback')
    expect((await store.getArtifact(db, a.id))!.task_id).toBe('src')
    expect(await store.readArtifactContent(db, a.id)).toBe('A')
    expect(readFileSync(oldPath, 'utf8')).toBe('A')
    const destDir = join(dir, 'artifacts', 'dst')
    expect(existsSync(destDir) ? readdirSync(destDir) : []).toEqual([])
  } finally {
    raw.close()
  }
})

test('refuses moves that would split or misplace entries', async () => {
  const { raw, db, store } = setup()
  try {
    const a = (await store.createArtifact(db, { taskId: 'src', title: 'a.txt', content: 'A' }))!
    const b = (await store.createArtifact(db, { taskId: 'other', title: 'b.txt', content: 'B' }))!
    const foreign = (await store.createFolder(db, { taskId: 'other', name: 'F' }))!
    const move = (input: Partial<Parameters<typeof store.moveArtifacts>[1]>) =>
      store.moveArtifacts(db, {
        artifactIds: [a.id],
        folderIds: [],
        sourceTaskId: 'src',
        destTaskId: 'dst',
        destFolderId: null,
        ...input
      })
    await expect(move({ destFolderId: foreign.id })).rejects.toThrow(/destination folder/i)
    await expect(move({ artifactIds: [a.id, b.id] })).rejects.toThrow(/one task/i)
    await expect(move({ sourceTaskId: 'dst', destTaskId: 'dst' })).rejects.toThrow(/same task/i)
    await expect(move({ artifactIds: ['missing'] })).rejects.toThrow(/not found/i)
    expect((await store.getArtifact(db, a.id))!.task_id).toBe('src')
  } finally {
    raw.close()
  }
})
