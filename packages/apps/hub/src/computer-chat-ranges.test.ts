/**
 * Chat byte reads through the hub in ranges (FU1 S2): an archived file, an archived
 * attachment, and a session move's attachment are read from a bounded computer as
 * `bytes.read` ranges (≤ 256 KiB each), never one whole base64 reply, and answer
 * exactly what the whole reads answer. An older computer gets the whole reads.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'

let h: Awaited<ReturnType<typeof createTestHarness>>
let dir: string
let pc: ReturnType<typeof createFixtureChatRuntime>
let chat: ReturnType<typeof createComputerChatServices>
let bounded = true
const seen: Array<{ kind: string; bytes: number }> = []
const route = { id: 'c', epoch: 1 }
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(BYTE_RANGE_MAX_CHUNK + 999)])
let ref: Record<string, unknown>
let archiveId: string
let file: { artifactId: string; contentHash: string }

beforeAll(async () => {
  h = await createTestHarness()
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-ranges-'))
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
  const request = async (_pc: string, p: unknown) => {
    const result = await pc.request(p)
    seen.push({
      kind: (p as { kind: string }).kind,
      bytes: Buffer.byteLength(JSON.stringify(result ?? null))
    })
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
    admitComputer: async () => undefined,
    boundedReads: () => bounded
  })
  await pc.request({
    kind: 'bootstrap',
    value: {
      identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }
  })
  ref = (await pc.request({
    kind: 'attachment.put',
    route,
    ref: {
      artifactId: 'a1',
      name: 'doc.pdf',
      kind: 'pdf',
      mediaType: 'application/pdf',
      size: PDF.length
    },
    data: PDF.toString('base64')
  })) as Record<string, unknown>
  await pc.request({
    kind: 'artifact.invoke',
    value: {
      route,
      method: 'uploadArtifactBlob',
      operationId: 'up',
      args: [
        {
          taskId: 't',
          title: 'big.bin',
          data: randomBytes(BYTE_RANGE_MAX_CHUNK + 5).toString('base64')
        }
      ]
    }
  })
  const backupId = randomUUID()
  await chat.computers.createBackup('pc', backupId)
  archiveId = randomUUID()
  await chat.computers.restoreBackup('pc', backupId, archiveId)
  const records = await chat.computers.archiveRecords('pc', archiveId, 'c', 0)
  file = records.records.find((r) => r.kind === 'artifact-version')!.value as typeof file
})
afterAll(async () => {
  await pc.close()
  rmSync(dir, { recursive: true, force: true })
})

async function both<T>(read: () => Promise<T>) {
  seen.length = 0
  bounded = true
  const ranged = await read()
  const rangedKinds = [...seen]
  seen.length = 0
  bounded = false
  const whole = await read()
  const wholeKinds = [...seen]
  bounded = true
  return { ranged, whole, rangedKinds, wholeKinds }
}
const maxReply = Math.ceil(BYTE_RANGE_MAX_CHUNK / 3) * 4 + 4096

test('archiveFile: ranges, the same {name, data}', async () => {
  const r = await both(() =>
    chat.computers.archiveFile('pc', archiveId, 'c', file.artifactId, file.contentHash)
  )
  expect(r.ranged).toEqual(r.whole)
  expect(r.rangedKinds.map((k) => k.kind)).not.toContain('archive.file')
  expect(r.rangedKinds.filter((k) => k.kind === 'bytes.read').length).toBeGreaterThanOrEqual(2)
  expect(r.rangedKinds.every((k) => k.bytes <= maxReply)).toBe(true)
  expect(r.wholeKinds.map((k) => k.kind)).toContain('archive.file')
})

test('archiveAttachment: ranges, the same data', async () => {
  const r = await both(() => chat.computers.archiveAttachment('pc', archiveId, 'c', ref as never))
  expect(r.ranged).toEqual(r.whole)
  expect(r.rangedKinds.map((k) => k.kind)).not.toContain('archive.attachment')
  expect(r.rangedKinds.every((k) => k.bytes <= maxReply)).toBe(true)
})

test('a session move reads an attachment in ranges', async () => {
  const r = await both(() =>
    chat.taskMoveSessions.readAttachment({
      computerId: 'pc',
      conversationId: 'c',
      epoch: 1,
      ref: ref as never
    })
  )
  expect(r.ranged).toBe(r.whole)
  expect(Buffer.from(r.ranged, 'base64').equals(PDF)).toBe(true)
  expect(r.rangedKinds.map((k) => k.kind)).not.toContain('attachment.read')
  expect(r.rangedKinds.every((k) => k.bytes <= maxReply)).toBe(true)
})
