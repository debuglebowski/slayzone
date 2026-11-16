/**
 * Staged uploads (FU1 S3): a hub sends a file's bytes to this computer in chunks
 * (≤ 256 KiB each, base64 within one frame), keyed by the bytes' sha256. Resumable
 * (begin answers how much is here), strictly in order, never past the declared
 * size; taken only when complete and hash-verified; removed after use; leftovers
 * swept once stale. What uses the staged bytes (an artifact upload, an attachment)
 * applies every check it applies to inline bytes.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { createUploadStaging } from './upload-staging'

const dirs: string[] = []
const stores: ReturnType<typeof createUploadStaging>[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fresh = (opts?: Parameters<typeof createUploadStaging>[1]) => {
  const dir = mkdtempSync(join(tmpdir(), 'upload-staging-'))
  dirs.push(dir)
  const s = createUploadStaging(dir, opts)
  stores.push(s)
  return s
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const BYTES = randomBytes(BYTE_RANGE_MAX_CHUNK * 2 + 10)
const HASH = sha(BYTES)
const chunks = (b: Buffer) => {
  const out: Array<{ offset: number; bytes: Buffer }> = []
  for (let o = 0; o < b.length; o += BYTE_RANGE_MAX_CHUNK)
    out.push({ offset: o, bytes: b.subarray(o, o + BYTE_RANGE_MAX_CHUNK) })
  return out
}

describe('upload staging', () => {
  it('begin, chunks in order, take: the exact bytes; release removes them', async () => {
    const s = fresh()
    expect(await s.begin(HASH, BYTES.length)).toEqual({ received: 0 })
    for (const c of chunks(BYTES)) await s.chunk(HASH, BYTES.length, c.offset, c.bytes)
    const taken = await s.take(HASH, BYTES.length)
    expect(readFileSync(taken.path).equals(BYTES)).toBe(true)
    await s.release(HASH, BYTES.length)
    expect(existsSync(taken.path)).toBe(false)
  })

  it('resumable: begin answers what is here', async () => {
    const s = fresh()
    await s.begin(HASH, BYTES.length)
    const [first] = chunks(BYTES)
    await s.chunk(HASH, BYTES.length, 0, first.bytes)
    expect(await s.begin(HASH, BYTES.length)).toEqual({ received: first.bytes.length })
  })

  it('refuses a chunk out of order, past the size, or over one range; and a chunk before begin', async () => {
    const s = fresh()
    await expect(s.chunk(HASH, BYTES.length, 0, BYTES.subarray(0, 10))).rejects.toThrow(/begin/)
    await s.begin(HASH, BYTES.length)
    await expect(s.chunk(HASH, BYTES.length, 5, BYTES.subarray(5, 10))).rejects.toThrow(/offset/)
    await expect(
      s.chunk(HASH, BYTES.length, 0, randomBytes(BYTE_RANGE_MAX_CHUNK + 1))
    ).rejects.toThrow(/chunk/)
    const small = Buffer.from('abc')
    await s.begin(sha(small), 3)
    await expect(s.chunk(sha(small), 3, 0, Buffer.from('abcd'))).rejects.toThrow(/size/)
  })

  it('take refuses an incomplete upload and bytes that do not hash to their name', async () => {
    const s = fresh()
    await s.begin(HASH, BYTES.length)
    await expect(s.take(HASH, BYTES.length)).rejects.toThrow(/incomplete/)
    const wrong = Buffer.from('not what the name says')
    const lie = sha(Buffer.from('something else'))
    await s.begin(lie, wrong.length)
    await s.chunk(lie, wrong.length, 0, wrong)
    await expect(s.take(lie, wrong.length)).rejects.toThrow(/hash/)
    await expect(s.take(sha(Buffer.from('never begun')), 3)).rejects.toThrow(/not staged/)
  })

  it('a completed upload begun again is already complete (idempotent retries)', async () => {
    const s = fresh()
    await s.begin(HASH, BYTES.length)
    for (const c of chunks(BYTES)) await s.chunk(HASH, BYTES.length, c.offset, c.bytes)
    expect(await s.begin(HASH, BYTES.length)).toEqual({ received: BYTES.length })
  })

  it('sweeps uploads left stale', async () => {
    let now = 0
    const s = fresh({ now: () => now, staleMs: 1000 })
    await s.begin(HASH, BYTES.length)
    now = 2000
    await s.sweep()
    expect(await s.begin(HASH, BYTES.length)).toEqual({ received: 0 })
  })

  it('refuses a malformed hash or size', async () => {
    const s = fresh()
    await expect(s.begin('../x', 3)).rejects.toThrow(/hash/)
    await expect(s.begin(HASH, -1)).rejects.toThrow(/size/)
  })
})

describe('staged bytes in use (computer runtime)', () => {
  it('an artifact upload and a content write take staged bytes larger than any inline frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upload-staged-use-'))
    dirs.push(dir)
    const { createComputerChatRuntime } = await import('./computer-runtime')
    const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
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
      // Over the 14,000,000-char inline cap once base64'd.
      const big = randomBytes(11 * 1024 * 1024)
      const stage = async (b: Buffer, operationId: string) => {
        const { uploadId } = await r.uploads.begin(sha(b), b.length, { route, operationId })
        for (const c of chunks(b))
          await r.uploads.chunk(sha(b), b.length, c.offset, c.bytes, { route, uploadId: uploadId! })
        return { sha256: sha(b), size: b.length, uploadId }
      }
      const staged = await stage(big, 'staged-up')
      const a = (await r.artifacts.invoke({
        route,
        method: 'uploadArtifactBlob',
        operationId: 'staged-up',
        args: [{ taskId: 't', title: 'big.bin', staged }]
      })) as { id: string }
      const read = (await r.artifacts.invoke({ route, method: 'readBytes', args: [a.id] })) as {
        data: string
      }
      expect(Buffer.from(read.data, 'base64').equals(big)).toBe(true)
      // Used up: a second use must send it again.
      await expect(r.uploads.acquire(staged, route)).rejects.toThrow(/not staged/)

      const next = Buffer.from('written through staging')
      const written = await stage(next, 'staged-write')
      await r.artifacts.invoke({
        route,
        method: 'writeArtifactContent',
        operationId: 'staged-write',
        args: [{ artifactId: a.id, staged: written }]
      })
      expect(await r.artifacts.invoke({ route, method: 'readArtifactContent', args: [a.id] })).toBe(
        'written through staging'
      )
      // An upload names inline data or staged bytes, never both or neither.
      await expect(
        r.artifacts.invoke({
          route,
          method: 'uploadArtifactBlob',
          operationId: 'neither',
          args: [{ taskId: 't', title: 'x' }]
        })
      ).rejects.toThrow()
    } finally {
      await r.close()
    }
  })
})
