/**
 * `bytes.read` (FU1 S2): the hub reads an attachment or an archived file in ranges
 * of at most 256 KiB instead of one whole base64 reply — same ownership checks as
 * the whole reads (`attachment.read`, `archive.file`, `archive.attachment`).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK, collectByteRanges } from '@slayzone/platform/bounded-reads'
import type { createChatRuntimeHandlers } from './chat-runtime'
import { createFixtureChatRuntime } from '../project-scope.fixture'

const dirs: string[] = []
const handles: Array<ReturnType<typeof createChatRuntimeHandlers>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-bytes-'))
  dirs.push(stateDir)
  const h = createFixtureChatRuntime({
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    },
    stateDir,
    hubScope: 'hub',
    computerId: () => 'computer',
    getProjectPaths: () => null
  })
  handles.push(h)
  return h
}

const identity = (id: string, taskId: string, tabId: string) => ({
  identity: { id, taskId, tabId, mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: realpathSync(tmpdir()),
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
})

test('an attachment in ranges equals attachment.read; another conversation is refused', async () => {
  const h = setup()
  await h.request({ kind: 'bootstrap', value: identity('c', 't', 'tab') })
  await h.request({ kind: 'bootstrap', value: identity('c2', 't2', 'tab2') })
  const route = { id: 'c', epoch: 1 }
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(BYTE_RANGE_MAX_CHUNK + 900)])
  const ref = (await h.request({
    kind: 'attachment.put',
    route,
    ref: {
      artifactId: 'a1',
      name: 'doc.pdf',
      kind: 'pdf',
      mediaType: 'application/pdf',
      size: bytes.length
    },
    data: bytes.toString('base64')
  })) as Record<string, unknown>

  const whole = (await h.request({ kind: 'attachment.read', route, ref })) as { data: string }
  let calls = 0
  const ranged = await collectByteRanges(async (offset, length) => {
    calls++
    return (await h.request({
      kind: 'bytes.read',
      source: { type: 'attachment', route, ref },
      offset,
      length
    })) as never
  })
  expect(Buffer.from(ranged).equals(Buffer.from(whole.data, 'base64'))).toBe(true)
  expect(calls).toBe(2)

  await expect(
    h.request({
      kind: 'bytes.read',
      source: { type: 'attachment', route: { id: 'c2', epoch: 1 }, ref },
      offset: 0,
      length: 1
    })
  ).rejects.toThrow(/belong/i)
})

test('a range over 256 KiB, or an unknown source, is refused by the schema', async () => {
  const h = setup()
  await expect(
    h.request({
      kind: 'bytes.read',
      source: { type: 'attachment', route: { id: 'c', epoch: 1 }, ref: { artifactId: 'x' } },
      offset: 0,
      length: BYTE_RANGE_MAX_CHUNK + 1
    })
  ).rejects.toThrow()
  await expect(
    h.request({
      kind: 'bytes.read',
      source: { type: 'disk', path: '/etc/passwd' },
      offset: 0,
      length: 1
    })
  ).rejects.toThrow()
})

test('archive sources go to the archive (an unknown archive is its error, not a schema one)', async () => {
  const h = setup()
  const archiveId = '00000000-0000-4000-8000-000000000000'
  const contentHash = 'a'.repeat(64)
  const err = await h
    .request({
      kind: 'bytes.read',
      source: {
        type: 'archive.file',
        archiveId,
        conversationId: 'c',
        artifactId: 'x',
        contentHash
      },
      offset: 0,
      length: 1
    })
    .then(
      () => null,
      (e: Error) => e
    )
  expect(err).not.toBeNull()
  expect(err?.name).not.toBe('ZodError')
  expect(err?.message).toMatch(/archive/i)
})
