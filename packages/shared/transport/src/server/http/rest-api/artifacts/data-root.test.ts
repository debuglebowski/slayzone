/**
 * getArtifactsDataRoot resolution: `<SLAYZONE_ROOT>/storage` (the single
 * data-root, same as hub/db.ts + ensureDataRoot) — so artifacts and the SQLite
 * DB always resolve to the same dir. The former DB_DIR fallback is gone
 * (SLAYZONE_DB_DIR retired in favor of the ROOT-derived storage dir).
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 */
import { join } from 'node:path'
import { getArtifactsDataRoot } from './shared'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

const prevRoot = process.env.SLAYZONE_ROOT
const prevDbDir = process.env.SLAYZONE_DB_DIR
try {
  // <ROOT>/storage is the data root.
  delete process.env.SLAYZONE_DB_DIR
  process.env.SLAYZONE_ROOT = '/tmp/store-root'
  check(
    'data root derives as <ROOT>/storage',
    getArtifactsDataRoot() === join('/tmp/store-root', 'storage'),
    `got ${getArtifactsDataRoot()}`
  )

  // A leftover SLAYZONE_DB_DIR is IGNORED (retired) — the root still derives from ROOT.
  process.env.SLAYZONE_ROOT = '/tmp/root-only'
  process.env.SLAYZONE_DB_DIR = '/tmp/dbdir-only'
  check(
    'retired SLAYZONE_DB_DIR is ignored (not the data root)',
    getArtifactsDataRoot() === join('/tmp/root-only', 'storage'),
    `got ${getArtifactsDataRoot()}`
  )
} finally {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  if (prevDbDir === undefined) delete process.env.SLAYZONE_DB_DIR
  else process.env.SLAYZONE_DB_DIR = prevDbDir
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
