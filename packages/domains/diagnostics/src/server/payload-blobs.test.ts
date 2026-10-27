/**
 * Tests for offloadPayloadBlobs — the fix for screenshots being silently
 * truncated to uselessness by the payload redactor's 4096-char trim.
 */
import { describe, expect, test } from 'vitest'
import { offloadPayloadBlobs, type BlobWriter } from './payload-blobs'
import { redactValue } from './diagnostics-store'

/** Recording writer; also captures the bytes so size can be asserted. */
function recordingWriter(): BlobWriter & { writes: Array<{ size: number; extension: string }> } {
  const writes: Array<{ size: number; extension: string }> = []
  return {
    writes,
    write(bytes, extension) {
      writes.push({ size: bytes.length, extension })
      return `/storage/diagnostics/blob-${writes.length}.${extension}`
    }
  }
}

/** A data URL of roughly `bytes` decoded length. */
function pngDataUrl(bytes: number): string {
  // Real PNG magic so the payload is plausible, padded to length.
  const raw = '\x89PNG\r\n\x1a\n' + 'A'.repeat(Math.max(0, bytes - 8))
  let binary = ''
  for (let i = 0; i < raw.length; i++) binary += raw[i]
  return `data:image/png;base64,${btoa(binary)}`
}

describe('offloadPayloadBlobs', () => {
  test('a large screenshot data URL is written out and replaced by a path', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs(
      { reason: 'canary', screenshotDataUrl: pngDataUrl(200_000) },
      w
    ) as Record<string, unknown>
    expect(w.writes.length, 'one blob written').toBe(1)
    expect(w.writes[0].extension).toBe('png')
    expect(w.writes[0].size, 'full image written').toBeGreaterThan(190_000)
    expect(out.screenshotDataUrl).toBe('/storage/diagnostics/blob-1.png')
    expect(out.reason, 'sibling fields untouched').toBe('canary')
  })

  test('the recorded path survives the redactor intact — the whole point', () => {
    // Pre-fix the payload held a 175-390KB data URL and the redactor trimmed it to
    // 4096 chars, so ~99% of every screenshot was discarded.
    //
    // `redactValue` is used here rather than `buildPayloadJson` deliberately:
    // buildPayloadJson now runs the real filesystem writer, and a unit test must not
    // write into the live storage dir. This asserts the half that matters — that the
    // offloaded value is short enough to pass the trim untouched.
    const w = recordingWriter()
    const offloaded = offloadPayloadBlobs({ screenshotDataUrl: pngDataUrl(200_000) }, w)
    const json = JSON.stringify(redactValue(offloaded))
    expect(json, 'nothing trimmed').not.toContain('[trimmed:')
    expect(json, 'path recorded').toContain('blob-1.png')
    expect(json.length, 'payload is small now').toBeLessThan(500)
  })

  test('WITHOUT the offload the same payload is still truncated (guards the premise)', () => {
    // Demonstrates the bug this module fixes, so the test above cannot silently stop
    // measuring anything if the trim limit changes.
    const json = JSON.stringify(redactValue({ screenshotDataUrl: pngDataUrl(200_000) }))
    expect(json, 'raw data URL is truncated by the redactor').toContain('[trimmed:')
  })

  test('a short data URL is left alone (no inode for nothing)', () => {
    const w = recordingWriter()
    const url = pngDataUrl(100)
    const out = offloadPayloadBlobs({ screenshotDataUrl: url }, w) as Record<string, unknown>
    expect(w.writes.length, 'no blob written').toBe(0)
    expect(out.screenshotDataUrl, 'value preserved verbatim').toBe(url)
  })

  test('null / absent screenshot fields are preserved', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs({ screenshotDataUrl: null, reason: 'frame-time' }, w) as Record<
      string,
      unknown
    >
    expect(out.screenshotDataUrl).toBe(null)
    expect(out.reason).toBe('frame-time')
    expect(w.writes.length).toBe(0)
  })

  test('a writer failure degrades to a marker, never throws', () => {
    const throwing: BlobWriter = {
      write() {
        throw new Error('ENOSPC')
      }
    }
    const out = offloadPayloadBlobs({ screenshotDataUrl: pngDataUrl(200_000) }, throwing) as Record<
      string,
      unknown
    >
    expect(String(out.screenshotDataUrl), 'marker recorded').toMatch(/^\[BLOB_WRITE_FAILED:/)
  })

  test('a malformed data URL is marked, not written', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs({ screenshotDataUrl: 'x'.repeat(5000) }, w) as Record<
      string,
      unknown
    >
    expect(w.writes.length).toBe(0)
    expect(out.screenshotDataUrl).toBe('[UNDECODABLE_DATA_URL]')
  })

  test('nested payloads are walked', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs(
      { outer: { inner: { screenshotDataUrl: pngDataUrl(50_000) } } },
      w
    ) as { outer: { inner: { screenshotDataUrl: string } } }
    expect(w.writes.length).toBe(1)
    expect(out.outer.inner.screenshotDataUrl).toBe('/storage/diagnostics/blob-1.png')
  })

  test('arrays are walked and order preserved', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs(
      [{ screenshotDataUrl: pngDataUrl(50_000) }, { screenshotDataUrl: pngDataUrl(60_000) }],
      w
    ) as Array<{ screenshotDataUrl: string }>
    expect(w.writes.length).toBe(2)
    expect(out[0].screenshotDataUrl).toBe('/storage/diagnostics/blob-1.png')
    expect(out[1].screenshotDataUrl).toBe('/storage/diagnostics/blob-2.png')
  })

  test('the input payload is not mutated', () => {
    const w = recordingWriter()
    const input = { screenshotDataUrl: pngDataUrl(50_000) }
    const original = input.screenshotDataUrl
    offloadPayloadBlobs(input, w)
    expect(input.screenshotDataUrl, 'caller-owned object untouched').toBe(original)
  })

  test('non-blob long strings are NOT offloaded (scope stays narrow)', () => {
    const w = recordingWriter()
    const out = offloadPayloadBlobs({ someOtherField: pngDataUrl(50_000) }, w) as Record<
      string,
      unknown
    >
    expect(w.writes.length, 'only known blob fields are offloaded').toBe(0)
    expect(typeof out.someOtherField, 'left for the redactor to handle').toBe('string')
  })
})
