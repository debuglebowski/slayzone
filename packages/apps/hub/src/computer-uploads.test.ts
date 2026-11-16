/**
 * Uploads to a computer (FU1 S3). To a computer that answers bounded reads, bytes go
 * as staged chunks (`upload.begin` / `upload.chunk`, ≤ 256 KiB each) and the upload
 * names them by hash — any size, every request within one frame. An older computer
 * takes inline base64 up to its 14,000,000-char limit; over it the hub refuses BEFORE
 * encoding anything, as a "frame too large" error (REST 413, tRPC PAYLOAD_TOO_LARGE).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { isComputerFrameTooLarge } from '@slayzone/platform/computer-frame-limit'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

let h: Awaited<ReturnType<typeof createTestHarness>>
let dir: string
let pc: ReturnType<typeof createFixtureChatRuntime>
let chat: ReturnType<typeof createComputerChatServices>
let store: ReturnType<typeof createComputerArtifactStorage>
let bounded = true
let legacyReceiver = false
const legacyOffsets = new Map<string, number>()
const sent: Array<{
  kind: string
  method?: string
  bytes: number
  route?: { id: string; epoch: number }
  uploadId?: string
}> = []
/** Over 14,000,000 base64 chars. */
const BIG = randomBytes(11 * 1024 * 1024)

beforeAll(async () => {
  h = await createTestHarness()
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'computer-uploads-'))
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
    const body = p as {
      kind: string
      value?: { method?: string }
      route?: { id: string; epoch: number }
      uploadId?: string
    }
    sent.push({
      kind: body.kind,
      method: body.value?.method,
      bytes: Buffer.byteLength(JSON.stringify(p)),
      route: body.route,
      uploadId: body.uploadId
    })
    if (!legacyReceiver) return pc.request(p)
    const old = p as {
      kind: string
      sha256: string
      size: number
      offset: number
      data: string
      value?: { method: string; args: Array<{ staged?: { sha256: string } }> }
    }
    if (old.kind === 'upload.begin') {
      // Historical receiver ignores additive ownership fields and acknowledges only offsets.
      await pc.request({ kind: old.kind, sha256: old.sha256, size: old.size })
      const received = legacyOffsets.get(old.sha256) ?? 0
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { received }
    }
    if (old.kind === 'upload.chunk') {
      const here = legacyOffsets.get(old.sha256) ?? 0
      if (old.offset !== here)
        throw new Error(`old receiver offset ${old.offset}, expected ${here}`)
      legacyOffsets.set(old.sha256, here + Buffer.from(old.data, 'base64').length)
      return pc.request({
        kind: old.kind,
        sha256: old.sha256,
        size: old.size,
        offset: old.offset,
        data: old.data
      })
    }
    const result = await pc.request(p)
    if (old.kind === 'artifact.invoke' && old.value?.args[0]?.staged)
      legacyOffsets.delete(old.value.args[0].staged.sha256)
    return result
  }
  chat = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request,
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false,
    boundedReads: () => bounded
  })
  store = createComputerArtifactStorage({
    db: h.slayDb,
    local: createArtifactStore(join(dir, 'hub')),
    chat,
    request,
    boundedReads: () => bounded
  })
})
afterAll(async () => {
  await pc.close()
  rmSync(dir, { recursive: true, force: true })
})

const frame = Math.ceil((256 * 1024) / 3) * 4 + 8192

describe('a bounded computer: staged chunks, any size', () => {
  it('concurrent identical uploads also finish against a legacy receiver with strict shared offsets', async () => {
    bounded = true
    legacyReceiver = true
    const bytes = Buffer.alloc(600_000, 66)
    try {
      const results = await Promise.allSettled(
        ['one', 'two'].map((id) =>
          store.uploadArtifactBlob(h.slayDb, {
            taskId: 't',
            title: `legacy-${id}.bin`,
            bytes,
            chatTabId: 'tab',
            operationId: `legacy-${id}`
          })
        )
      )
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      for (const result of results)
        if (result.status === 'fulfilled')
          expect(
            Buffer.from(await store.readArtifactBytes(h.slayDb, result.value!.id)).equals(bytes)
          ).toBe(true)
    } finally {
      legacyReceiver = false
      legacyOffsets.clear()
    }
  })
  it('uploads an artifact bigger than the inline limit; every request fits one range', async () => {
    sent.length = 0
    bounded = true
    const a = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'big.bin',
      bytes: BIG,
      chatTabId: 'tab',
      operationId: 'big-up'
    })
    expect(sent.map((s) => s.kind)).toContain('upload.chunk')
    expect(sent.find((s) => s.kind === 'upload.begin')?.route).toBeDefined()
    expect(sent.filter((s) => s.kind === 'upload.chunk').every((s) => !!s.uploadId)).toBe(true)
    expect(sent.every((s) => s.bytes <= frame)).toBe(true)
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, a!.id)).equals(BIG)).toBe(true)
  })

  it('writes content from a file without encoding it whole', async () => {
    bounded = true
    const a = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'w.bin',
      bytes: Buffer.from('v1'),
      chatTabId: 'tab',
      operationId: 'w-up'
    })
    const path = join(dir, 'source.bin')
    writeFileSync(path, BIG)
    sent.length = 0
    await store.writeArtifactContent(h.slayDb, { artifactId: a!.id, sourcePath: path })
    expect(sent.find((s) => s.kind === 'upload.begin')?.route).toBeDefined()
    expect(sent.filter((s) => s.kind === 'upload.chunk').every((s) => !!s.uploadId)).toBe(true)
    expect(sent.every((s) => s.bytes <= frame)).toBe(true)
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, a!.id)).equals(BIG)).toBe(true)
  })
})

describe('an older computer: inline, refused before encoding over its limit', () => {
  it('a small upload goes inline as before', async () => {
    bounded = false
    sent.length = 0
    const a = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'small.txt',
      bytes: Buffer.from('small'),
      chatTabId: 'tab',
      operationId: 'small-up'
    })
    expect(sent.map((s) => s.kind)).not.toContain('upload.begin')
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, a!.id)).toString()).toBe('small')
    bounded = true
  })

  it('an upload over the inline limit is refused as frame-too-large, nothing sent', async () => {
    bounded = false
    sent.length = 0
    const err = await store
      .uploadArtifactBlob(h.slayDb, {
        taskId: 't',
        title: 'huge.bin',
        bytes: BIG,
        chatTabId: 'tab',
        operationId: 'huge-up'
      })
      .then(
        () => null,
        (e: unknown) => e
      )
    expect(isComputerFrameTooLarge(err)).toBe(true)
    expect(sent.filter((s) => s.method === 'uploadArtifactBlob')).toEqual([])
    bounded = true
  })
})
