/**
 * getArtifactsDataRoot resolution: `<SLAYZONE_ROOT>` itself, flat (the single
 * data-root, same as hub/db.ts + ensureDataRoot) — so artifacts and the SQLite
 * DB always resolve to the same dir. The former DB_DIR fallback is gone
 * (SLAYZONE_DB_DIR retired in favor of the ROOT-derived data dir).
 *
 * Pure Node (no native deps).
 */
import { afterEach, expect, test } from 'vitest'
import { getArtifactsDataRoot } from './shared'

const prevRoot = process.env.SLAYZONE_ROOT
const prevDbDir = process.env.SLAYZONE_DB_DIR
afterEach(() => {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  if (prevDbDir === undefined) delete process.env.SLAYZONE_DB_DIR
  else process.env.SLAYZONE_DB_DIR = prevDbDir
})

// <ROOT> itself is the data root — flat, no storage/ subfolder.
test('data root derives as <ROOT>, flat', () => {
  delete process.env.SLAYZONE_DB_DIR
  process.env.SLAYZONE_ROOT = '/tmp/store-root'
  expect(getArtifactsDataRoot()).toBe('/tmp/store-root')
})

// A leftover SLAYZONE_DB_DIR is IGNORED (retired) — the root still derives from ROOT.
test('retired SLAYZONE_DB_DIR is ignored (not the data root)', () => {
  process.env.SLAYZONE_ROOT = '/tmp/root-only'
  process.env.SLAYZONE_DB_DIR = '/tmp/dbdir-only'
  expect(getArtifactsDataRoot()).toBe('/tmp/root-only')
})
