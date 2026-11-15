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
const sent: Array<{ kind: string; method?: string; bytes: number }> = []
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
    const body = p as { kind: string; value?: { method?: string } }
    sent.push({
      kind: body.kind,
      method: body.value?.method,
      bytes: Buffer.byteLength(JSON.stringify(p))
    })
    return pc.request(p)
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
