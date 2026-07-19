/**
 * SLAYZONE_MODE resolver + the mode/bind contradiction guard. `remote` declares
 * an internet-facing deployment (auth + TLS/wss hardening on); `local` (default)
 * is loopback/dev. The guard is fail-loud on the DANGEROUS mismatch only:
 *   - mode=local + non-loopback bind = exposed-but-unhardened → throw
 *   - mode=remote + loopback bind = harmless (behind a proxy/tunnel) → no throw
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 */
import { getSlayzoneMode, isRemoteMode, assertModeHostConsistency } from './slayzone-mode'

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

const prev = process.env.SLAYZONE_MODE
try {
  // --- default + parsing ------------------------------------------------------
  delete process.env.SLAYZONE_MODE
  check('defaults to local when unset', getSlayzoneMode() === 'local')
  check('isRemoteMode false by default', isRemoteMode() === false)

  process.env.SLAYZONE_MODE = 'remote'
  check('reads remote', getSlayzoneMode() === 'remote' && isRemoteMode() === true)

  process.env.SLAYZONE_MODE = 'REMOTE'
  check('case-insensitive', getSlayzoneMode() === 'remote')

  process.env.SLAYZONE_MODE = 'garbage'
  check('unknown value falls back to local', getSlayzoneMode() === 'local')

  // --- contradiction guard ----------------------------------------------------
  check(
    'local + loopback host = ok',
    safe(() => assertModeHostConsistency('local', '127.0.0.1'))
  )
  check(
    'local + non-loopback host = THROWS (exposed-unhardened)',
    throws(() => assertModeHostConsistency('local', '0.0.0.0'))
  )
  check(
    'remote + non-loopback host = ok',
    safe(() => assertModeHostConsistency('remote', '0.0.0.0'))
  )
  check(
    'remote + loopback host = ok (no throw, benign)',
    safe(() => assertModeHostConsistency('remote', '127.0.0.1'))
  )
} finally {
  if (prev === undefined) delete process.env.SLAYZONE_MODE
  else process.env.SLAYZONE_MODE = prev
}

function safe(fn: () => void): boolean {
  try {
    fn()
    return true
  } catch {
    return false
  }
}
function throws(fn: () => void): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
