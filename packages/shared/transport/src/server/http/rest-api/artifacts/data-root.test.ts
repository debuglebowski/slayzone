/**
 * getArtifactsDataRoot resolution: SLAYZONE_STORE_DIR (the single data-root var,
 * same as hub/db.ts + ensureDataRoot) else the platform default — so artifacts
 * and the SQLite DB always resolve to the same dir. The former DB_DIR fallback
 * is gone (SLAYZONE_DB_DIR retired in favor of SLAYZONE_STORE_DIR).
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 */
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

const prevStore = process.env.SLAYZONE_STORE_DIR
const prevDbDir = process.env.SLAYZONE_DB_DIR
try {
  // STORE_DIR is honored when set.
  delete process.env.SLAYZONE_DB_DIR
  process.env.SLAYZONE_STORE_DIR = '/tmp/store-root'
  check(
    'STORE_DIR is used when set',
    getArtifactsDataRoot() === '/tmp/store-root',
    `got ${getArtifactsDataRoot()}`
  )

  // A leftover SLAYZONE_DB_DIR is IGNORED (retired) — falls through to the default.
  delete process.env.SLAYZONE_STORE_DIR
  process.env.SLAYZONE_DB_DIR = '/tmp/dbdir-only'
  check(
    'retired SLAYZONE_DB_DIR is ignored (not the data root)',
    getArtifactsDataRoot() !== '/tmp/dbdir-only',
    `got ${getArtifactsDataRoot()}`
  )
} finally {
  if (prevStore === undefined) delete process.env.SLAYZONE_STORE_DIR
  else process.env.SLAYZONE_STORE_DIR = prevStore
  if (prevDbDir === undefined) delete process.env.SLAYZONE_DB_DIR
  else process.env.SLAYZONE_DB_DIR = prevDbDir
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
