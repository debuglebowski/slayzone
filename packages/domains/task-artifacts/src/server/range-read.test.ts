import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  expect((await store.readArtifactBytesRange(db, a.id, 0, 2))!.version).toMatch(
    new RegExp(`^blob:${version.content_hash}:`)
  )
})

// Review 9, L7: a blob's version also carries its file's stamp, so a blob file replaced
// between two pieces of one download (same name = same hash) is refused, not spliced.
test("a blob's version changes when its file is replaced between pieces", async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, { taskId: 't', title: 's.txt', content: 'stamp me!' }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const first = (await store.readArtifactBytesRange(db, a.id, 0, 4))!
  const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
  const file = new BlobStore(roots[roots.length - 1]).blobPath(version.content_hash)
  // Replaced (a new inode, the same length), as a hub-disk change would.
  unlinkSync(file)
  writeFileSync(file, 'stomp me!')
  const later = (await store.readArtifactBytesRange(db, a.id, 4, 4))!
  expect(later.version).not.toBe(first.version)
})

test.each(['working', 'blob'] as const)(
  '%s chunks detect a same-inode rewrite with preserved size and mtime',
  async (kind) => {
    const { store, db } = setup()
    const a = (await store.createArtifact(db, {
      taskId: 't',
      title: 'generation.txt',
      content: 'AAAABBBB'
    }))!
    let file = (await store.getArtifactPath(db, a.id))!
    const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
    if (kind === 'blob') {
      unlinkSync(file)
      file = new BlobStore(roots[roots.length - 1]).blobPath(version.content_hash)
    }
    utimesSync(file, 1700000000, 1700000000)
    const before = statSync(file, { bigint: true })
    const first = (await store.readArtifactBytesRange(db, a.id, 0, 4))!
    expect(Buffer.from(first.bytes).toString()).toBe('AAAA')
    expect(
      first.version.startsWith(kind === 'blob' ? `blob:${version.content_hash}:` : 'file:')
    ).toBe(true)
    expect((await store.readArtifactBytesRange(db, a.id, 4, 4))!.version).toBe(first.version)
    writeFileSync(file, 'CCCCDDDD')
    utimesSync(file, 1700000000, 1700000000)
    const after = statSync(file, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.dev).toBe(before.dev)
    expect(after.size).toBe(before.size)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.ctimeNs).not.toBe(before.ctimeNs)
    const second = (await store.readArtifactBytesRange(db, a.id, 4, 4))!
    expect(Buffer.from(second.bytes).toString()).toBe('DDDD')
    expect(second.version).not.toBe(first.version)
    expect((await store.readArtifactBytesRange(db, a.id, 4, 4))!.version).toBe(second.version)
    if (kind === 'blob')
      await expect(store.readArtifactBytesRange(db, a.id, 0, 4)).rejects.toThrow(/integrity/)
  }
)

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

test('verification never blesses a replacement blob that was not hashed', async () => {
  const { store, db } = setup()
  const a = (await store.createArtifact(db, {
    taskId: 't',
    title: 'verify-race.txt',
    content: 'verified body'
  }))!
  unlinkSync((await store.getArtifactPath(db, a.id))!)
  const version = (await store.getCurrentArtifactVersion(db, { artifactId: a.id }))!
  const file = new BlobStore(roots[roots.length - 1]).blobPath(version.content_hash)
  const original = BlobStore.prototype.verifyAsync
  const verify = vi.spyOn(BlobStore.prototype, 'verifyAsync').mockImplementation(async function (
    this: BlobStore,
    ...args
  ) {
    const intact = await original.apply(this, args)
    unlinkSync(file)
    writeFileSync(file, 'unhashed body')
    return intact
  })
  const cache = vi.spyOn(Map.prototype, 'set')
  try {
    await expect(store.readArtifactBytesRange(db, a.id, 0, 4)).rejects.toThrow(/changed|integrity/)
    expect(cache.mock.calls.filter(([key]) => key === file)).toEqual([])
  } finally {
    verify.mockRestore()
    cache.mockRestore()
  }
  // In particular, the failed read must not cache the replacement's pathname stamp.
  await expect(store.readArtifactBytesRange(db, a.id, 0, 4)).rejects.toThrow(/integrity/)
})
