/**
 * Staged uploads over the computer protocol (FU1 S3): `upload.begin` / `upload.chunk`
 * stage bytes in ≤ 256 KiB chunks; `attachment.put` (like the artifact uploads) takes
 * them by hash instead of one inline base64 frame. Every check the inline bytes get
 * still applies — here an attachment's per-kind size limit.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import type { createChatRuntimeHandlers } from './chat-runtime'
import { createFixtureChatRuntime } from '../project-scope.fixture'

const dirs: string[] = []
const handles: Array<ReturnType<typeof createChatRuntimeHandlers>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-uploads-'))
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
  await h.request({
    kind: 'bootstrap',
    value: {
      identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: realpathSync(tmpdir()),
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }
  })
  return h
}

const route = { id: 'c', epoch: 1 }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

async function stage(h: Awaited<ReturnType<typeof setup>>, bytes: Buffer, owned = false) {
  const sha256 = sha(bytes)
  const begun = (await h.request({
    kind: 'upload.begin',
    sha256,
    size: bytes.length,
    ...(owned ? { route, operationId: randomUUID() } : {})
  })) as {
    received: number
    uploadId?: string
  }
  if (owned) expect(begun.uploadId).toBeTruthy()
  for (let offset = begun.received; offset < bytes.length; offset += BYTE_RANGE_MAX_CHUNK)
    await h.request({
      kind: 'upload.chunk',
      sha256,
      size: bytes.length,
      offset,
      ...(begun.uploadId ? { route, uploadId: begun.uploadId } : {}),
      data: bytes.subarray(offset, offset + BYTE_RANGE_MAX_CHUNK).toString('base64')
    })
  return { sha256, size: bytes.length, ...(begun.uploadId ? { uploadId: begun.uploadId } : {}) }
}

test.each([false, true])(
  'an attachment put from staged bytes reads back exactly (owned=%s)',
  async (owned) => {
    const h = await setup()
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(BYTE_RANGE_MAX_CHUNK * 2)])
    const staged = await stage(h, pdf, owned)
    const ref = await h.request({
      kind: 'attachment.put',
      route,
      ref: {
        artifactId: 'a1',
        name: 'doc.pdf',
        kind: 'pdf',
        mediaType: 'application/pdf',
        size: pdf.length
      },
      staged
    })
    const back = (await h.request({ kind: 'attachment.read', route, ref })) as { data: string }
    expect(Buffer.from(back.data, 'base64').equals(pdf)).toBe(true)
  }
)

test.each([false, true])(
  'per-kind attachment size limit still applies to staging (owned=%s)',
  async (owned) => {
    const h = await setup()
    const text = Buffer.from('x'.repeat(300 * 1024)) // over the 256 KiB text limit
    const ref = {
      artifactId: 'big',
      name: 'big.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: text.length
    }
    const inline = await h
      .request({ kind: 'attachment.put', route, ref, data: text.toString('base64') })
      .then(
        () => null,
        (e: Error) => e.message
      )
    expect(inline).not.toBeNull()
    const staged = await stage(h, text, owned)
    const viaStaging = await h.request({ kind: 'attachment.put', route, ref, staged }).then(
      () => null,
      (e: Error) => e.message
    )
    expect(viaStaging).toBe(inline)
  }
)

test('a chunk over one range, or a put naming both or neither, is refused', async () => {
  const h = await setup()
  const big = randomBytes(BYTE_RANGE_MAX_CHUNK + 1)
  await h.request({ kind: 'upload.begin', sha256: sha(big), size: big.length })
  await expect(
    h.request({
      kind: 'upload.chunk',
      sha256: sha(big),
      size: big.length,
      offset: 0,
      data: big.toString('base64')
    })
  ).rejects.toThrow()
  const ref = { artifactId: 'n', name: 'n.txt', kind: 'text', mediaType: 'text/plain', size: 1 }
  await expect(h.request({ kind: 'attachment.put', route, ref })).rejects.toThrow()
  await expect(
    h.request({
      kind: 'attachment.put',
      route,
      ref,
      data: 'eA==',
      staged: { sha256: sha(Buffer.from('x')), size: 1 }
    })
  ).rejects.toThrow()
})
