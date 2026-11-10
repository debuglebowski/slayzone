import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, expect, test, vi } from 'vitest'
import { createStandaloneArtifacts } from './standalone'
import { artifactsTxns } from './artifact-store-txns'
import { emulateWindowsFsync } from '../../../../shared/test-utils/windows-fsync'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('working file recovers a published write whose enclosing SQLite transaction rolled back across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-file-recovery-'))
  roots.push(dir)
  const database = join(dir, 'data.sqlite')
  let raw = new Database(database)
  let local = createStandaloneArtifacts(raw, dir)
  const artifact = (await local.store.createArtifact(local.db, {
    taskId: 'task',
    title: 'file.txt',
    content: 'committed original'
  }))!
  const sourcePath = join(dir, 'replacement')
  writeFileSync(sourcePath, 'uncommitted replacement')
  expect(() =>
    raw.transaction(() => {
      artifactsTxns['task-artifacts:versions:write'](raw, {
        dataDir: dir,
        artifactId: artifact.id,
        sourcePath
      })
      throw new Error('crash before outer commit')
    })()
  ).toThrow('crash before outer commit')
  raw.close()
  raw = new Database(database)
  local = createStandaloneArtifacts(raw, dir)
  try {
    expect(await local.store.readArtifactContent(local.db, artifact.id)).toBe('committed original')
    expect(
      await local.store.readArtifactVersion(local.db, {
        artifactId: artifact.id,
        versionRef: 'current'
      })
    ).toBe('committed original')
    expect(readFileSync((await local.store.getArtifactPath(local.db, artifact.id))!, 'utf8')).toBe(
      'committed original'
    )
  } finally {
    raw.close()
  }
})

test('working file recovers extension rename rollback and preserves later external edits after commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-rename-recovery-'))
  roots.push(dir)
  const raw = new Database(join(dir, 'data.sqlite'))
  const local = createStandaloneArtifacts(raw, dir)
  try {
    const artifact = (await local.store.createArtifact(local.db, {
      taskId: 'task',
      title: 'file.txt',
      content: 'original'
    }))!
    const oldPath = (await local.store.getArtifactPath(local.db, artifact.id))!
    expect(() =>
      raw.transaction(() => {
        artifactsTxns['task-artifacts:update'](raw, {
          dataDir: dir,
          id: artifact.id,
          title: 'file.md',
          setKeys: ['title']
        })
        throw new Error('rename rollback')
      })()
    ).toThrow('rename rollback')
    expect(await local.store.readArtifactContent(local.db, artifact.id)).toBe('original')
    expect(existsSync(oldPath)).toBe(true)
    await local.store.updateArtifact(local.db, { id: artifact.id, content: 'committed edit' })
    writeFileSync(oldPath, 'external editor edit')
    expect(await local.store.readArtifactContent(local.db, artifact.id)).toBe(
      'external editor edit'
    )
  } finally {
    raw.close()
  }
})

test('two prunes inside a rolled-back outer transaction preserve every historical blob across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-prune-outer-rollback-'))
  roots.push(dir)
  const database = join(dir, 'data.sqlite')
  let raw = new Database(database),
    local = createStandaloneArtifacts(raw, dir)
  const artifact = (await local.store.createArtifact(local.db, {
    taskId: 'task',
    title: 'file.txt',
    content: 'A'
  }))!
  await local.store.updateArtifact(local.db, { id: artifact.id, content: 'B' })
  await local.store.updateArtifact(local.db, { id: artifact.id, content: 'C' })
  expect(() =>
    raw.transaction(() => {
      artifactsTxns['task-artifacts:versions:prune'](raw, {
        dataDir: dir,
        artifactId: artifact.id,
        keepLast: 2
      })
      artifactsTxns['task-artifacts:versions:prune'](raw, {
        dataDir: dir,
        artifactId: artifact.id,
        keepLast: 1
      })
      throw new Error('outer rollback')
    })()
  ).toThrow('outer rollback')
  raw.close()
  raw = new Database(database)
  local = createStandaloneArtifacts(raw, dir)
  try {
    for (const [versionRef, content] of [
      [1, 'A'],
      [2, 'B'],
      [3, 'C']
    ] as const)
      expect(
        await local.store.readArtifactVersion(local.db, { artifactId: artifact.id, versionRef })
      ).toBe(content)
  } finally {
    raw.close()
  }
})

test('rollback recovery preserves external working-file edits made after the failed publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-file-external-recovery-'))
  roots.push(dir)
  const database = join(dir, 'data.sqlite')
  let raw = new Database(database),
    local = createStandaloneArtifacts(raw, dir)
  const artifact = (await local.store.createArtifact(local.db, {
    taskId: 'task',
    title: 'file.txt',
    content: 'committed A'
  }))!
  const currentPath = (await local.store.getArtifactPath(local.db, artifact.id))!
  const sourcePath = join(dir, 'replacement')
  writeFileSync(sourcePath, 'failed B')
  expect(() =>
    raw.transaction(() => {
      artifactsTxns['task-artifacts:versions:write'](raw, {
        dataDir: dir,
        artifactId: artifact.id,
        sourcePath
      })
      throw new Error('outer rollback')
    })()
  ).toThrow('outer rollback')
  writeFileSync(currentPath, 'later external C')
  raw.close()
  raw = new Database(database)
  local = createStandaloneArtifacts(raw, dir)
  try {
    expect(await local.store.readArtifactContent(local.db, artifact.id)).toBe('later external C')
    expect(
      await local.store.readArtifactVersion(local.db, {
        artifactId: artifact.id,
        versionRef: 'current'
      })
    ).toBe('committed A')
  } finally {
    raw.close()
  }
})

test('renaming an original preserves bytes without buffering the entire existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-rename-bounded-memory-'))
  roots.push(dir)
  const raw = new Database(':memory:'),
    local = createStandaloneArtifacts(raw, dir)
  const artifact = (await local.store.createArtifact(local.db, {
    taskId: 'task',
    title: 'file.txt',
    content: 'original bytes'
  }))!
  const oldPath = (await local.store.getArtifactPath(local.db, artifact.id))!,
    newPath = oldPath.replace(/\.txt$/, '.md')
  const spy = vi.spyOn(fs, 'readFileSync')
  syncBuiltinESMExports()
  try {
    await local.store.updateArtifact(local.db, { id: artifact.id, title: 'file.md' })
    const buffered = spy.mock.calls.filter(
      ([file]) => String(file) === oldPath || String(file) === newPath
    )
    expect(buffered).toEqual([])
  } finally {
    spy.mockRestore()
    syncBuiltinESMExports()
    raw.close()
  }
  expect(readFileSync(newPath, 'utf8')).toBe('original bytes')
})

test('Windows flush semantics: create, import from a read-only source, write and rename all publish', async () => {
  // FlushFileBuffers needs a writable handle; a read-only open made every save EPERM on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'artifact-windows-fsync-'))
  roots.push(dir)
  const raw = new Database(join(dir, 'data.sqlite')),
    local = createStandaloneArtifacts(raw, dir)
  const sourceDir = join(dir, 'import'),
    source = join(sourceDir, 'read-only-upload.txt')
  mkdirSync(sourceDir)
  writeFileSync(source, 'uploaded bytes')
  chmodSync(source, 0o444)
  const restore = emulateWindowsFsync()
  try {
    const created = (await local.store.createArtifact(local.db, {
      taskId: 'task',
      title: 'notes.txt',
      content: 'created bytes'
    }))!
    await local.store.updateArtifact(local.db, { id: created.id, content: 'updated bytes' })
    await local.store.writeArtifactContent(local.db, {
      artifactId: created.id,
      bytes: Buffer.from('written bytes')
    })
    await local.store.updateArtifact(local.db, { id: created.id, title: 'notes.md' })
    expect(await local.store.readArtifactContent(local.db, created.id)).toBe('written bytes')
    const {
      artifacts: [uploaded]
    } = await local.store.uploadArtifactDir(local.db, {
      taskId: 'task',
      dirPath: sourceDir,
      parentFolderId: null
    })
    // The working copy must stay replaceable: a read-only file cannot be flushed or renamed over on Windows.
    await local.store.writeArtifactContent(local.db, {
      artifactId: uploaded.id,
      bytes: Buffer.from('replaced upload')
    })
    expect(await local.store.readArtifactContent(local.db, uploaded.id)).toBe('replaced upload')
    const uploadedPath = (await local.store.getArtifactPath(local.db, uploaded.id))!
    expect(statSync(uploadedPath).mode & 0o200).toBe(0o200)
  } finally {
    restore()
    raw.close()
  }
})

test('one corrupt working-copy journal is quarantined; recovery, writes and task cleanup go on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-corrupt-journal-'))
  roots.push(dir)
  const raw = new Database(join(dir, 'data.sqlite'))
  const local = createStandaloneArtifacts(raw, dir)
  try {
    const keep = (await local.store.createArtifact(local.db, {
      taskId: 'task',
      title: 'keep.txt',
      content: 'v1'
    }))!
    const journals = join(dir, 'artifacts', '.transactions')
    const torn = join(journals, '00000000-0000-4000-8000-000000000001')
    mkdirSync(torn, { recursive: true })
    writeFileSync(join(torn, 'manifest.json'), '{"taskId":"other-task","artifa')
    writeFileSync(join(torn, 'before'), 'other task bytes')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Every artifact mutation recovers journals first: it must not be blocked.
    await local.store.updateArtifact(local.db, { id: keep.id, content: 'v2' })
    expect(await local.store.readArtifactContent(local.db, keep.id)).toBe('v2')
    expect(existsSync(torn)).toBe(false)
    const { listQuarantine, eraseQuarantinedForTask } = await import(
      '@slayzone/platform/quarantine'
    )
    expect(listQuarantine(dir)).toMatchObject([{ pass: 'artifact-file-journal' }])
    // Deleting an unrelated task works; erasing the task the bytes name deletes them.
    local.store.cleanupTaskArtifacts('task')
    expect(eraseQuarantinedForTask(dir, 'other-task')).toBe(1)
    expect(listQuarantine(dir)).toEqual([])
  } finally {
    vi.restoreAllMocks()
    raw.close()
  }
})
