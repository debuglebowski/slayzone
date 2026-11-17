/**
 * A computer-held artifact read through the hub in ranges (FU1 S2). Against a
 * computer that answers bounded reads (`boundedReads`), every byte read — bytes,
 * the editor's text, a version, a diff's two sides, the data URL — goes as
 * `readRange` requests of at most 256 KiB each, never one whole-file reply, and
 * answers exactly what the whole reads answer. An older computer gets the whole
 * reads, as before. REST can stream the ranges (`openArtifactReader`).
 */
import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import express from 'express'
import { mkdtempSync, realpathSync, rmSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import {
  artifactsRouter,
  getArtifactStorage,
  setArtifactStorage,
  createArtifactStore
} from '@slayzone/task-artifacts/server'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { runWithRequestAbort } from '@slayzone/platform/request-abort'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { openArtifactReaderOf } from '@slayzone/task-artifacts/server'
import { createComputerArtifactStorage } from './computer-artifacts'
import { registerArtifactsContentRoutes } from '../../api/src/http/rest-api/artifacts/content'
import { getArtifactsDataRoot } from '../../api/src/http/rest-api/artifacts/shared'
import { mountRestApp } from '../../../shared/test-utils/rest-harness'

const BIG = randomBytes(BYTE_RANGE_MAX_CHUNK * 2 + 321)
let h: Awaited<ReturnType<typeof createTestHarness>>
let dir: string
let pc: ReturnType<typeof createFixtureChatRuntime>
const seen: Array<{ method: string; bytes: number; length?: number }> = []
/** Makes the next `readRange` answers report a changed source (an agent writing it). */
let changeSourceOnRanges = 0
/** Every request to the computer, with the caller signal it was sent with. */
const sent: Array<{ kind: string; method?: string; signal?: AbortSignal }> = []
let bounded: boolean | undefined = true
let stores: {
  ranged: ReturnType<typeof createComputerArtifactStorage>
  whole: ReturnType<typeof createComputerArtifactStorage>
}
let artifactId: string

beforeAll(async () => {
  h = await createTestHarness()
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'artifact-ranges-'))
  pc = createFixtureChatRuntime({
    taskFolder: () => dir,
    stateDir: join(dir, 'pc'),
    hubScope: 'hub',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'pc',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
  h.db.prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('t','p','Task',1)").run()
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    .run()
  const request = async (_pc: string, p: unknown, signal?: AbortSignal) => {
    sent.push({
      kind: String((p as { kind?: string }).kind),
      method: (p as { value?: { method?: string } }).value?.method,
      signal
    })
    let result = await pc.request(p)
    const v = (p as { kind?: string; value?: { method?: string; args?: unknown[] } }).value
    if (v?.method === 'readRange' && Number(v.args?.[2]) > 0 && changeSourceOnRanges > 0) {
      changeSourceOnRanges--
      result = { ...(result as object), etag: `changed-${changeSourceOnRanges}` }
    }
    if ((p as { kind?: string }).kind === 'artifact.invoke' && v?.method)
      seen.push({
        method: v.method,
        bytes: Buffer.byteLength(JSON.stringify(result ?? null)),
        ...(v.method === 'readRange' ? { length: Number(v.args?.[3]) } : {})
      })
    return result
  }
  const chat = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request,
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  })
  const make = () =>
    createComputerArtifactStorage({
      db: h.slayDb,
      local: createArtifactStore(join(dir, 'hub')),
      chat,
      request,
      boundedReads: () => bounded === true
    })
  stores = { ranged: make(), whole: make() }
  const a = await stores.whole.uploadArtifactBlob(h.slayDb, {
    taskId: 't',
    title: 'big.bin',
    bytes: BIG,
    chatTabId: 'tab',
    operationId: 'upload-big'
  })
  artifactId = a!.id
  // A second version, so a diff has two sides.
  await stores.whole.updateArtifact(h.slayDb, { id: artifactId, content: 'text v2\n' })
  await stores.whole.createArtifactVersion(h.slayDb, { artifactId })
})
afterAll(async () => {
  await pc.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Runs `read` both ways: ranged (bounded computer) and whole (older computer). */
async function both<T>(read: (s: typeof stores.ranged) => Promise<T>) {
  seen.length = 0
  bounded = true
  const ranged = await read(stores.ranged)
  const rangedCalls = [...seen]
  seen.length = 0
  bounded = false
  const whole = await read(stores.whole)
  const wholeCalls = [...seen]
  bounded = true
  return { ranged, whole, rangedCalls, wholeCalls }
}

const bounded256k = (calls: Array<{ method: string; bytes: number }>) =>
  calls.every((c) => c.bytes <= Math.ceil(BYTE_RANGE_MAX_CHUNK / 3) * 4 + 4096)

describe('caller cancellation reaches only the requests that are the caller’s own', () => {
  it('range reads and staged upload chunks carry the caller signal; shared work never does', async () => {
    const caller = new AbortController()
    sent.length = 0
    await runWithRequestAbort(caller.signal, async () => {
      await stores.ranged.writeArtifactContent(h.slayDb, { artifactId, bytes: BIG })
      await stores.ranged.readArtifactBytes(h.slayDb, artifactId)
    })
    const own = sent.filter(
      (r) => r.method === 'readRange' || r.kind === 'upload.begin' || r.kind === 'upload.chunk'
    )
    expect(own.filter((r) => r.method === 'readRange').length).toBeGreaterThanOrEqual(2)
    expect(own.filter((r) => r.kind === 'upload.chunk').length).toBeGreaterThanOrEqual(1)
    for (const r of own) expect(r.signal, `${r.kind} ${r.method ?? ''}`).toBe(caller.signal)
    // The final write is the caller's too (its publication is cancelled with it).
    expect(sent.find((r) => r.method === 'writeArtifactContent')?.signal).toBe(caller.signal)
    // Everything else (lifecycle sync, ownership, metadata drain) is hub work.
    for (const r of sent.filter((r) => !own.includes(r) && r.method !== 'writeArtifactContent'))
      expect(r.signal, `${r.kind} ${r.method ?? ''}`).toBeUndefined()
  })
})

describe('a working copy written while it is read in ranges', () => {
  it('is read again from its start (bounded), then the change surfaces', async () => {
    await stores.whole.updateArtifact(h.slayDb, { id: artifactId, content: BIG.toString('latin1') })
    const whole = await stores.whole.readArtifactBytes(h.slayDb, artifactId)
    changeSourceOnRanges = 1
    const once = await stores.ranged.readArtifactBytes(h.slayDb, artifactId)
    expect(Buffer.from(once).equals(Buffer.from(whole))).toBe(true)
    changeSourceOnRanges = 1
    expect(await stores.ranged.readArtifactContent(h.slayDb, artifactId)).toBe(
      BIG.toString('latin1')
    )
    changeSourceOnRanges = 100
    await expect(stores.ranged.readArtifactBytes(h.slayDb, artifactId)).rejects.toMatchObject({
      name: 'ByteSourceChangedError'
    })
    changeSourceOnRanges = 0
  })
})

describe('a moving version ref read in ranges', () => {
  it('stays on the version its first range resolved, though a newer one lands mid-read', async () => {
    const A = Buffer.alloc(BYTE_RANGE_MAX_CHUNK * 2 + 99, 0x61)
    const B = Buffer.alloc(BYTE_RANGE_MAX_CHUNK * 2 + 99, 0x62)
    await stores.whole.updateArtifact(h.slayDb, { id: artifactId, content: A.toString('latin1') })
    await stores.whole.createArtifactVersion(h.slayDb, { artifactId })
    const open = openArtifactReaderOf(stores.ranged)!
    for (const ref of ['current', 'latest'] as const) {
      const reader = (await open(h.slayDb, artifactId, { kind: 'version', ref }))!
      // A newer version lands after the first range was read.
      const next = ref === 'current' ? B : A
      await stores.whole.updateArtifact(h.slayDb, {
        id: artifactId,
        content: next.toString('latin1')
      })
      await stores.whole.createArtifactVersion(h.slayDb, { artifactId })
      const parts: Uint8Array[] = []
      for await (const part of reader.chunks) parts.push(part)
      expect(Buffer.concat(parts).equals(ref === 'current' ? A : B)).toBe(true)
    }
  })
})

describe('a bounded computer: every byte read in ranges', () => {
  it('readArtifactBytes and getArtifactPath', async () => {
    await stores.whole.updateArtifact(h.slayDb, { id: artifactId, content: BIG.toString('latin1') })
    const r = await both((s) => s.readArtifactBytes(h.slayDb, artifactId))
    expect(Buffer.from(r.ranged).equals(Buffer.from(r.whole))).toBe(true)
    expect(r.rangedCalls.map((c) => c.method)).not.toContain('readBytes')
    expect(r.rangedCalls.filter((c) => c.method === 'readRange').length).toBeGreaterThanOrEqual(2)
    expect(bounded256k(r.rangedCalls)).toBe(true)
    expect(r.wholeCalls.map((c) => c.method)).toContain('readBytes')
    const url = await both((s) => s.getArtifactPath(h.slayDb, artifactId))
    expect(url.ranged).toBe(url.whole)
  })

  it('readArtifactContent and readArtifactVersion (text)', async () => {
    await stores.whole.updateArtifact(h.slayDb, {
      id: artifactId,
      content: 'é text ✓\n'.repeat(40_000)
    })
    const c = await both((s) => s.readArtifactContent(h.slayDb, artifactId))
    expect(c.ranged).toBe(c.whole)
    expect(c.rangedCalls.map((x) => x.method)).not.toContain('readArtifactContent')
    expect(bounded256k(c.rangedCalls)).toBe(true)
    const v = await both((s) => s.readArtifactVersion(h.slayDb, { artifactId, versionRef: 1 }))
    expect(v.ranged).toBe(v.whole)
    expect(v.rangedCalls.map((x) => x.method)).not.toContain('readArtifactVersion')
  })

  it('resolveArtifactVersion (bytes + its row)', async () => {
    const r = await both((s) => s.resolveArtifactVersion(h.slayDb, { artifactId, versionRef: 1 }))
    expect(Buffer.from(r.ranged.bytes!).equals(Buffer.from(r.whole.bytes!))).toBe(true)
    expect(r.ranged.version).toEqual(r.whole.version)
    expect(r.rangedCalls.map((x) => x.method)).not.toContain('resolveArtifactVersion')
    expect(bounded256k(r.rangedCalls)).toBe(true)
  })

  it('diffArtifactVersions: the same result, its sides read in ranges', async () => {
    const d = await both((s) => s.diffArtifactVersions(h.slayDb, { artifactId, a: 1 }))
    expect(d.ranged).toEqual(d.whole)
    expect(d.rangedCalls.map((x) => x.method)).not.toContain('diffArtifactVersions')
    expect(bounded256k(d.rangedCalls)).toBe(true)
    const missing = await both((s) =>
      s.diffArtifactVersions(h.slayDb, { artifactId, a: 99 }).catch((e: Error) => e.message)
    )
    expect(missing.ranged).toBe(missing.whole)
  })

  it('openArtifactReader streams the ranges (REST), sized up front; null for an older computer', async () => {
    const open = openArtifactReaderOf(stores.ranged)!
    bounded = true
    const reader = await open(h.slayDb, artifactId, { kind: 'version', ref: 1 })
    expect(reader).not.toBeNull()
    const parts: Uint8Array[] = []
    for await (const part of reader!.chunks) parts.push(part)
    const whole = await stores.whole.resolveArtifactVersion(h.slayDb, { artifactId, versionRef: 1 })
    expect(Buffer.concat(parts).equals(Buffer.from(whole.bytes!))).toBe(true)
    expect(reader!.size).toBe(whole.bytes!.length)
    bounded = false
    expect(await open(h.slayDb, artifactId, { kind: 'bytes' })).toBeNull()
    bounded = true
  })

  it('the desktop/mobile readContent route preserves working-copy, fallback and corrupt-text parity', async () => {
    const dataRoot = join(dir, 'hub')
    const previous = getArtifactStorage(dataRoot)
    setArtifactStorage(dataRoot, stores.ranged)
    const caller = artifactsRouter.createCaller({ db: h.slayDb, dataRoot })
    const text = 'public fallback text ✓\n'.repeat(30000)
    await stores.whole.updateArtifact(h.slayDb, { id: artifactId, content: text })
    await stores.whole.createArtifactVersion(h.slayDb, { artifactId })
    const version = await stores.whole.getCurrentArtifactVersion(h.slayDb, { artifactId })
    const walk = (root: string): string[] =>
      readdirSync(root, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(root, e.name)) : [join(root, e.name)]
      )
    const files = walk(join(dir, 'pc'))
    const working = files.find(
      (p) => p.includes('/artifacts/') && p.split('/').pop()!.startsWith(artifactId)
    )!
    const blob = files.find(
      (p) => p.includes('/blobs/') && p.endsWith(version!.content_hash.slice(2))
    )!
    try {
      // A working copy wins even if the old immutable blob is corrupt.
      writeFileSync(blob, 'tampered')
      expect(await caller.readContent({ id: artifactId })).toBe(text)
      writeFileSync(blob, text)
      unlinkSync(working)
      expect(await caller.readContent({ id: artifactId })).toBe(text)
      writeFileSync(blob, 'tampered')
      expect(await caller.readContent({ id: artifactId })).toBe('')
      const legacy = await both((s) => s.readArtifactContent(h.slayDb, artifactId))
      expect(legacy.ranged).toBe(legacy.whole)
      expect(legacy.whole).toBe('')
    } finally {
      setArtifactStorage(dataRoot, previous)
    }
  })
})

// Real HTTP -> real hub storage -> native computer invocation; no fake reader in this suite.
async function withHttp(run: (url: string) => Promise<void>, trapWholeBuffers = false) {
  const dataRoot = getArtifactsDataRoot(),
    previous = getArtifactStorage(dataRoot)
  const scope = new AsyncLocalStorage<boolean>()
  const app = express()
  app.use((_req, _res, next) => scope.run(true, next))
  setArtifactStorage(dataRoot, stores.ranged)
  registerArtifactsContentRoutes(app, { db: h.slayDb, notifyRenderer: () => undefined })
  const rest = await mountRestApp(app)
  if (trapWholeBuffers) {
    const concat = Buffer.concat,
      alloc = Buffer.alloc
    vi.spyOn(Buffer, 'concat').mockImplementation((list, length) => {
      if (
        scope.getStore() &&
        (length ?? list.reduce((n, part) => n + part.length, 0)) > BYTE_RANGE_MAX_CHUNK
      )
        throw new Error('server assembled whole artifact')
      return concat(list, length)
    })
    vi.spyOn(Buffer, 'alloc').mockImplementation(((size: number, ...args: unknown[]) => {
      if (scope.getStore() && size > BYTE_RANGE_MAX_CHUNK)
        throw new Error('server allocated whole artifact')
      return Reflect.apply(alloc, Buffer, [size, ...args])
    }) as typeof Buffer.alloc)
  }
  try {
    await run(rest.url)
  } finally {
    vi.restoreAllMocks()
    await rest.close()
    setArtifactStorage(dataRoot, previous)
    bounded = true
  }
}
const walkFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(root, e.name)) : [join(root, e.name)]
  )

it.each([true, false, undefined])(
  'native computer REST Range matrix (boundedReads=%s)',
  async (advertised) => {
    const bytes = Buffer.alloc(BYTE_RANGE_MAX_CHUNK * 2 + 33).map((_, i) => i % 251)
    Buffer.from('é😀\0\r\n').copy(bytes, BYTE_RANGE_MAX_CHUNK - 3)
    bounded = true
    const artifact = await stores.ranged.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: `é"x-${String(advertised)}.bin`,
      bytes,
      chatTabId: 'tab',
      operationId: crypto.randomUUID()
    })
    bounded = advertised
    const cases: Array<[string | undefined, number, number, number]> = [
      [undefined, 200, 0, bytes.length],
      ['bytes=2-8', 206, 2, 9],
      [
        `bytes=${BYTE_RANGE_MAX_CHUNK - 3}-${BYTE_RANGE_MAX_CHUNK + 7}`,
        206,
        BYTE_RANGE_MAX_CHUNK - 3,
        BYTE_RANGE_MAX_CHUNK + 8
      ],
      ['bytes=9-', 206, 9, bytes.length],
      ['bytes=-7', 206, bytes.length - 7, bytes.length],
      [`bytes=${bytes.length - 2}-99999999`, 206, bytes.length - 2, bytes.length],
      [`bytes=${bytes.length - 1}-`, 206, bytes.length - 1, bytes.length],
      ['bytes=8-3', 200, 0, bytes.length],
      ['bytes=0-1,3-4', 200, 0, bytes.length],
      ['items=0-1', 200, 0, bytes.length],
      [`bytes=${bytes.length}-`, 416, 0, 0],
      ['bytes=-0', 416, 0, 0]
    ]
    await withHttp(async (url) => {
      for (const [range, status, start, end] of cases) {
        seen.length = 0
        const response = await fetch(`${url}/api/artifacts/${artifact!.id}/content`, {
          headers: range ? { Range: range } : {}
        })
        const body = Buffer.from(await response.arrayBuffer())
        expect(response.status, range).toBe(status)
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        if (status === 416) {
          expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
          expect(JSON.parse(body.toString()).code).toBe('RANGE_NOT_SATISFIABLE')
        } else {
          expect(response.headers.get('content-length')).toBe(String(end - start))
          expect(response.headers.get('content-range')).toBe(
            status === 206 ? `bytes ${start}-${end - 1}/${bytes.length}` : null
          )
          expect(response.headers.get('content-disposition')).toBe(
            `attachment; filename="__x-${String(advertised)}.bin"; filename*=UTF-8''%C3%A9%22x-${String(advertised)}.bin`
          )
          expect(body).toEqual(bytes.subarray(start, end))
        }
        if (advertised === true) {
          expect(seen.map((call) => call.method)).not.toContain('readBytes')
          const ranges = seen.filter((call) => call.method === 'readRange')
          expect(ranges.length).toBeGreaterThan(0)
          if (status === 416) expect(ranges).toHaveLength(1)
          expect(ranges.every((call) => call.length! <= BYTE_RANGE_MAX_CHUNK)).toBe(true)
          expect(bounded256k(ranges)).toBe(true)
        } else expect(seen.map((call) => call.method)).toContain('readBytes')
      }
    }, advertised === true)
  }
)

it('native staged artifact beyond the former inline limit streams exact HTTP bytes without a whole-buffer server fallback', async () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 17).map((_, i) => i % 251)
  Buffer.from('😀é\0\r\n').copy(bytes, BYTE_RANGE_MAX_CHUNK - 2)
  bounded = true
  const artifact = await stores.ranged.uploadArtifactBlob(h.slayDb, {
    taskId: 't',
    title: 'large.bin',
    bytes,
    chatTabId: 'tab',
    operationId: crypto.randomUUID()
  })
  await withHttp(async (url) => {
    for (const range of [
      undefined,
      `bytes=${BYTE_RANGE_MAX_CHUNK - 3}-${BYTE_RANGE_MAX_CHUNK + 7}`
    ]) {
      seen.length = 0
      const response = await fetch(`${url}/api/artifacts/${artifact!.id}/content`, {
        headers: range ? { Range: range } : {}
      })
      expect(response.status).toBe(range ? 206 : 200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        range ? bytes.subarray(BYTE_RANGE_MAX_CHUNK - 3, BYTE_RANGE_MAX_CHUNK + 8) : bytes
      )
      expect(seen.map((call) => call.method)).not.toContain('readBytes')
      const ranges = seen.filter((call) => call.method === 'readRange')
      expect(ranges.length).toBe(Math.ceil(bytes.length / BYTE_RANGE_MAX_CHUNK))
      expect(ranges.every((call) => call.length! <= BYTE_RANGE_MAX_CHUNK)).toBe(true)
      expect(bounded256k(ranges)).toBe(true)
    }
  }, true)
})

it.each(['corrupt-unselected-tail', 'truncate'] as const)(
  'native immutable %s cannot complete a successful prefix Range',
  async (failure) => {
    const bytes = Buffer.alloc(BYTE_RANGE_MAX_CHUNK * 2 + 101, 0x5a)
    bounded = true
    const artifact = await stores.ranged.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'integrity.bin',
      bytes,
      chatTabId: 'tab',
      operationId: crypto.randomUUID()
    })
    const version = await stores.ranged.getCurrentArtifactVersion(h.slayDb, {
      artifactId: artifact!.id
    })
    const files = walkFiles(join(dir, 'pc'))
    const working = files.find(
      (p) => p.includes('/artifacts/') && p.split('/').pop()!.startsWith(artifact!.id)
    )!
    const blob = files.find(
      (p) => p.includes('/blobs/') && p.endsWith(version!.content_hash.slice(2))
    )!
    unlinkSync(working)
    if (failure === 'truncate') writeFileSync(blob, bytes.subarray(0, bytes.length - 1))
    else {
      const bad = Buffer.from(bytes)
      bad[bad.length - 1] ^= 0xff
      writeFileSync(blob, bad)
    }
    try {
      await withHttp(async (url) => {
        const accepted = await fetch(`${url}/api/artifacts/${artifact!.id}/content`, {
          headers: { Range: 'bytes=0-2' }
        })
          .then(
            async (response) =>
              response.status === 206 && (await response.arrayBuffer()).byteLength === 3
          )
          .catch(() => false)
        expect(accepted).toBe(false)
        writeFileSync(blob, bytes)
        const intact = await fetch(`${url}/api/artifacts/${artifact!.id}/content`, {
          headers: { Range: 'bytes=0-2' }
        })
        expect(intact.status).toBe(206)
        expect(Buffer.from(await intact.arrayBuffer())).toEqual(bytes.subarray(0, 3))
      }, true)
    } finally {
      writeFileSync(blob, bytes)
    }
  }
)
