/**
 * Tests for the macOS auto-update manifest: the OS-minimum stamp and the per-arch merge.
 * A Mac below the new Electron's minimum must be told to skip the update, and the merge
 * of the arm64 + x64 manifests must not drop that.
 *
 * Run with: npx tsx scripts/release/update-manifest.test.mjs
 */
import { mergeManifests, parseManifest } from './merge-update-manifest.mjs'
import { darwinVersionForMacos, stampMinimumSystemVersion } from './stamp-min-system-version.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ? `${label}: ` : ''}expected ${b}, got ${a}`)
}

const manifest = (arch) => `version: 0.37.0
files:
  - url: SlayZone-${arch}.zip
    sha512: ${arch}zip
    size: 100
  - url: SlayZone-${arch}.dmg
    sha512: ${arch}dmg
    size: 200
path: SlayZone-${arch}.zip
sha512: ${arch}zip
releaseDate: '2026-10-25T12:00:00.000Z'
`

console.log('update-manifest')

test('macOS version → Darwin version os.release() reports', () => {
  eq(darwinVersionForMacos('11.0'), '20.0.0')
  eq(darwinVersionForMacos('12.0'), '21.0.0')
  eq(darwinVersionForMacos('13.0'), '22.0.0', 'Electron 44 minimum')
  eq(darwinVersionForMacos('15.4'), '24.0.0')
  eq(darwinVersionForMacos('26.0'), '25.0.0', 'year-based macOS 26 = Darwin 25')
})

test('a pre-Big-Sur or garbage minimum is refused, never guessed', () => {
  for (const v of ['10.15', 'x']) {
    let threw = false
    try {
      darwinVersionForMacos(v)
    } catch {
      threw = true
    }
    eq(threw, true, v)
  }
})

test('stamp adds minimumSystemVersion as a top-level key', () => {
  const out = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  eq(parseManifest(out).top.minimumSystemVersion, '22.0.0')
  eq(parseManifest(out).files.length, 2, 'files untouched')
})

test('stamping twice replaces, never duplicates', () => {
  const once = stampMinimumSystemVersion(manifest('arm64'), '21.0.0')
  const twice = stampMinimumSystemVersion(once, '22.0.0')
  eq(
    twice.split('\n').filter((l) => l.startsWith('minimumSystemVersion:')),
    ['minimumSystemVersion: 22.0.0']
  )
})

test('merge keeps the stamp and unions both arches', () => {
  const arm = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  const x64 = stampMinimumSystemVersion(manifest('x64'), '22.0.0')
  const merged = parseManifest(mergeManifests(arm, x64))
  eq(merged.top.minimumSystemVersion, '22.0.0')
  eq(
    merged.files.map((f) => f.url),
    ['SlayZone-arm64.zip', 'SlayZone-arm64.dmg', 'SlayZone-x64.zip', 'SlayZone-x64.dmg']
  )
})

test('merge keeps the stamp when only the incoming manifest has it', () => {
  const merged = parseManifest(
    mergeManifests(manifest('arm64'), stampMinimumSystemVersion(manifest('x64'), '22.0.0'))
  )
  eq(merged.top.minimumSystemVersion, '22.0.0')
})

test('merge of two different minimums keeps the stricter one', () => {
  const a = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  const b = stampMinimumSystemVersion(manifest('x64'), '21.0.0')
  eq(parseManifest(mergeManifests(a, b)).top.minimumSystemVersion, '22.0.0')
  eq(parseManifest(mergeManifests(b, a)).top.minimumSystemVersion, '22.0.0')
})

test('an unstamped merge is byte-identical to before (no new keys)', () => {
  const out = mergeManifests(manifest('arm64'), manifest('x64'))
  eq(out.includes('minimumSystemVersion'), false)
  eq(out.startsWith('version: 0.37.0\nfiles:\n'), true)
  eq(out.endsWith("releaseDate: '2026-10-25T12:00:00.000Z'\n"), true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
