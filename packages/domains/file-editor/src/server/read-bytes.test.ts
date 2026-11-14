/**
 * Raw byte reads of a workspace file, a slice at a time — what the hub's
 * `GET /api/files/raw` streams a preview (image, PDF, HTML) from. Binary-exact,
 * contained to the root, never a directory, never the whole file at once.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPathTraversalError, readBytesAt, WORKSPACE_READ_BYTES_MAX_CHUNK } from './file-ops'
import { createLocalWorkspaceFsAdapters } from './workspace-fs'

let dir: string
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x7f])

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fe-read-bytes-')))
  mkdirSync(join(dir, 'img'))
  writeFileSync(join(dir, 'img', 'a.png'), BYTES)
  utimesSync(join(dir, 'img', 'a.png'), 1_700_000_000, 1_700_000_000)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readBytesAt', () => {
  it('reads exactly the requested slice, with the whole file size and mtime', async () => {
    const r = await readBytesAt(join(dir, 'img', 'a.png'), 2, 4)
    expect(Buffer.from(r.bytes)).toEqual(BYTES.subarray(2, 6))
    expect(r.size).toBe(BYTES.length)
    expect(r.mtimeMs).toBe(1_700_000_000_000)
    expect(r.eof).toBe(false)
  })

  it('clamps a slice past the end and reports eof', async () => {
    const r = await readBytesAt(join(dir, 'img', 'a.png'), 8, 100)
    expect(Buffer.from(r.bytes)).toEqual(BYTES.subarray(8))
    expect(r.eof).toBe(true)
    const past = await readBytesAt(join(dir, 'img', 'a.png'), 50, 10)
    expect(past.bytes.length).toBe(0)
    expect(past.eof).toBe(true)
  })

  it('refuses a directory (EISDIR) and a missing file (ENOENT)', async () => {
    await expect(readBytesAt(join(dir, 'img'), 0, 1)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(readBytesAt(join(dir, 'nope.png'), 0, 1)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses a length above the chunk cap', async () => {
    await expect(
      readBytesAt(join(dir, 'img', 'a.png'), 0, WORKSPACE_READ_BYTES_MAX_CHUNK + 1)
    ).rejects.toThrow(/length/)
  })
})

describe('LocalWorkspaceFs.readBytes (through the local adapters)', () => {
  const fs = createLocalWorkspaceFsAdapters()

  it('reads a root-relative file', async () => {
    const r = await fs.readBytes(null, dir, 'img/a.png', 0, 64)
    expect(Buffer.from(r.bytes)).toEqual(BYTES)
    expect(r.eof).toBe(true)
  })

  it('refuses a path that leaves the root with a PathTraversalError', async () => {
    const err = await fs.readBytes(null, join(dir, 'img'), '../../etc/hosts', 0, 1).then(
      () => null,
      (e: unknown) => e
    )
    expect(isPathTraversalError(err)).toBe(true)
    expect((err as Error).message).toMatch(/traversal/i)
  })
})
