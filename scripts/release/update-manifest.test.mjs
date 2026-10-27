/**
 * Tests for the macOS auto-update manifest: the OS-minimum stamp and the per-arch merge.
 * A Mac below the new Electron's minimum must be told to skip the update, and the merge
 * of the arm64 + x64 manifests must not drop that.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { mergeManifests, parseManifest } from './merge-update-manifest.mjs'
import { darwinVersionForMacos, stampMinimumSystemVersion } from './stamp-min-system-version.mjs'

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

test('macOS version → Darwin version os.release() reports', () => {
  expect(darwinVersionForMacos('11.0')).toBe('20.0.0')
  expect(darwinVersionForMacos('12.0')).toBe('21.0.0')
  expect(darwinVersionForMacos('13.0'), 'Electron 44 minimum').toBe('22.0.0')
  expect(darwinVersionForMacos('15.4')).toBe('24.0.0')
  expect(darwinVersionForMacos('26.0'), 'year-based macOS 26 = Darwin 25').toBe('25.0.0')
})

test('a pre-Big-Sur or garbage minimum is refused, never guessed', () => {
  for (const v of ['10.15', 'x']) {
    expect(() => darwinVersionForMacos(v), v).toThrow()
  }
})

test('stamp adds minimumSystemVersion as a top-level key', () => {
  const out = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  expect(parseManifest(out).top.minimumSystemVersion).toBe('22.0.0')
  expect(parseManifest(out).files, 'files untouched').toHaveLength(2)
})

test('stamping twice replaces, never duplicates', () => {
  const once = stampMinimumSystemVersion(manifest('arm64'), '21.0.0')
  const twice = stampMinimumSystemVersion(once, '22.0.0')
  expect(twice.split('\n').filter((l) => l.startsWith('minimumSystemVersion:'))).toEqual([
    'minimumSystemVersion: 22.0.0'
  ])
})

test('merge keeps the stamp and unions both arches', () => {
  const arm = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  const x64 = stampMinimumSystemVersion(manifest('x64'), '22.0.0')
  const merged = parseManifest(mergeManifests(arm, x64))
  expect(merged.top.minimumSystemVersion).toBe('22.0.0')
  expect(merged.files.map((f) => f.url)).toEqual([
    'SlayZone-arm64.zip',
    'SlayZone-arm64.dmg',
    'SlayZone-x64.zip',
    'SlayZone-x64.dmg'
  ])
})

test('merge keeps the stamp when only the incoming manifest has it', () => {
  const merged = parseManifest(
    mergeManifests(manifest('arm64'), stampMinimumSystemVersion(manifest('x64'), '22.0.0'))
  )
  expect(merged.top.minimumSystemVersion).toBe('22.0.0')
})

test('merge of two different minimums keeps the stricter one', () => {
  const a = stampMinimumSystemVersion(manifest('arm64'), '22.0.0')
  const b = stampMinimumSystemVersion(manifest('x64'), '21.0.0')
  expect(parseManifest(mergeManifests(a, b)).top.minimumSystemVersion).toBe('22.0.0')
  expect(parseManifest(mergeManifests(b, a)).top.minimumSystemVersion).toBe('22.0.0')
})

test('an unstamped merge is byte-identical to before (no new keys)', () => {
  const out = mergeManifests(manifest('arm64'), manifest('x64'))
  expect(out).not.toContain('minimumSystemVersion')
  expect(out.startsWith('version: 0.37.0\nfiles:\n')).toBe(true)
  expect(out.endsWith("releaseDate: '2026-10-25T12:00:00.000Z'\n")).toBe(true)
})
