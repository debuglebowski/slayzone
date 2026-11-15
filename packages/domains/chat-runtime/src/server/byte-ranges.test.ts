/**
 * Byte reads in ranges (FU1 S2): every byte read a hub asks of this computer —
 * an artifact's bytes / text / version, an archived file or attachment, a live
 * attachment — can be read in ranges of at most 256 KiB (`@slayzone/platform/
 * bounded-reads`), with the same ownership checks as the whole reads, and the
 * ranges put together equal the whole read exactly.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BYTE_RANGE_MAX_CHUNK,
  type ByteRangePage,
  collectByteRanges
} from '@slayzone/platform/bounded-reads'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-byte-ranges-'))
  dirs.push(dir)
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' })
  runtimes.push(r)
  for (const [id, taskId, tabId] of [
    ['c', 't', 'tab'],
    ['c2', 't2', 'tab2']
  ])
    r.bootstrap({
      identity: { id, taskId, tabId, mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: '/tmp',
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  return r
}

const route = { id: 'c', epoch: 1 }
const BIG = randomBytes(BYTE_RANGE_MAX_CHUNK * 2 + 777)

async function upload(r: ReturnType<typeof runtime>, bytes: Buffer, at = route, taskId = 't') {
  return (await r.artifacts.invoke({
    route: at,
    method: 'uploadArtifactBlob',
    operationId: `up-${taskId}-${bytes.length}`,
    args: [{ taskId, title: 'big.bin', data: bytes.toString('base64') }]
  })) as { id: string }
}

/** Reads `spec` of `id` range by range, checking each page's bound. */
async function readAll(r: ReturnType<typeof runtime>, id: string, spec: unknown) {
  const pages: ByteRangePage[] = []
  const bytes = await collectByteRanges(async (offset, length) => {
    const page = (await r.artifacts.invoke({
      route,
      method: 'readRange',
      args: [id, spec, offset, length]
    })) as ByteRangePage
    expect(Buffer.from(page.data, 'base64').length).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
    pages.push(page)
    return page
  })
  return { bytes: Buffer.from(bytes), pages }
}

describe('artifact readRange', () => {
  it('bytes (the current file) in ranges equal readBytes', async () => {
    const r = runtime()
    const a = await upload(r, BIG)
    const whole = (await r.artifacts.invoke({ route, method: 'readBytes', args: [a.id] })) as {
      data: string
    }
    const got = await readAll(r, a.id, { kind: 'bytes' })
    expect(got.bytes.equals(Buffer.from(whole.data, 'base64'))).toBe(true)
    expect(got.pages.length).toBe(3)
    expect(new Set(got.pages.map((p) => p.etag)).size).toBe(1)
  })

  it('a version in ranges equals resolveArtifactVersion; its row comes with the first range', async () => {
    const r = runtime()
    const a = await upload(r, BIG)
    const whole = (await r.artifacts.invoke({
      route,
      method: 'resolveArtifactVersion',
      args: [{ artifactId: a.id, versionRef: 1 }]
    })) as { version: { content_hash: string }; data: string }
    const got = await readAll(r, a.id, { kind: 'version', ref: 1 })
    expect(got.bytes.equals(Buffer.from(whole.data, 'base64'))).toBe(true)
    const first = got.pages[0] as ByteRangePage & { version?: { content_hash: string } }
    expect(first.version?.content_hash).toBe(whole.version.content_hash)
    expect(first.etag).toBe(whole.version.content_hash)
  })

  it('content (the text the editor reads) equals readArtifactContent', async () => {
    const r = runtime()
    const a = await upload(r, Buffer.from('first'))
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      operationId: 'edit',
      args: [{ id: a.id, content: 'edited ✓' }]
    })
    const whole = await r.artifacts.invoke({ route, method: 'readArtifactContent', args: [a.id] })
    const got = await readAll(r, a.id, { kind: 'content' })
    expect(got.bytes.toString('utf8')).toBe(whole)
  })

  it('currentVersion (a diff’s default side) is the current version', async () => {
    const r = runtime()
    const a = await upload(r, Buffer.from('v1'))
    const current = (await r.artifacts.invoke({
      route,
      method: 'getCurrentArtifactVersion',
      args: [{ artifactId: a.id }]
    })) as { content_hash: string }
    const got = await readAll(r, a.id, { kind: 'currentVersion' })
    expect(got.pages[0].etag).toBe(current.content_hash)
    expect(got.bytes.toString()).toBe('v1')
  })

  it('a version that does not exist fails as the whole read does', async () => {
    const r = runtime()
    const a = await upload(r, Buffer.from('v1'))
    const whole = await r.artifacts
      .invoke({
        route,
        method: 'resolveArtifactVersion',
        args: [{ artifactId: a.id, versionRef: 99 }]
      })
      .catch((e: Error) => e.message)
    const ranged = await r.artifacts
      .invoke({ route, method: 'readRange', args: [a.id, { kind: 'version', ref: 99 }, 0, 10] })
      .catch((e: Error) => e.message)
    expect(ranged).toBe(whole)
    expect(ranged).toMatch(/NOT_FOUND/)
  })

  it('another task’s artifact is refused; a range over the limit is refused', async () => {
    const r = runtime()
    const foreign = await upload(r, Buffer.from('theirs'), { id: 'c2', epoch: 1 }, 't2')
    await expect(
      r.artifacts.invoke({
        route,
        method: 'readRange',
        args: [foreign.id, { kind: 'bytes' }, 0, 10]
      })
    ).rejects.toThrow(/task|scope|artifact/i)
    const mine = await upload(r, Buffer.from('mine'))
    await expect(
      r.artifacts.invoke({
        route,
        method: 'readRange',
        args: [mine.id, { kind: 'bytes' }, 0, BYTE_RANGE_MAX_CHUNK + 1]
      })
    ).rejects.toThrow()
  })
})

describe('archived files and attachments, live attachments', () => {
  it('archive file and attachment ranges equal the whole reads; another conversation is refused', async () => {
    const r = runtime()
    // A PDF (its type is sniffed) larger than one range.
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(BYTE_RANGE_MAX_CHUNK + 500)])
    const ref = r.attachments.put(
      'tab',
      {
        artifactId: 'file',
        name: 'n.pdf',
        kind: 'pdf',
        mediaType: 'application/pdf',
        size: big.length
      },
      big
    )
    await r.ops.saveTabDraft('tab', { text: 'draft', attachments: [ref] })
    const a = await upload(r, BIG)
    const backup = await r.backups.create('manual')
    const archive = await r.backups.restore(backup.id)
    const files = r.backups
      .records(archive.id, 'c')
      .records.filter((row) => row.kind === 'artifact-version')
      .map((row) => row.value as { artifactId: string; contentHash: string })
    const file = files.find((f) => f.artifactId === a.id)!

    const fileBytes = await collectByteRanges(async (offset, length) =>
      r.backups.fileRange(archive.id, 'c', file.artifactId, file.contentHash, offset, length)
    )
    const whole = r.backups.file(archive.id, 'c', file.artifactId, file.contentHash)
    expect(Buffer.from(fileBytes).equals(whole.data)).toBe(true)
    expect(r.backups.fileRange(archive.id, 'c', file.artifactId, file.contentHash, 0, 1).name).toBe(
      whole.name
    )
    expect(() =>
      r.backups.fileRange(archive.id, 'other', file.artifactId, file.contentHash, 0, 1)
    ).toThrow(/belong/i)

    const attachmentBytes = await collectByteRanges(async (offset, length) =>
      r.backups.attachmentRange(archive.id, 'c', ref, offset, length)
    )
    expect(
      Buffer.from(attachmentBytes).equals(Buffer.from(r.backups.attachment(archive.id, 'c', ref)))
    ).toBe(true)

    const live = await collectByteRanges(async (offset, length) =>
      r.attachments.range(route, ref, offset, length)
    )
    expect(Buffer.from(live).equals(Buffer.from(await r.attachments.reader.read(ref)))).toBe(true)
    expect(() => r.attachments.range({ id: 'c2', epoch: 1 }, ref, 0, 1)).toThrow(/belong/i)
  })
})
