/**
 * What the composer does with a picked / pasted / dropped file before it is
 * uploaded: check what it is (by content), convert images Claude can't take,
 * shrink images over the limits, refuse what can't be sent — with a reason.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/task-terminals/src/client/chat/attachments/prepare-attachment.test.ts
 */
import { describe, expect, test } from 'vitest'
import { prepareAttachmentFile, type ImageCodec } from './prepare-attachment'

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0]
const file = (bytes: number[] | Uint8Array<ArrayBuffer> | string, name: string, type = ''): File =>
  new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], name, { type })
const sized = (head: number[], size: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(size)
  b.set(head)
  return b
}

/** A codec that reports `dims` and "encodes" to a blob of `encodedSize(attempt)` bytes. */
function codec(
  dims: { width: number; height: number } | null,
  encodedSize: (opts: { maxDimension: number; type: string; quality?: number }) => number = () =>
    1000
): ImageCodec & { calls: Array<{ maxDimension: number; type: string; quality?: number }> } {
  const calls: Array<{ maxDimension: number; type: string; quality?: number }> = []
  return {
    calls,
    size: async () => dims,
    encode: async (_blob, opts) => {
      calls.push(opts)
      const head = opts.type === 'image/png' ? PNG_HEAD : JPEG_HEAD
      return new Blob([sized(head, encodedSize(opts))], { type: opts.type })
    }
  }
}

describe('prepareAttachmentFile', () => {
  test('a small image within the limits goes as is', async () => {
    const f = file(sized(PNG_HEAD, 2000), 'shot.png', 'image/png')
    const c = codec({ width: 800, height: 600 })
    const out = await prepareAttachmentFile(f, c)
    expect(out).toEqual({ ok: true, file: f, kind: 'image', mediaType: 'image/png' })
    expect(c.calls).toEqual([])
  })

  test('a large image is scaled to 2000 px (TUI parity), keeping PNG', async () => {
    const f = file(sized(PNG_HEAD, 3000), 'wide.png', 'image/png')
    const c = codec({ width: 3000, height: 1000 })
    const out = await prepareAttachmentFile(f, c)
    expect(c.calls).toEqual([{ maxDimension: 2000, type: 'image/png' }])
    expect(out).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png' })
    if (out.ok) expect(out.file.name).toBe('wide.png')
  })

  test('still too big after scaling: JPEG at lower quality, then smaller, until it fits', async () => {
    const f = file(sized(PNG_HEAD, 9 * 1024 * 1024), 'photo.png', 'image/png')
    const fits = 3 * 1024 * 1024
    const c = codec({ width: 1500, height: 1500 }, (o) =>
      o.type === 'image/jpeg' && (o.quality ?? 1) <= 0.7 ? fits : 8 * 1024 * 1024
    )
    const out = await prepareAttachmentFile(f, c)
    expect(out).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/jpeg' })
    if (out.ok) expect(out.file.name).toBe('photo.jpg')
    expect(c.calls.at(-1)).toMatchObject({ type: 'image/jpeg', quality: 0.7 })
  })

  test('BMP / AVIF are converted to PNG; HEIC is refused with a hint', async () => {
    const bmp = file(
      [0x42, 0x4d, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0],
      'scan.bmp',
      'image/bmp'
    )
    const out = await prepareAttachmentFile(bmp, codec({ width: 10, height: 10 }))
    expect(out).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png' })
    if (out.ok) expect(out.file.name).toBe('scan.png')
    const heic = file(
      [0, 0, 0, 24, ...Array.from('ftypheic', (c) => c.charCodeAt(0))],
      'IMG_1.heic'
    )
    expect(await prepareAttachmentFile(heic, codec(null))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/HEIC/)
    })
  })

  test('an image this platform cannot decode is refused', async () => {
    const f = file(sized(PNG_HEAD, 100), 'broken.png', 'image/png')
    expect(await prepareAttachmentFile(f, codec(null))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/broken\.png/)
    })
  })

  test('PDF and text: by content, with their size caps', async () => {
    expect(await prepareAttachmentFile(file('%PDF-1.7\n', 'a.pdf'), codec(null))).toMatchObject({
      ok: true,
      kind: 'pdf',
      mediaType: 'application/pdf'
    })
    expect(await prepareAttachmentFile(file('const x = 1\n', 'x.ts'), codec(null))).toMatchObject({
      ok: true,
      kind: 'text',
      mediaType: 'text/plain'
    })
    const big = await prepareAttachmentFile(file('a'.repeat(300 * 1024), 'big.log'), codec(null))
    expect(big).toMatchObject({ ok: false, reason: expect.stringMatching(/@path/) })
  })

  test('anything else is refused with what Claude can read', async () => {
    const out = await prepareAttachmentFile(
      file([0x50, 0x4b, 3, 4, 1, 2], 'report.docx'),
      codec(null)
    )
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/report\.docx.*PDFs/) })
  })
})
