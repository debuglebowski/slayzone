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
import { get } from 'node:http'
import { setImmediate as turn } from 'node:timers/promises'
import { open } from 'node:fs/promises'
import {
  BYTE_RANGE_MAX_CHUNK,
  readByteRanges,
  type ByteRangePage
} from '@slayzone/platform/bounded-reads'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express, { type Response } from 'express'
import type { ArtifactRangeReader } from '@slayzone/task-artifacts/server'
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
let immutable:
  | {
      file: string
      size: number
      hash: string
      beforeRead?: (offset: number) => Promise<void>
      page?: (page: ByteRangePage) => ByteRangePage
      onFinally?: () => void
    }
  | undefined
let customOpen: (() => ArtifactRangeReader | null) | undefined
let wholeBytes = WHOLE,
  wholeReads = 0,
  activeReads = 0
let lastResponse: Response | undefined
const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  customOpen = undefined
  wholeBytes = WHOLE
  wholeReads = 0
  ranged = true
  vi.restoreAllMocks()
})
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
    if (customOpen) return customOpen()
    if (immutable) return immutableReader(immutable)
    return ranged ? { size: WHOLE.length, missing: false, chunks: chunks() } : null
  },
  readArtifactBytes: async () => {
    wholeReads++
    return wholeBytes
  },
  resolveArtifactVersion: async () => ({
    version: { content_hash: 'h' },
    blobPath: null,
    bytes: WHOLE
  })
} as never)

const app = express()
app.use(express.json())
app.use((_req, res, next) => {
  lastResponse = res
  next()
})
const deps = { db: h.slayDb, notifyRenderer: () => {} }
registerArtifactsContentRoutes(app, deps)
registerArtifactsVersionsRoutes(app, deps)
const rest = await mountRestApp(app)
afterAll(async () => {
  await rest.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function raw(url: string, range?: string) {
  const res = await fetch(rest.url + url, { headers: range ? { Range: range } : {} })
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

function immutableReader(source: NonNullable<typeof immutable>): ArtifactRangeReader {
  const body = readByteRanges(
    async (offset, length) => {
      rangeOffsets.push(offset)
      const file = await open(source.file, 'r')
      activeReads++
      try {
        await source.beforeRead?.(offset)
        const buffer = Buffer.alloc(Math.min(length, source.size - offset))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        const page = {
          data: buffer.subarray(0, bytesRead).toString('base64'),
          offset,
          size: source.size,
          etag: source.hash,
          eof: offset + bytesRead === source.size
        }
        return source.page ? source.page(page) : page
      } finally {
        await file.close()
        activeReads--
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
  return {
    size: source.size,
    missing: false,
    chunks: (async function* () {
      try {
        yield* body
      } finally {
        source.onFinally?.()
      }
    })()
  }
}
function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { wait, release }
}
function nativeSource(size = 600_001) {
  const bytes = Buffer.alloc(size).map((_, i) => i % 251)
  const hash = createHash('sha256').update(bytes).digest('hex'),
    file = path.join(tmpRoot, crypto.randomUUID())
  fs.writeFileSync(file, bytes)
  immutable = { file, size, hash }
  return { bytes, source: immutable }
}
function expectUnwound() {
  expect(activeReads).toBe(0)
  expect(lastResponse!.listenerCount('drain')).toBe(0)
  expect(lastResponse!.listenerCount('error')).toBe(0)
  expect(lastResponse!.listenerCount('close')).toBe(0)
}

// Native file reads beneath readByteRanges exercise the selector and the S11/S12 guards together.
test.each([0, 1, BYTE_RANGE_MAX_CHUNK - 1, BYTE_RANGE_MAX_CHUNK, BYTE_RANGE_MAX_CHUNK + 1])(
  'empty/boundary HTTP selection size=%s closes its iterator and keeps exact bytes',
  async (size) => {
    const { bytes, source } = nativeSource(size)
    let finalized = false
    source.onFinally = () => {
      finalized = true
    }
    try {
      const whole = await raw(`/api/artifacts/${artifactId}/content`)
      expect(whole.status).toBe(200)
      expect(whole.body).toEqual(bytes)
      expect(whole.length).toBe(String(size))
      expect(finalized).toBe(true)
      finalized = false
      const reader = immutableReader(source),
        returned = vi.spyOn(reader.chunks, 'return')
      customOpen = () => reader
      const selected = await raw(`/api/artifacts/${artifactId}/content`, 'bytes=0-0')
      expect(selected.status).toBe(size ? 206 : 416)
      if (size) expect(selected.body).toEqual(bytes.subarray(0, 1))
      expect(returned).toHaveBeenCalled()
      expect(finalized).toBe(size > 0)
      expect(wholeReads).toBe(0)
      expectUnwound()
    } finally {
      immutable = undefined
      fs.unlinkSync(source.file)
    }
  }
)

const selections = [
  'bytes=0-2',
  `bytes=${BYTE_RANGE_MAX_CHUNK - 2}-${BYTE_RANGE_MAX_CHUNK + 2}`,
  'bytes=-3',
  undefined
]
for (const fault of ['corrupt-tail', 'truncate', 'etag', 'size', 'EOF-throw'] as const) {
  test.each(selections)(
    'native ' + fault + ' cannot finish selected Content-Length (Range=%s)',
    async (range) => {
      const { bytes, source } = nativeSource()
      let finalized = false
      source.onFinally = () => {
        finalized = true
      }
      if (fault === 'truncate') fs.truncateSync(source.file, bytes.length - 1)
      if (fault === 'corrupt-tail') {
        const fd = fs.openSync(source.file, 'r+')
        try {
          fs.writeSync(fd, Buffer.from([0xff]), 0, 1, bytes.length - 1)
        } finally {
          fs.closeSync(fd)
        }
      }
      if (fault === 'etag' || fault === 'size')
        source.page = (page) =>
          page.offset
            ? {
                ...page,
                ...(fault === 'etag' ? { etag: 'b'.repeat(64) } : { size: page.size + 1 })
              }
            : page
      if (fault === 'EOF-throw')
        source.page = (page) => {
          if (page.eof) throw new Error('native EOF failed')
          return page
        }
      try {
        const accepted = await raw(`/api/artifacts/${artifactId}/content`, range)
          .then((response) => response.status === (range ? 206 : 200))
          .catch(() => false)
        expect(accepted).toBe(false)
        expect(finalized).toBe(true)
        expectUnwound()
      } finally {
        immutable = undefined
        fs.unlinkSync(source.file)
      }
    }
  )
}

test.each(selections)(
  'selected final bytes stay pending through delayed native tail validation (Range=%s)',
  async (range) => {
    const { bytes, source } = nativeSource(),
      held = gate()
    let entered = false,
      settled = false,
      finalized = false
    source.beforeRead = async (offset) => {
      if (offset >= BYTE_RANGE_MAX_CHUNK * 2) {
        entered = true
        await held.wait
      }
    }
    source.onFinally = () => {
      finalized = true
    }
    const pending = raw(`/api/artifacts/${artifactId}/content`, range).finally(() => {
      settled = true
    })
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      await turn()
      await turn()
      expect(settled).toBe(false)
      expect(activeReads).toBe(1)
      held.release()
      const response = await pending
      const expected =
        range === 'bytes=0-2'
          ? bytes.subarray(0, 3)
          : range?.startsWith('bytes=-')
            ? bytes.subarray(-3)
            : range
              ? bytes.subarray(BYTE_RANGE_MAX_CHUNK - 2, BYTE_RANGE_MAX_CHUNK + 3)
              : bytes
      expect(response.status).toBe(range ? 206 : 200)
      expect(response.body).toEqual(expected)
      expect(finalized).toBe(true)
      expectUnwound()
    } finally {
      held.release()
      await pending.catch(() => undefined)
      immutable = undefined
      fs.unlinkSync(source.file)
    }
  }
)

test('disconnect while skipping unselected native tail drains the held descriptor before quiescence', async () => {
  const { source } = nativeSource(),
    held = gate()
  let entered = false,
    finalized = false
  source.beforeRead = async (offset) => {
    if (offset >= BYTE_RANGE_MAX_CHUNK * 2) {
      entered = true
      await held.wait
    }
  }
  source.onFinally = () => {
    finalized = true
  }
  const request = get(rest.url + `/api/artifacts/${artifactId}/content`, {
    headers: { Range: 'bytes=0-2' }
  })
  request.on('error', () => undefined)
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    request.destroy()
    await vi.waitFor(() => expect(lastResponse!.destroyed).toBe(true))
    expect(activeReads).toBe(1)
    expect(finalized).toBe(false)
    held.release()
    await vi.waitFor(() => expect(finalized).toBe(true))
    expectUnwound()
  } finally {
    request.destroy()
    held.release()
    await vi.waitFor(() => expect(activeReads).toBe(0))
    immutable = undefined
    fs.unlinkSync(source.file)
  }
})

test('real bounded HTTP selection abort during drain closes source and owned listeners', async () => {
  let finalized = false
  const chunk = Buffer.alloc(BYTE_RANGE_MAX_CHUNK, 0x5a)
  customOpen = () => ({
    size: chunk.length * 1024,
    missing: false,
    chunks: (async function* () {
      try {
        for (let i = 0; i < 1024; i++) yield chunk
      } finally {
        finalized = true
      }
    })()
  })
  const request = get(rest.url + `/api/artifacts/${artifactId}/content`)
  request.on('error', () => undefined)
  request.on('response', (res) => res.pause())
  try {
    await vi.waitFor(() => expect(lastResponse!.listenerCount('drain')).toBe(1))
    request.destroy()
    await vi.waitFor(() => expect(finalized).toBe(true))
    expectUnwound()
  } finally {
    request.destroy()
    lastResponse?.emit('drain')
  }
})

test('slow selected native HTTP client receives every byte and leaves no owned stream listeners', async () => {
  const { bytes, source } = nativeSource(BYTE_RANGE_MAX_CHUNK * 8 + 19)
  let finalized = false
  source.onFinally = () => {
    finalized = true
  }
  const start = 3,
    end = bytes.length - 7
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      get(
        rest.url + `/api/artifacts/${artifactId}/content`,
        { headers: { Range: `bytes=${start}-${end - 1}` } },
        (res) => {
          expect(res.statusCode).toBe(206)
          const parts: Buffer[] = []
          res.on('data', (part) => {
            parts.push(part)
            res.pause()
            setImmediate(() => res.resume())
          })
          res.on('end', () => resolve(Buffer.concat(parts)))
          res.on('error', reject)
        }
      ).on('error', reject)
    })
    expect(received).toEqual(bytes.subarray(start, end))
    expect(finalized).toBe(true)
    expectUnwound()
  } finally {
    immutable = undefined
    fs.unlinkSync(source.file)
  }
})

test.each(['unsatisfiable', 'header-error'] as const)(
  'early %s returns the nonempty reader without starting the body',
  async (failure) => {
    let started = false
    const body = (async function* () {
      started = true
      yield Buffer.from('abc')
    })()
    const returned = vi.spyOn(body, 'return')
    customOpen = () => ({ size: 3, missing: false, chunks: body })
    const title = row.title
    try {
      if (failure === 'header-error') row.title = '\ud800'
      const response = await raw(
        `/api/artifacts/${artifactId}/content`,
        failure === 'unsatisfiable' ? 'bytes=3-' : undefined
      )
      expect(response.status).toBe(failure === 'unsatisfiable' ? 416 : 500)
      expect(returned).toHaveBeenCalledTimes(1)
      expect(started).toBe(false)
      expect(wholeReads).toBe(0)
      expectUnwound()
    } finally {
      row.title = title
    }
  }
)
