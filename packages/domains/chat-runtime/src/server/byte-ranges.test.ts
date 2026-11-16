/**
 * Byte reads in ranges (FU1 S2): every byte read a hub asks of this computer —
 * an artifact's bytes / text / version, an archived file or attachment, a live
 * attachment — can be read in ranges of at most 256 KiB (`@slayzone/platform/
 * bounded-reads`), with the same ownership checks as the whole reads, and the
 * ranges put together equal the whole read exactly.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BYTE_RANGE_MAX_CHUNK,
  type ByteRangePage,
  collectByteRanges
} from '@slayzone/platform/bounded-reads'
import { BlobStore } from '@slayzone/task-artifacts/storage'
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
    const files = (await r.backups.records(archive.id, 'c')).records
      .filter((row) => row.kind === 'artifact-version')
      .map((row) => row.value as { artifactId: string; contentHash: string })
    const file = files.find((f) => f.artifactId === a.id)!

    const fileBytes = await collectByteRanges(async (offset, length) =>
      r.backups.fileRange(archive.id, 'c', file.artifactId, file.contentHash, offset, length)
    )
    const whole = await r.backups.file(archive.id, 'c', file.artifactId, file.contentHash)
    expect(Buffer.from(fileBytes).equals(whole.data)).toBe(true)
    expect(
      (await r.backups.fileRange(archive.id, 'c', file.artifactId, file.contentHash, 0, 1)).name
    ).toBe(whole.name)
    await expect(
      r.backups.fileRange(archive.id, 'other', file.artifactId, file.contentHash, 0, 1)
    ).rejects.toThrow(/belong/i)

    const attachmentBytes = await collectByteRanges(async (offset, length) =>
      r.backups.attachmentRange(archive.id, 'c', ref, offset, length)
    )
    expect(
      Buffer.from(attachmentBytes).equals(
        Buffer.from(await r.backups.attachment(archive.id, 'c', ref))
      )
    ).toBe(true)

    const live = await collectByteRanges(async (offset, length) =>
      r.attachments.range(route, ref, offset, length)
    )
    expect(Buffer.from(live).equals(Buffer.from(await r.attachments.reader.read(ref)))).toBe(true)
    expect(() => r.attachments.range({ id: 'c2', epoch: 1 }, ref, 0, 1)).toThrow(/belong/i)
  })
})

/** Every file under `dir`. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * The text read (`content`) keeps the whole read's answers in every state its
 * working file and current version can be in: the ranged path answers what
 * `readArtifactContent` answers — including '' where that read caught a failure of
 * the version read (no version, its blob missing, its blob corrupt), and the
 * restored content of a blob staged for GC (`BlobStore.read` restores it).
 */
describe('content parity with readArtifactContent', () => {
  async function setup(text: string, title = 'doc.txt') {
    const r = runtime()
    const a = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: `up-${title}`,
      args: [{ taskId: 't', title, data: Buffer.from(text).toString('base64') }]
    })) as { id: string; title: string }
    const current = (await r.artifacts.invoke({
      route,
      method: 'getCurrentArtifactVersion',
      args: [{ artifactId: a.id }]
    })) as { content_hash: string }
    const files = walk(dirs[dirs.length - 1])
    const blob = files.find(
      (f) => f.includes(`${sep}blobs${sep}`) && f.endsWith(current.content_hash.slice(2))
    )!
    let blobsRoot = blob
    while (basename(blobsRoot) !== 'blobs') blobsRoot = dirname(blobsRoot)
    const working = () =>
      walk(dirs[dirs.length - 1]).find(
        (f) => f.includes(`${sep}artifacts${sep}`) && basename(f).startsWith(a.id)
      )
    return {
      r,
      a,
      hash: current.content_hash,
      blob,
      blobs: new BlobStore(dirname(blobsRoot)),
      working
    }
  }
  const old = (r: ReturnType<typeof runtime>, id: string) =>
    r.artifacts.invoke({ route, method: 'readArtifactContent', args: [id] })
  const ranged = async (r: ReturnType<typeof runtime>, id: string) =>
    Buffer.from((await readAll(r, id, { kind: 'content' })).bytes).toString('utf8')
  const removeWorking = (path: string | undefined) => {
    expect(path).toBeDefined()
    unlinkSync(path!)
  }

  it('an empty artifact', async () => {
    const { r, a } = await setup('')
    expect(await old(r, a.id)).toBe('')
    expect(await ranged(r, a.id)).toBe('')
  })

  it('no working file: the current version', async () => {
    const { r, a, working } = await setup('versioned text')
    removeWorking(working())
    expect(await old(r, a.id)).toBe('versioned text')
    expect(await ranged(r, a.id)).toBe('versioned text')
  })

  it('no working file, its blob gone: the whole read answered ""', async () => {
    const { r, a, working, blob } = await setup('gone')
    removeWorking(working())
    unlinkSync(blob)
    expect(await old(r, a.id)).toBe('')
    expect(await ranged(r, a.id)).toBe('')
  })

  it('no working file, its blob corrupt: ""', async () => {
    const { r, a, working, blob } = await setup('corrupt me')
    removeWorking(working())
    writeFileSync(blob, 'tampered')
    expect(await old(r, a.id)).toBe('')
    expect(await ranged(r, a.id)).toBe('')
  })

  it('no working file, its blob staged for GC: restored, its text', async () => {
    const { r, a, working, blob, blobs, hash } = await setup('staged text')
    removeWorking(working())
    blobs.stageDelete(hash)
    unlinkSync(blob)
    expect(await ranged(r, a.id)).toBe('staged text')
    expect(await old(r, a.id)).toBe('staged text')
  })

  it('never-written content (no working file, no current version): ""', async () => {
    const { r, a, working } = await setup('to be forgotten')
    removeWorking(working())
    r.storage.compose((raw) =>
      raw.prepare('UPDATE task_artifacts SET current_version_id=NULL WHERE id=?').run(a.id)
    )
    expect(await old(r, a.id)).toBe('')
    expect(await ranged(r, a.id)).toBe('')
  })

  it('a folder id: refused alike', async () => {
    const r = runtime()
    const folder = (await r.artifacts.invoke({
      route,
      method: 'createFolder',
      operationId: 'folder',
      args: [{ taskId: 't', name: 'F' }]
    })) as { id: string }
    const oldError = await old(r, folder.id).then(
      () => null,
      (e: Error) => e.message
    )
    const rangedError = await ranged(r, folder.id).then(
      () => null,
      (e: Error) => e.message
    )
    expect(oldError).not.toBeNull()
    expect(rangedError).toBe(oldError)
  })

  it('a renamed artifact', async () => {
    const { r, a } = await setup('named')
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      operationId: 'rename',
      args: [{ id: a.id, title: 'renamed.txt' }]
    })
    expect(await ranged(r, a.id)).toBe(await old(r, a.id))
    expect(await ranged(r, a.id)).toBe('named')
  })

  it('bytes and version reads restore a GC-staged blob too (as BlobStore.read does)', async () => {
    const { r, a, working, blob, blobs, hash } = await setup('bytes text')
    removeWorking(working())
    blobs.stageDelete(hash)
    unlinkSync(blob)
    expect(Buffer.from((await readAll(r, a.id, { kind: 'bytes' })).bytes).toString()).toBe(
      'bytes text'
    )
    expect(
      Buffer.from((await readAll(r, a.id, { kind: 'version', ref: 1 })).bytes).toString()
    ).toBe('bytes text')
  })

  it('an asynchronously unreadable fallback preserves empty-string parity', async () => {
    const { r, a, working, blob } = await setup('unreadable fallback')
    removeWorking(working())
    const handle = await open(blob, 'r'),
      prototype = Object.getPrototypeOf(handle)
    await handle.close()
    vi.spyOn(prototype, 'read').mockRejectedValueOnce(new Error('simulated EIO'))
    try {
      expect(await ranged(r, a.id)).toBe('')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it.each(['paused', 'epoch', 'moved', 'erased', 'closed'] as const)(
    'delayed fallback verification obeys %s fences and drains its native handle',
    async (state) => {
      const { r, a, working, blob } = await setup('private fallback content'.repeat(30000))
      removeWorking(working())
      const handle = await open(blob, 'r'),
        prototype = Object.getPrototypeOf(handle)
      await handle.close()
      const read = prototype.read
      let resume!: () => void,
        entered = false
      const gate = new Promise<void>((resolve) => {
        resume = resolve
      })
      vi.spyOn(prototype, 'read').mockImplementationOnce(async function (
        this: FileHandle,
        ...args: unknown[]
      ) {
        entered = true
        await gate
        return read.apply(this, args)
      })
      const reading = r.artifacts
        .invoke({
          route,
          method: 'readRange',
          args: [a.id, { kind: 'content' }, 0, BYTE_RANGE_MAX_CHUNK]
        })
        .then(
          (value) => value,
          (error: Error) => error
        )
      let drain: Promise<unknown> | undefined,
        drained = false
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 })
        if (state === 'paused') await r.applyTaskLifecycle('t', 'paused', 2)
        if (state === 'epoch')
          r.storage.compose((db) =>
            db.prepare("UPDATE conversations SET epoch=2 WHERE id='c'").run()
          )
        if (state === 'moved')
          await r.artifacts.invoke({
            route: { id: 'c2', epoch: 1 },
            method: 'moveToTask',
            operationId: 'move',
            args: [{ sourceTaskId: 't', artifactIds: [a.id], folderIds: [], destFolderId: null }]
          })
        if (state === 'erased' || state === 'closed') {
          drain = (state === 'erased' ? r.eraseTask('t', 2) : r.close()).then((result) => {
            drained = true
            return result
          })
          await new Promise((resolve) => setTimeout(resolve, 25))
          expect(drained).toBe(false)
        }
        resume()
        const failure = await reading
        expect(failure).toBeInstanceOf(Error)
        expect(failure).toMatchObject({
          message:
            state === 'closed'
              ? 'Artifact storage is closed'
              : state === 'moved'
                ? 'Artifact is outside this task'
                : 'Artifact ownership or lifecycle changed'
        })
        await drain
      } finally {
        resume()
        await reading
        await drain
        vi.restoreAllMocks()
      }
    }
  )
})
