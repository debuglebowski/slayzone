/**
 * Bounded reads: how anything larger than one computer frame crosses the hub ↔
 * computer link. One shape per kind of payload, used by every such read:
 *
 *  - **lists** → {@link Page}: `{ items, nextCursor }`, each page cut by a byte
 *    and item budget ({@link pageCut}). A page always carries at least one item,
 *    so paging never drops data; an opaque `nextCursor` (null = last page) asks
 *    for the rest. {@link collectPages} loops when a caller needs the whole list.
 *  - **bytes** → {@link ByteRangePage}: one range (≤ {@link BYTE_RANGE_MAX_CHUNK})
 *    of a source at an offset, with the source's `size` and `etag`. A source that
 *    changes between ranges is refused ({@link ByteSourceChangedError}) — two
 *    versions are never stitched together. {@link readByteRanges} yields the
 *    chunks (stream them on), {@link collectByteRanges} assembles them.
 *
 * Pure (no node, no zod): the renderer, the hub and the computer all import it.
 * The wire schemas live with each op; the budgets are asserted against the frame
 * limit in `@slayzone/computer-transport` (`bounded-reads.test.ts` there).
 *
 * @module platform/bounded-reads
 */

/** Byte budget of one page of a list answer (serialized items). 25× under the frame limit. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024

/** Largest range one byte read answers: 256 KiB raw, ~342 KiB base64 per frame. */
export const BYTE_RANGE_MAX_CHUNK = 256 * 1024

/** One page of a list. `nextCursor` null = this is the last page. */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface PageBudget {
  /** Serialized bytes per page (default {@link PAGE_MAX_BYTES}). */
  maxBytes?: number
  /** Items per page (default: unlimited). */
  maxItems?: number
}

/** UTF-8 byte length of `s` (a lone surrogate counts 3, as an encoder writes U+FFFD). */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** UTF-8 bytes of `value` as JSON. */
export function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) ?? 'null')
}

/**
 * How many leading `items` fit one page: as many as fit `budget`, never fewer
 * than one (an item larger than the budget travels alone — paging never drops it).
 * Each item is measured by `sizeOf` (default: its JSON bytes plus a separator).
 */
export function pageCut<T>(
  items: readonly T[],
  budget: PageBudget,
  sizeOf: (item: T) => number = (item) => jsonByteLength(item) + 1
): number {
  const maxBytes = budget.maxBytes ?? PAGE_MAX_BYTES
  const maxItems = budget.maxItems ?? Number.POSITIVE_INFINITY
  let bytes = 0
  let n = 0
  while (n < items.length && n < maxItems) {
    const size = sizeOf(items[n])
    if (n > 0 && bytes + size > maxBytes) break
    bytes += size
    n++
  }
  return n
}

/**
 * Every item of a paged list, in order. `fetch(null)` is the first page; each
 * next call passes the previous page's `nextCursor`. A source that hands back a
 * cursor it already gave is refused (it would loop forever).
 */
export async function collectPages<T>(
  fetch: (cursor: string | null) => Promise<Page<T>>
): Promise<T[]> {
  const all: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  // isolation: fatal — one paged read of one list: a failed page fails the read, never a partial list
  for (;;) {
    const page: Page<T> = await fetch(cursor)
    for (const item of page.items) all.push(item)
    if (page.nextCursor === null) return all
    if (seen.has(page.nextCursor)) throw new Error('paged read did not advance (cursor repeated)')
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

/** One range of a byte source. */
export interface ByteRangePage {
  /** The range, base64. Empty only for an empty source (or at its end). */
  data: string
  /** Offset of `data` in the source — the offset that was asked for. */
  offset: number
  /** Size of the WHOLE source. */
  size: number
  /** `data` reaches the end of the source. */
  eof: boolean
  /** The source's identity (a content hash, or `size:mtime`): constant across its ranges. */
  etag: string
}

/** The source changed between two ranges of one read (other `etag` or `size`). Retry from 0. */
export class ByteSourceChangedError extends Error {
  override name = 'ByteSourceChangedError'
}

/** Restarts a whole read gets when its source changes under it (a file being written). */
export const BYTE_SOURCE_RESTARTS = 2

/**
 * `read()` again from its start when its source changed while it was read
 * ({@link ByteSourceChangedError}), at most `restarts` times; then the change
 * surfaces. Only for reads that have handed out no bytes yet (a collected read, a
 * response whose headers are not sent).
 */
export async function retryByteSourceChanges<T>(
  read: () => Promise<T>,
  restarts = BYTE_SOURCE_RESTARTS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (err) {
      if (!(err instanceof ByteSourceChangedError) || attempt >= restarts) throw err
    }
  }
}

export interface Sha256Hasher {
  update(bytes: Uint8Array): void
  /** Lower-case hex. */
  digest(): string
}

export interface ReadByteRangesOptions {
  /** Range size asked per call (default and max {@link BYTE_RANGE_MAX_CHUNK}). */
  chunkBytes?: number
  /**
   * Verify the whole source against a sha256 at its end (hashed as it streams):
   * a known digest, or `'etag'` = the source's etag when it is one (64 hex, a
   * content-addressed source; any other etag is not a hash and is not checked).
   */
  sha256?: { expect: string; create: () => Sha256Hasher }
}

function decodeBase64(data: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer
  if (B) return new Uint8Array(B.from(data, 'base64'))
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * A byte source read range by range: `fetch(offset, length)` answers one range.
 * Yields each range's bytes in order. Refuses (throws) a range at another offset,
 * a source whose `etag`/`size` changes ({@link ByteSourceChangedError}), a range
 * that makes no progress, an end before `size`, bytes beyond it, and — with
 * `sha256` — a whole that does not hash to the expected digest. The range reaching
 * `size` must confirm EOF; final size/hash checks run before yielding its bytes,
 * so an integrity failure cannot complete a streamed Content-Length response.
 */
export async function* readByteRanges(
  fetch: (offset: number, length: number) => Promise<ByteRangePage>,
  opts: ReadByteRangesOptions = {}
): AsyncGenerator<Uint8Array, void, void> {
  const chunk = Math.max(1, Math.min(opts.chunkBytes ?? BYTE_RANGE_MAX_CHUNK, BYTE_RANGE_MAX_CHUNK))
  const hasher = opts.sha256?.create()
  let offset = 0
  let identity: { size: number; etag: string } | null = null
  for (;;) {
    const page = await fetch(offset, chunk)
    if (page.offset !== offset)
      throw new Error(`byte read: range at offset ${page.offset}, asked ${offset}`)
    if (!identity) identity = { size: page.size, etag: page.etag }
    else if (page.size !== identity.size || page.etag !== identity.etag)
      throw new ByteSourceChangedError('byte read: the source changed while it was read')
    const bytes = decodeBase64(page.data)
    if (offset + bytes.length > identity.size) throw new Error('byte read: data beyond its size')
    if (bytes.length === 0 && !page.eof) throw new Error('byte read: range made no progress')
    offset += bytes.length
    if (bytes.length > 0) hasher?.update(bytes)
    if (page.eof) {
      if (offset !== identity.size) throw new Error('byte read: source ended before its size')
      const expected =
        opts.sha256?.expect === 'etag'
          ? /^[0-9a-f]{64}$/i.test(identity.etag)
            ? identity.etag
            : null
          : (opts.sha256?.expect ?? null)
      if (hasher && expected !== null && hasher.digest() !== expected.toLowerCase())
        throw new Error('byte read: sha256 mismatch')
      // HTTP clients may accept Content-Length bytes before the generator resumes.
      // Final size/hash checks must finish before those last bytes leave this iterator.
      if (bytes.length > 0) yield bytes
      return
    }
    if (offset === identity.size) throw new Error('byte read: source reached its size without eof')
    if (bytes.length > 0) yield bytes
  }
}

/** {@link readByteRanges}, assembled into one buffer. */
export async function collectByteRanges(
  fetch: (offset: number, length: number) => Promise<ByteRangePage>,
  opts: ReadByteRangesOptions = {}
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of readByteRanges(fetch, opts)) {
    parts.push(part)
    total += part.length
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}
