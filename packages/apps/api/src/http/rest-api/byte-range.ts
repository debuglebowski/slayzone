/**
 * Single byte-range requests (RFC 9110 §14) for the REST routes that serve file
 * bytes to a player or viewer: `GET /api/files/raw` (workspace files) and
 * `GET /api/artifacts/:id/content` (artifacts). A `<video>`, `<audio>` or the PDF
 * viewer reads through `Range`; without 206s Chromium treats the file as an
 * unseekable stream.
 *
 * Only one `bytes=` range is honoured. Anything else (several ranges, another unit,
 * a malformed or backwards one) is ignored and the whole file served, which the RFC
 * allows a server to do.
 *
 * @module api/http/rest-api/byte-range
 */

/** What a `Range` header asked for, before the size is known. */
export type RangeAsk =
  | { kind: 'none' }
  | { kind: 'from'; start: number; end: number | null }
  | { kind: 'suffix'; length: number }

/** Parse `Range` (`a-b`, `a-`, `-n`). */
export function parseRange(header: string | undefined): RangeAsk {
  if (!header) return { kind: 'none' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return { kind: 'none' }
  const [, a, b] = m
  if (a === '' && b === '') return { kind: 'none' }
  if (a === '') return { kind: 'suffix', length: Number(b) }
  const start = Number(a)
  const end = b === '' ? null : Number(b)
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start)))
    return { kind: 'none' }
  return { kind: 'from', start, end }
}

/** `[start, endExclusive)` to send from a file of `size` bytes, or null when unsatisfiable (416). */
export function resolveRange(ask: RangeAsk, size: number): { start: number; end: number } | null {
  if (ask.kind === 'none') return { start: 0, end: size }
  if (ask.kind === 'suffix') {
    if (ask.length === 0 || size === 0) return null
    return { start: Math.max(0, size - ask.length), end: size }
  }
  if (ask.start >= size) return null
  return { start: ask.start, end: Math.min(size, (ask.end ?? size - 1) + 1) }
}

/** `Content-Range` of a satisfied range. */
export function contentRange(range: { start: number; end: number }, size: number): string {
  return `bytes ${range.start}-${range.end - 1}/${size}`
}

/** `Content-Range` of a 416: the size the range could not be satisfied against. */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`
}
