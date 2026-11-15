import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import { BlobStore } from './blob-store'
import { createStandaloneArtifacts } from './standalone'

// A download reads an artifact in bounded pieces, so no message and no string has to
// hold a whole (possibly multi-GB) file. `null` means "no such artifact or file";
// every other failure is an error the client must surface.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-range-'))
  roots.push(dir)
  return createStandaloneArtifacts(new Database(join(dir, 'data.sqlite')), dir)
}

test('reads any window of the working file and reports the total size', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, {
    taskId: 't',
    title: 'a.txt',
    content: '0123456789'
  }))!
  expect(await store.readArtifactBytesRange(db, a.id, 0, 4)).toMatchObject({
    bytes: new Uint8Array(Buffer.from('0123')),
    size: 10
  })
  expect(await store.readArtifactBytesRange(db, a.id, 8, 100)).toMatchObject({
    bytes: new Uint8Array(Buffer.from('89')),
    size: 10
  })
  expect((await store.readArtifactBytesRange(db, a.id, 10, 4))?.bytes.byteLength).toBe(0)
})

test('falls back to the current version blob when there is no working file', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, { taskId: 't', title: 'b.txt', content: 'blob only' }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const r = await store.readArtifactBytesRange(db, a.id, 5, 4)
  expect(Buffer.from(r!.bytes).toString()).toBe('only')
  expect(r!.size).toBe(9)
})

test('is null for an unknown artifact', async () => {
  const { store, db } = setup()
  expect(await store.readArtifactBytesRange(db, 'nope', 0, 4)).toBeNull()
})

test('a damaged blob is an error, never "not found"', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, { taskId: 't', title: 'c.txt', content: 'intact' }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
  // The hash no longer matches the blob's content.
  writeFileSync(new BlobStore(roots[roots.length - 1]).blobPath(version.content_hash), 'tampered')
  await expect(store.readArtifactBytesRange(db, a.id, 0, 4)).rejects.toThrow()
})

// Review 2, M1: every piece names the exact content it came from, so a client can tell
// a file rewritten between pieces from one that stayed the same.
test('every piece carries a version token that changes when the content does', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, { taskId: 't', title: 'v.txt', content: 'one' }))!
  const p1 = await store.readArtifactBytesRange(db, a.id, 0, 2)
  const p2 = await store.readArtifactBytesRange(db, a.id, 2, 2)
  expect(p1!.version).toBeTruthy()
  expect(p2!.version).toBe(p1!.version)
  writeFileSync((await store.getArtifactPath(db, a.id))!, 'two!')
  expect((await store.readArtifactBytesRange(db, a.id, 0, 2))!.version).not.toBe(p1!.version)
})

test('a blob-backed artifact is versioned by its content hash', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, { taskId: 't', title: 'h.txt', content: 'hash me' }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
  expect((await store.readArtifactBytesRange(db, a.id, 0, 2))!.version).toBe(
    `blob:${version.content_hash}`
  )
})

// Review 8, L8: a download's first piece checks the whole blob's hash. Asking for
// `{offset: 0, length: 1}` again and again must not re-hash a multi-GB blob each time:
// a blob verified once is trusted until its file changes.
test('the whole-blob hash check runs once per unchanged blob, again after it changes', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, {
    taskId: 't',
    title: 'h.txt',
    content: 'hashed once'
  }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const verify = vi.spyOn(BlobStore.prototype, 'verifyAsync')
  try {
    for (let i = 0; i < 5; i++) await store.readArtifactBytesRange(db, a.id, 0, 1)
    expect(verify).toHaveBeenCalledTimes(1)
    // The blob's file changes (damaged on disk): checked again, and refused.
    const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
    const file = new BlobStore(roots[roots.length - 1]).blobPath(version.content_hash)
    writeFileSync(file, 'tampered!!!')
    await expect(store.readArtifactBytesRange(db, a.id, 0, 1)).rejects.toThrow()
    expect(verify).toHaveBeenCalledTimes(2)
  } finally {
    verify.mockRestore()
  }
})
