/**
 * Shared SlayZone config file — loadSlayzoneConfig / save / update /
 * ensureRunnerTransportSecret. Pure Node (real temp files, no native deps) → runs under
 * plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/slayzone-config.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_RUNNER_TRANSPORT_SECRET,
  ensureRunnerTransportSecret,
  getSlayzoneConfigPath,
  loadSlayzoneConfig,
  saveSlayzoneConfig,
  updateSlayzoneConfig
} from './slayzone-config'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-config-'))
}

console.log('\nslayzone-config: loadSlayzoneConfig')
console.log('─'.repeat(40))

test('missing file ⇒ {} (no throw)', () => {
  const dir = tmp()
  try {
    const cfg = loadSlayzoneConfig(join(dir, 'nope.json'))
    assertEq(Object.keys(cfg).length, 0, 'empty config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt JSON ⇒ {} + warns to stderr (no throw)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  writeFileSync(p, '{not valid json')
  // Capture stderr to prove the warn fired.
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadSlayzoneConfig(p)
    assertEq(Object.keys(cfg).length, 0, 'empty config on corrupt')
    assert(/not valid JSON/.test(warned), 'warned about invalid JSON')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-object JSON (array) ⇒ {} + warns', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  writeFileSync(p, '[1,2,3]')
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadSlayzoneConfig(p)
    assertEq(Object.keys(cfg).length, 0, 'empty on array')
    assert(/not a JSON object/.test(warned), 'warned about non-object')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('valid config parses all known keys, drops wrong types', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  writeFileSync(
    p,
    JSON.stringify({
      runnerTransportSecret: 'abc',
      port: 8080,
      runnerTransportPort: 8443,
      publicUrl: 'https://hub.example',
      joinToken: 'jt-1',
      runnerName: 'r1',
      hubUrl: 'wss://hub/runners',
      allowedRoots: ['/srv/a', '/srv/b'],
      pinnedCertSha256: 'a'.repeat(64),
      // wrong-typed / unknown → dropped
      port2: 'nope',
      extra: { nested: 1 }
    })
  )
  const cfg = loadSlayzoneConfig(p)
  assertEq(cfg.runnerTransportSecret, 'abc', 'runnerTransportSecret')
  assertEq(cfg.port, 8080, 'port')
  assertEq(cfg.runnerTransportPort, 8443, 'runnerTransportPort')
  assertEq(cfg.publicUrl, 'https://hub.example', 'publicUrl')
  assertEq(cfg.joinToken, 'jt-1', 'joinToken')
  assertEq(cfg.runnerName, 'r1', 'runnerName')
  assertEq(cfg.hubUrl, 'wss://hub/runners', 'hubUrl')
  assertEq(JSON.stringify(cfg.allowedRoots), JSON.stringify(['/srv/a', '/srv/b']), 'allowedRoots')
  assertEq(cfg.pinnedCertSha256, 'a'.repeat(64), 'pinnedCertSha256')
  assert(!('extra' in cfg), 'unknown key dropped')
  rmSync(dir, { recursive: true, force: true })
})

test('wrong-typed values are dropped (port as string, empty publicUrl)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  writeFileSync(p, JSON.stringify({ port: '8080', runnerTransportPort: 'nope', publicUrl: '' }))
  const cfg = loadSlayzoneConfig(p)
  assert(cfg.port === undefined, 'string port dropped')
  assert(cfg.runnerTransportPort === undefined, 'string runnerTransportPort dropped')
  assert(cfg.publicUrl === undefined, 'empty publicUrl dropped')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nslayzone-config: save / update round-trip')
console.log('─'.repeat(40))

test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
  const dir = tmp()
  const p = join(dir, 'sub', 'config.json')
  saveSlayzoneConfig({ runnerTransportPort: 8443, port: 9 }, p)
  const back = loadSlayzoneConfig(p)
  assertEq(back.runnerTransportPort, 8443, 'runnerTransportPort round-trip')
  assertEq(back.port, 9, 'port round-trip')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file mode 0600')
    assertEq(statSync(join(dir, 'sub')).mode & 0o777, 0o700, 'dir mode 0700')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('updateSlayzoneConfig merges over on-disk base (no clobber of other keys)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  saveSlayzoneConfig({ port: 9, hubUrl: 'wss://a/runners' }, p)
  const merged = updateSlayzoneConfig({ runnerTransportSecret: 'sekret' }, p)
  assertEq(merged.port, 9, 'kept port')
  assertEq(merged.hubUrl, 'wss://a/runners', 'kept hubUrl')
  assertEq(merged.runnerTransportSecret, 'sekret', 'added runnerTransportSecret')
  // persisted on disk too
  const onDisk = loadSlayzoneConfig(p)
  assertEq(onDisk.runnerTransportSecret, 'sekret', 'persisted')
  assertEq(onDisk.port, 9, 'persisted port')
  rmSync(dir, { recursive: true, force: true })
})

test('update ignores undefined patch values (does not erase)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  saveSlayzoneConfig({ hubUrl: 'wss://a/runners' }, p)
  const merged = updateSlayzoneConfig({ hubUrl: undefined, port: 5 }, p)
  assertEq(merged.hubUrl, 'wss://a/runners', 'undefined did not erase hubUrl')
  assertEq(merged.port, 5, 'added port')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nslayzone-config: ensureRunnerTransportSecret')
console.log('─'.repeat(40))

test('generates + persists a secret when absent (0600, != dev constant)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  const secret = ensureRunnerTransportSecret(p)
  assert(secret.length === 64, '256-bit hex = 64 chars')
  assert(secret !== DEV_RUNNER_TRANSPORT_SECRET, 'not the shared dev constant')
  assert(/^[0-9a-f]{64}$/.test(secret), 'lowercase hex')
  // persisted
  const onDisk = loadSlayzoneConfig(p)
  assertEq(onDisk.runnerTransportSecret, secret, 'persisted into config.json')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file mode 0600')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('stable across calls (reuses persisted secret, no re-generate)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  const s1 = ensureRunnerTransportSecret(p)
  const s2 = ensureRunnerTransportSecret(p)
  assertEq(s1, s2, 'same secret on second call')
  rmSync(dir, { recursive: true, force: true })
})

test('honors a pre-existing config runnerTransportSecret (does not overwrite)', () => {
  const dir = tmp()
  const p = join(dir, 'config.json')
  saveSlayzoneConfig({ runnerTransportSecret: 'preset-secret-value' }, p)
  const secret = ensureRunnerTransportSecret(p)
  assertEq(secret, 'preset-secret-value', 'returned the pre-existing secret')
  rmSync(dir, { recursive: true, force: true })
})

test('concurrent fresh boots CONVERGE on one secret (atomic create-if-absent)', () => {
  // Simulate two hubs racing against the SAME fresh config.json. Both call
  // ensureRunnerTransportSecret with no file present; only one wins the `wx` create, the
  // other re-reads the winner's secret → both return the SAME value, and the
  // on-disk secret equals it. (Sequential calls here still exercise the create
  // + read-back convergence path; the second call hits the file the first wrote.)
  const dir = tmp()
  const p = join(dir, 'config.json')
  const a = ensureRunnerTransportSecret(p)
  const b = ensureRunnerTransportSecret(p)
  assertEq(a, b, 'both boots converge on ONE secret')
  assertEq(loadSlayzoneConfig(p).runnerTransportSecret, a, 'on-disk secret matches')
  rmSync(dir, { recursive: true, force: true })
})

test('preserves other keys when adding a secret to a secret-less config', () => {
  // A pre-existing config.json WITH other keys but WITHOUT a secret must keep
  // those keys after ensureRunnerTransportSecret merges the generated secret in.
  const dir = tmp()
  const p = join(dir, 'config.json')
  saveSlayzoneConfig({ port: 9, hubUrl: 'wss://a/runners' }, p)
  const secret = ensureRunnerTransportSecret(p)
  const onDisk = loadSlayzoneConfig(p)
  assertEq(onDisk.runnerTransportSecret, secret, 'secret added')
  assertEq(onDisk.port, 9, 'kept port')
  assertEq(onDisk.hubUrl, 'wss://a/runners', 'kept hubUrl')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file still 0600 after merge')
  }
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nslayzone-config: SLAYZONE_ROOT honored')
console.log('─'.repeat(40))

test('getSlayzoneConfigPath resolves under SLAYZONE_ROOT', () => {
  const dir = tmp()
  const prev = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  try {
    assertEq(getSlayzoneConfigPath(), join(dir, 'config.json'), 'path under root override')
    // and a default-path save/load round-trips there
    saveSlayzoneConfig({ port: 1234 })
    const raw = readFileSync(join(dir, 'config.json'), 'utf8')
    assert(/1234/.test(raw), 'wrote to the overridden root dir')
    assertEq(loadSlayzoneConfig().port, 1234, 'default-path load reads the override')
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
