/**
 * The one page shape (lists) and the one chunk shape (bytes) every bounded
 * computer read uses: a page never drops an item, a chunked read never stitches
 * two versions of a source together.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BYTE_RANGE_MAX_CHUNK,
  ByteSourceChangedError,
  type ByteRangePage,
  collectByteRanges,
  collectPages,
  jsonByteLength,
  PAGE_MAX_BYTES,
  type Page,
  pageCut,
  readByteRanges,
  utf8ByteLength
} from './bounded-reads'

const sha256 = () => {
  const h = createHash('sha256')
  return {
    update: (b: Uint8Array) => {
      h.update(b)
    },
    digest: () => h.digest('hex')
  }
}
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A byte source served in ranges, like a computer answering `bytes.read`. */
function source(bytes: Uint8Array, etag = 'e1') {
  const calls: Array<[number, number]> = []
  const fetch = async (offset: number, length: number): Promise<ByteRangePage> => {
    calls.push([offset, length])
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + length))
    return {
      data: Buffer.from(slice).toString('base64'),
      offset,
      size: bytes.length,
      eof: offset + slice.length >= bytes.length,
      etag
    }
  }
  return { fetch, calls }
}

describe('budgets', () => {
  it('page budget is 4 MiB, chunk 256 KiB', () => {
    expect(PAGE_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(BYTE_RANGE_MAX_CHUNK).toBe(256 * 1024)
  })

  it('utf8ByteLength counts UTF-8 bytes (BMP, astral, lone surrogate)', () => {
    for (const s of ['', 'abc', 'åäö', '日本語', '😀x', '\ud800', 'a\udc00b'])
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'))
    expect(jsonByteLength({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'))
  })
})

describe('pageCut', () => {
  it('takes items until the byte budget, never fewer than one', () => {
    const items = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)]
    // each item = 12 bytes as JSON + 1 separator
    expect(pageCut(items, { maxBytes: 26 })).toBe(2)
    expect(pageCut(items, { maxBytes: 38 })).toBe(2)
    expect(pageCut(items, { maxBytes: 39 })).toBe(3)
    expect(pageCut(items, { maxBytes: 5 })).toBe(1)
    expect(pageCut(items, { maxBytes: 1000 })).toBe(3)
    expect(pageCut([], { maxBytes: 5 })).toBe(0)
  })

  it('honours maxItems and a custom size', () => {
    expect(pageCut([1, 2, 3, 4], { maxItems: 3 })).toBe(3)
    expect(pageCut(['x', 'y', 'z'], { maxBytes: 2 }, () => 1)).toBe(2)
  })

  it('defaults to PAGE_MAX_BYTES', () => {
    const big = 'x'.repeat(PAGE_MAX_BYTES / 2)
    expect(pageCut([big, big, big], {})).toBe(1)
  })
})

describe('collectPages', () => {
  it('concatenates every page in order', async () => {
    const pages: Record<string, Page<number>> = {
      start: { items: [1, 2], nextCursor: 'c1' },
      c1: { items: [3], nextCursor: 'c2' },
      c2: { items: [4, 5], nextCursor: null }
    }
    const seen: Array<string | null> = []
    const all = await collectPages<number>(async (cursor) => {
      seen.push(cursor)
      return pages[cursor ?? 'start']
    })
    expect(all).toEqual([1, 2, 3, 4, 5])
    expect(seen).toEqual([null, 'c1', 'c2'])
  })

  it('refuses a source that repeats a cursor (no progress) instead of looping forever', async () => {
    await expect(collectPages(async () => ({ items: [1], nextCursor: 'same' }))).rejects.toThrow(
      /did not advance/
    )
  })
})

describe('readByteRanges', () => {
  const bytes = new Uint8Array(BYTE_RANGE_MAX_CHUNK * 2 + 1234).map((_, i) => (i * 7) % 251)

  it('reads a source in chunk-sized ranges and reassembles it exactly', async () => {
    const src = source(bytes)
    const all = await collectByteRanges(src.fetch, {
      sha256: { expect: hex(bytes), create: sha256 }
    })
    expect(Buffer.from(all).equals(Buffer.from(bytes))).toBe(true)
    expect(src.calls.length).toBe(3)
    for (const [, length] of src.calls) expect(length).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
  })

  it('an empty source is one call, zero bytes', async () => {
    const src = source(new Uint8Array(0))
    expect((await collectByteRanges(src.fetch)).length).toBe(0)
    expect(src.calls.length).toBe(1)
  })

  it('yields chunk by chunk (a caller can stream it on)', async () => {
    const src = source(bytes)
    const sizes: number[] = []
    for await (const chunk of readByteRanges(src.fetch)) sizes.push(chunk.length)
    expect(sizes).toEqual([BYTE_RANGE_MAX_CHUNK, BYTE_RANGE_MAX_CHUNK, 1234])
  })

  it('a source whose etag or size changes between ranges fails as ByteSourceChangedError', async () => {
    let n = 0
    const changing = async (offset: number, length: number) => {
      const page = await source(bytes).fetch(offset, length)
      return n++ === 0 ? page : { ...page, etag: 'e2' }
    }
    await expect(collectByteRanges(changing)).rejects.toBeInstanceOf(ByteSourceChangedError)
    n = 0
    const growing = async (offset: number, length: number) => {
      const page = await source(bytes).fetch(offset, length)
      return n++ === 0 ? page : { ...page, size: page.size + 1 }
    }
    await expect(collectByteRanges(growing)).rejects.toBeInstanceOf(ByteSourceChangedError)
  })

  it('refuses a range at the wrong offset, an empty non-final range, and a hash mismatch', async () => {
    const wrongOffset = async (offset: number, length: number) => ({
      ...(await source(bytes).fetch(offset, length)),
      offset: offset + 1
    })
    await expect(collectByteRanges(wrongOffset)).rejects.toThrow(/offset/)
    const stuck = async (offset: number) => ({
      data: '',
      offset,
      size: bytes.length,
      eof: false,
      etag: 'e1'
    })
    await expect(collectByteRanges(stuck)).rejects.toThrow(/no progress/)
    await expect(
      collectByteRanges(source(bytes).fetch, { sha256: { expect: '0'.repeat(64), create: sha256 } })
    ).rejects.toThrow(/sha256/)
  })

  it('refuses eof before size, and data beyond size', async () => {
    const early = async (offset: number, length: number) => ({
      ...(await source(bytes).fetch(offset, length)),
      eof: true
    })
    await expect(collectByteRanges(early)).rejects.toThrow(/before its size/)
    const over = async (offset: number, length: number) => ({
      ...(await source(bytes).fetch(offset, length)),
      size: 10
    })
    await expect(collectByteRanges(over)).rejects.toThrow(/beyond its size/)
  })
})
