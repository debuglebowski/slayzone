/**
 * Offload oversized data-URL fields out of a diagnostics payload and onto disk.
 *
 * A `data:` URL never belonged in a JSON column. The scramble-detector's canary
 * screenshot (`canvas.toDataURL('image/png')`) is 175–390 KB, and every string in
 * a payload passes through the redactor's 4096-char trim — so ~99% of every
 * recorded screenshot was discarded. Of a 301×1425 PNG only ~11 of 1425 scanlines
 * survived: less than one text row, and the one artifact that would *prove* a
 * frame was scrambled has been unusable since the feature shipped.
 *
 * Raising the trim limit is the wrong fix — it would put hundreds of KB of base64
 * per event into SQLite. Instead the bytes go to a file under the storage dir and
 * the payload keeps a path. Diagnostics stay greppable, the image stays whole.
 *
 * The offload is best-effort by design: a diagnostics write must never throw into
 * the caller (here the WebGL downgrade path). On any failure the field is replaced
 * with a short marker so the record still says a screenshot existed and why it is
 * absent, which is strictly more informative than a truncated blob.
 */

/** Fields offloaded to disk, in any nesting position within the payload. */
const BLOB_FIELDS = new Set(['screenshotDataUrl'])

/**
 * Smallest data URL worth writing to its own file. Below this the value survives
 * the redactor's trim intact, so a file would cost an inode for nothing.
 */
const MIN_OFFLOAD_LENGTH = 2048

/** `data:<mime>;base64,<payload>` — the only form produced by `toDataURL`. */
const DATA_URL = /^data:([\w./+-]+);base64,(.*)$/s

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

export interface BlobWriter {
  /**
   * Persist `bytes` and return a locator to record in the payload (production: an
   * absolute path under `<storage>/diagnostics/`). Throwing is allowed — the
   * caller degrades to a marker rather than propagating.
   */
  write(bytes: Uint8Array, extension: string): string
}

/** Decode the base64 body of a data URL. Returns null when it is not one. */
function decodeDataUrl(value: string): { bytes: Uint8Array; extension: string } | null {
  const match = DATA_URL.exec(value)
  if (!match) return null
  const [, mime, base64] = match
  if (!base64) return null
  let binary: string
  try {
    // Node and the renderer both have atob; Buffer is not available in every
    // consumer of this package.
    binary = atob(base64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { bytes, extension: EXTENSION_BY_MIME[mime] ?? 'bin' }
}

/**
 * Walk `payload` and replace any {@link BLOB_FIELDS} data URL with the locator
 * returned by `writer`. Returns a new value; the input is not mutated.
 *
 * Structure is otherwise preserved exactly, so this composes with the redactor
 * (run this FIRST — afterwards the field is a short path that the trim leaves
 * alone).
 */
export function offloadPayloadBlobs(payload: unknown, writer: BlobWriter): unknown {
  if (payload == null) return payload
  if (Array.isArray(payload)) return payload.map((item) => offloadPayloadBlobs(item, writer))
  if (typeof payload !== 'object') return payload

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (BLOB_FIELDS.has(key) && typeof value === 'string' && value.length >= MIN_OFFLOAD_LENGTH) {
      const decoded = decodeDataUrl(value)
      if (!decoded) {
        output[key] = '[UNDECODABLE_DATA_URL]'
        continue
      }
      try {
        output[key] = writer.write(decoded.bytes, decoded.extension)
      } catch {
        // Losing the image must never lose the event.
        output[key] = `[BLOB_WRITE_FAILED:${decoded.bytes.length}B]`
      }
      continue
    }
    output[key] = offloadPayloadBlobs(value, writer)
  }
  return output
}
