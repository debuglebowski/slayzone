/**
 * REST streams a computer-held artifact's bytes range by range (FU1 S2): when the
 * hub's store can open a ranged reader (`openArtifactReader`, a computer that
 * answers bounded reads), `GET /api/artifacts/:id/content` and
 * `GET /api/artifacts/:id/versions/content` write each range as it arrives with the
 * whole size up front — the hub never assembles the file. Without one (an older
 * computer) the whole read answers, as before.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/artifacts/stream-ranges.test.ts
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { BYTE_RANGE_MAX_CHUNK, readByteRanges } from '@slayzone/platform/bounded-reads'
import { afterAll, describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express from 'express'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifact-stream-'))
process.env.SLAYZONE_ROOT = tmpRoot

const { getArtifactsDataRoot } = await import('./shared.js')
const { setArtifactStorage } = await import('@slayzone/task-artifacts/server')
const { registerArtifactsContentRoutes } = await import('./content.js')
const { registerArtifactsVersionsRoutes } = await import('./versions.js')

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'T', 'todo', 3, 0)
const artifactId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)')
  .run(artifactId, taskId, 'big.bin', 0)

const CHUNKS = [Buffer.from('first-'), Buffer.from('second-'), Buffer.from('third')]
const WHOLE = Buffer.concat(CHUNKS)
let ranged = true
let immutable: { file: string; size: number; hash: string } | undefined
const rangeOffsets: number[] = []
const opened: unknown[] = []

async function* chunks() {
  for (const c of CHUNKS) yield new Uint8Array(c)
}
const row = {
  id: artifactId,
  task_id: taskId,
  title: 'big.bin',
  storage: { computerId: 'pc', available: true }
}
setArtifactStorage(getArtifactsDataRoot(), {
  getArtifact: async () => row,
  openArtifactReader: async (_db: unknown, id: string, spec: unknown) => {
    opened.push({ id, spec })
    if (immutable) {
      const source = immutable
      return {
        size: source.size,
        missing: false,
        chunks: readByteRanges(
          async (offset, length) => {
            rangeOffsets.push(offset)
            const file = await open(source.file, 'r')
            try {
              const buffer = Buffer.alloc(Math.min(length, source.size - offset))
              const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
              return {
                data: buffer.subarray(0, bytesRead).toString('base64'),
                offset,
                size: source.size,
                etag: source.hash,
                eof: offset + bytesRead === source.size
              }
            } finally {
              await file.close()
            }
          },
          {
            sha256: {
              expect: 'etag',
              create: () => {
                const hash = createHash('sha256')
                return {
                  update: (b) => {
                    hash.update(b)
                  },
                  digest: () => hash.digest('hex')
                }
              }
            }
          }
        )
      }
    }
    return ranged ? { size: WHOLE.length, missing: false, chunks: chunks() } : null
  },
  readArtifactBytes: async () => WHOLE,
  resolveArtifactVersion: async () => ({
    version: { content_hash: 'h' },
    blobPath: null,
    bytes: WHOLE
  })
} as never)

const app = express()
app.use(express.json())
const deps = { db: h.slayDb, notifyRenderer: () => {} }
registerArtifactsContentRoutes(app, deps)
registerArtifactsVersionsRoutes(app, deps)
const rest = await mountRestApp(app)
afterAll(async () => {
  await rest.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function raw(url: string) {
  const res = await fetch(rest.url + url)
  return {
    status: res.status,
    length: res.headers.get('content-length'),
    body: Buffer.from(await res.arrayBuffer())
  }
}

describe('computer-held artifact bytes over REST', () => {
  test('content streams the ranges, sized up front', async () => {
    opened.length = 0
    ranged = true
    const r = await raw(`/api/artifacts/${artifactId}/content`)
    expect(r.status).toBe(200)
    expect(r.body.equals(WHOLE)).toBe(true)
    expect(r.length).toBe(String(WHOLE.length))
    expect(opened).toEqual([{ id: artifactId, spec: { kind: 'bytes' } }])
  })

  test('a version streams the ranges', async () => {
    opened.length = 0
    ranged = true
    const r = await raw(`/api/artifacts/${artifactId}/versions/content?ref=1`)
    expect(r.status).toBe(200)
    expect(r.body.equals(WHOLE)).toBe(true)
    expect(opened).toEqual([{ id: artifactId, spec: { kind: 'version', ref: '1' } }])
  })

  test('an older computer (no ranged reader): the whole read, as before', async () => {
    ranged = false
    expect((await raw(`/api/artifacts/${artifactId}/content`)).body.equals(WHOLE)).toBe(true)
    expect(
      (await raw(`/api/artifacts/${artifactId}/versions/content?ref=1`)).body.equals(WHOLE)
    ).toBe(true)
    ranged = true
  })

  test.each([23, BYTE_RANGE_MAX_CHUNK * 2, 600_000])(
    'HTTP client cannot accept a corrupt immutable version as complete (size=%s)',
    async (size) => {
      const bytes = Buffer.alloc(size, 0x5a)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const file = path.join(tmpRoot, hash)
      fs.writeFileSync(file, bytes)
      // Same name and size as the immutable blob; only its final byte is corrupted.
      const fd = fs.openSync(file, 'r+')
      fs.writeSync(fd, Buffer.from([0xff]), 0, 1, size - 1)
      fs.closeSync(fd)
      immutable = { file, size, hash }
      rangeOffsets.length = 0
      try {
        const accepted = await raw(`/api/artifacts/${artifactId}/versions/content?ref=1`).then(
          (r) => r.status === 200 && r.body.length === size,
          () => false
        )
        expect(accepted).toBe(false)
        expect(rangeOffsets).toEqual(
          Array.from(
            { length: Math.ceil(size / BYTE_RANGE_MAX_CHUNK) },
            (_, i) => i * BYTE_RANGE_MAX_CHUNK
          )
        )
      } finally {
        immutable = undefined
        fs.unlinkSync(file)
      }
    }
  )

  test('an intact immutable version remains byte-exact over real HTTP', async () => {
    const bytes = Buffer.alloc(600_000).map((_, i) => i % 251)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const file = path.join(tmpRoot, hash)
    fs.writeFileSync(file, bytes)
    immutable = { file, size: bytes.length, hash }
    try {
      const response = await raw(`/api/artifacts/${artifactId}/versions/content?ref=1`)
      expect(response.status).toBe(200)
      expect(response.length).toBe(String(bytes.length))
      expect(response.body).toEqual(bytes)
    } finally {
      immutable = undefined
      fs.unlinkSync(file)
    }
  })
})
