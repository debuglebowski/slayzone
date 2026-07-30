/**
 * Tests for offloadPayloadBlobs — the fix for screenshots being silently
 * truncated to uselessness by the payload redactor's 4096-char trim.
 *
 * Run with: pnpm exec tsx packages/domains/diagnostics/src/server/payload-blobs.test.ts
 */
import { offloadPayloadBlobs, type BlobWriter } from './payload-blobs'
import { redactValue } from './diagnostics-store'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

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

console.log('\noffloadPayloadBlobs')
console.log('─'.repeat(40))

test('a large screenshot data URL is written out and replaced by a path', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs({ reason: 'canary', screenshotDataUrl: pngDataUrl(200_000) }, w) as
    Record<string, unknown>
  eq(w.writes.length, 1, 'one blob written')
  eq(w.writes[0].extension, 'png')
  ok(w.writes[0].size > 190_000, `full image written, got ${w.writes[0].size}B`)
  eq(out.screenshotDataUrl, '/storage/diagnostics/blob-1.png')
  eq(out.reason, 'canary', 'sibling fields untouched')
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
  ok(!json.includes('[trimmed:'), `nothing trimmed, got ${json.slice(0, 120)}`)
  ok(json.includes('blob-1.png'), 'path recorded')
  ok(json.length < 500, `payload is small now, got ${json.length} bytes`)
})

test('WITHOUT the offload the same payload is still truncated (guards the premise)', () => {
  // Demonstrates the bug this module fixes, so the test above cannot silently stop
  // measuring anything if the trim limit changes.
  const json = JSON.stringify(redactValue({ screenshotDataUrl: pngDataUrl(200_000) }))
  ok(json.includes('[trimmed:'), 'raw data URL is truncated by the redactor')
})

test('a short data URL is left alone (no inode for nothing)', () => {
  const w = recordingWriter()
  const url = pngDataUrl(100)
  const out = offloadPayloadBlobs({ screenshotDataUrl: url }, w) as Record<string, unknown>
  eq(w.writes.length, 0, 'no blob written')
  eq(out.screenshotDataUrl, url, 'value preserved verbatim')
})

test('null / absent screenshot fields are preserved', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs({ screenshotDataUrl: null, reason: 'frame-time' }, w) as
    Record<string, unknown>
  eq(out.screenshotDataUrl, null)
  eq(out.reason, 'frame-time')
  eq(w.writes.length, 0)
})

test('a writer failure degrades to a marker, never throws', () => {
  const throwing: BlobWriter = {
    write() {
      throw new Error('ENOSPC')
    }
  }
  const out = offloadPayloadBlobs({ screenshotDataUrl: pngDataUrl(200_000) }, throwing) as
    Record<string, unknown>
  ok(
    String(out.screenshotDataUrl).startsWith('[BLOB_WRITE_FAILED:'),
    `marker recorded, got ${out.screenshotDataUrl}`
  )
})

test('a malformed data URL is marked, not written', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs({ screenshotDataUrl: 'x'.repeat(5000) }, w) as
    Record<string, unknown>
  eq(w.writes.length, 0)
  eq(out.screenshotDataUrl, '[UNDECODABLE_DATA_URL]')
})

test('nested payloads are walked', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs(
    { outer: { inner: { screenshotDataUrl: pngDataUrl(50_000) } } },
    w
  ) as { outer: { inner: { screenshotDataUrl: string } } }
  eq(w.writes.length, 1)
  eq(out.outer.inner.screenshotDataUrl, '/storage/diagnostics/blob-1.png')
})

test('arrays are walked and order preserved', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs(
    [{ screenshotDataUrl: pngDataUrl(50_000) }, { screenshotDataUrl: pngDataUrl(60_000) }],
    w
  ) as Array<{ screenshotDataUrl: string }>
  eq(w.writes.length, 2)
  eq(out[0].screenshotDataUrl, '/storage/diagnostics/blob-1.png')
  eq(out[1].screenshotDataUrl, '/storage/diagnostics/blob-2.png')
})

test('the input payload is not mutated', () => {
  const w = recordingWriter()
  const input = { screenshotDataUrl: pngDataUrl(50_000) }
  const original = input.screenshotDataUrl
  offloadPayloadBlobs(input, w)
  eq(input.screenshotDataUrl, original, 'caller-owned object untouched')
})

test('non-blob long strings are NOT offloaded (scope stays narrow)', () => {
  const w = recordingWriter()
  const out = offloadPayloadBlobs({ someOtherField: pngDataUrl(50_000) }, w) as
    Record<string, unknown>
  eq(w.writes.length, 0, 'only known blob fields are offloaded')
  ok(typeof out.someOtherField === 'string', 'left for the redactor to handle')
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
