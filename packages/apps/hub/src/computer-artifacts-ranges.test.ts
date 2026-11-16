/**
 * A computer-held artifact read through the hub in ranges (FU1 S2). Against a
 * computer that answers bounded reads (`boundedReads`), every byte read — bytes,
 * the editor's text, a version, a diff's two sides, the data URL — goes as
 * `readRange` requests of at most 256 KiB each, never one whole-file reply, and
 * answers exactly what the whole reads answer. An older computer gets the whole
 * reads, as before. REST can stream the ranges (`openArtifactReader`).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import {
  artifactsRouter,
  getArtifactStorage,
  setArtifactStorage,
  createArtifactStore
} from '@slayzone/task-artifacts/server'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { openArtifactReaderOf } from '@slayzone/task-artifacts/server'
import { createComputerArtifactStorage } from './computer-artifacts'

const BIG = randomBytes(BYTE_RANGE_MAX_CHUNK * 2 + 321)
let h: Awaited<ReturnType<typeof createTestHarness>>
let dir: string
let pc: ReturnType<typeof createFixtureChatRuntime>
const seen: Array<{ method: string; bytes: number }> = []
let bounded = true
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
  const request = async (_pc: string, p: unknown) => {
    const result = await pc.request(p)
    const v = (p as { kind?: string; value?: { method?: string } }).value
    if ((p as { kind?: string }).kind === 'artifact.invoke' && v?.method)
      seen.push({ method: v.method, bytes: Buffer.byteLength(JSON.stringify(result ?? null)) })
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
      boundedReads: () => bounded
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
