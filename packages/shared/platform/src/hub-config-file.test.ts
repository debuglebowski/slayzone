/**
 * hub.config.json / hub.state.json — loadHubConfigFile / loadHubStateFile /
 * save / update / ensureHubAuthSecret, plus the legacy shared-config.json
 * fallback. Pure Node (real temp files, no native deps) → runs under plain
 * `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-config-file.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_HUB_AUTH_SECRET,
  ensureHubAuthSecret,
  getHubConfigFilePath,
  getHubStateFilePath,
  loadHubConfigFile,
  loadHubStateFile,
  saveHubConfigFile,
  saveHubStateFile,
  updateHubConfigFile
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
  return mkdtempSync(join(tmpdir(), 'slz-hubcfg-'))
}

console.log('\nhub-config-file: loadHubConfigFile')
console.log('─'.repeat(40))

test('missing file ⇒ {} (no throw)', () => {
  const dir = tmp()
  try {
    const cfg = loadHubConfigFile(join(dir, 'nope.json'))
    assertEq(Object.keys(cfg).length, 0, 'empty config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt JSON ⇒ {} + warns to stderr (no throw)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, '{not valid json')
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadHubConfigFile(p)
    assertEq(Object.keys(cfg).length, 0, 'empty config on corrupt')
    assert(/not valid JSON/.test(warned), 'warned about invalid JSON')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-object JSON (array) ⇒ {} + warns', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, '[1,2,3]')
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadHubConfigFile(p)
    assertEq(Object.keys(cfg).length, 0, 'empty on array')
    assert(/not a JSON object/.test(warned), 'warned about non-object')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('valid config parses all known keys, drops wrong types', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(
    p,
    JSON.stringify({
      address: '0.0.0.0:8080',
      publicAddress: 'hub.example:8443',
      hubName: 'my-hub',
      // legacy bind/public keys — still READ so an existing file keeps booting
      port: 8080,
      publicUrl: 'https://hub.example',
      // wrong-typed / unknown → dropped
      port2: 'nope',
      extra: { nested: 1 }
    })
  )
  const cfg = loadHubConfigFile(p)
  assertEq(cfg.address, '0.0.0.0:8080', 'address')
  assertEq(cfg.publicAddress, 'hub.example:8443', 'publicAddress')
  assertEq(cfg.hubName, 'my-hub', 'hubName')
  assertEq(cfg.port, 8080, 'legacy port')
  assertEq(cfg.publicUrl, 'https://hub.example', 'legacy publicUrl')
  assert(!('extra' in cfg), 'unknown key dropped')
  rmSync(dir, { recursive: true, force: true })
})

test('wrong-typed values are dropped (port as string, empty address/publicUrl)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ port: '8080', address: '', publicAddress: 42, publicUrl: '' }))
  const cfg = loadHubConfigFile(p)
  assert(cfg.port === undefined, 'string port dropped')
  assert(cfg.address === undefined, 'empty address dropped')
  assert(cfg.publicAddress === undefined, 'non-string publicAddress dropped')
  assert(cfg.publicUrl === undefined, 'empty publicUrl dropped')
  rmSync(dir, { recursive: true, force: true })
})

// `mode` is the FILE channel for SLAYZONE_MODE — the hardening lever that decides
// whether a hub authenticates clients, terminates TLS, and mints `wss://` join
// tokens. It lives here so `slay hub create --public-address` can persist an
// operator's intent once, next to the address it belongs with, rather than needing
// a second home in the service unit (which `restart --upgrade` rewrites).
test('mode: only the two known literals survive', () => {
  const dir = tmp()
  const remote = join(dir, 'remote.json')
  writeFileSync(remote, JSON.stringify({ mode: 'remote' }))
  assertEq(loadHubConfigFile(remote).mode, 'remote', 'remote parses')

  const local = join(dir, 'local.json')
  writeFileSync(local, JSON.stringify({ mode: 'local' }))
  assertEq(loadHubConfigFile(local).mode, 'local', 'local parses')

  // Anything else is DROPPED rather than passed through: an unrecognized value
  // reaching SLAYZONE_MODE would silently resolve to `local` (getSlayzoneMode's
  // safe default), so a typo like `Remote` must read as "unset" — which lets the
  // env channel or the default answer instead of half-applying.
  for (const bad of ['Remote', 'REMOTE', 'prod', '', 42, null, { mode: 'remote' }]) {
    const p = join(dir, 'bad.json')
    writeFileSync(p, JSON.stringify({ mode: bad }))
    assert(loadHubConfigFile(p).mode === undefined, `dropped: ${JSON.stringify(bad)}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('mode round-trips through update without clobbering the address keys', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  saveHubConfigFile({ address: '0.0.0.0:8443', publicAddress: 'hub.example:8443' }, p)
  updateHubConfigFile({ mode: 'remote' }, p)
  const back = loadHubConfigFile(p)
  assertEq(back.mode, 'remote', 'mode written')
  assertEq(back.address, '0.0.0.0:8443', 'address preserved')
  assertEq(back.publicAddress, 'hub.example:8443', 'publicAddress preserved')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: save / update round-trip')
console.log('─'.repeat(40))

test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
  const dir = tmp()
  const p = join(dir, 'sub', 'hub.config.json')
  saveHubConfigFile({ address: '127.0.0.1:8443', publicAddress: 'hub.example' }, p)
  const back = loadHubConfigFile(p)
  assertEq(back.address, '127.0.0.1:8443', 'address round-trip')
  assertEq(back.publicAddress, 'hub.example', 'publicAddress round-trip')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file mode 0600')
    assertEq(statSync(join(dir, 'sub')).mode & 0o777, 0o700, 'dir mode 0700')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('updateHubConfigFile merges over on-disk base (no clobber of other keys)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  saveHubConfigFile({ port: 9, hubName: 'first' }, p)
  const merged = updateHubConfigFile({ address: '0.0.0.0:8443' }, p)
  assertEq(merged.port, 9, 'kept port')
  assertEq(merged.hubName, 'first', 'kept hubName')
  assertEq(merged.address, '0.0.0.0:8443', 'added address')
  const onDisk = loadHubConfigFile(p)
  assertEq(onDisk.address, '0.0.0.0:8443', 'persisted')
  assertEq(onDisk.port, 9, 'persisted port')
  rmSync(dir, { recursive: true, force: true })
})

test('update ignores undefined patch values (does not erase)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  saveHubConfigFile({ hubName: 'keepme' }, p)
  const merged = updateHubConfigFile({ hubName: undefined, port: 5 }, p)
  assertEq(merged.hubName, 'keepme', 'undefined did not erase hubName')
  assertEq(merged.port, 5, 'added port')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: ensureHubAuthSecret')
console.log('─'.repeat(40))

test('generates + persists a secret when absent (0600, != dev constant)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.state.json')
  const secret = ensureHubAuthSecret(p)
  assert(secret.length === 64, '256-bit hex = 64 chars')
  assert(secret !== DEV_HUB_AUTH_SECRET, 'not the shared dev constant')
  assert(/^[0-9a-f]{64}$/.test(secret), 'lowercase hex')
  const onDisk = loadHubStateFile(p)
  assertEq(onDisk.runnerTransportSecret, secret, 'persisted into hub.state.json')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file mode 0600')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('stable across calls (reuses persisted secret, no re-generate)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.state.json')
  const s1 = ensureHubAuthSecret(p)
  const s2 = ensureHubAuthSecret(p)
  assertEq(s1, s2, 'same secret on second call')
  rmSync(dir, { recursive: true, force: true })
})

test('honors a pre-existing state-file runnerTransportSecret (does not overwrite)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.state.json')
  saveHubStateFile({ runnerTransportSecret: 'preset-secret-value' }, p)
  const secret = ensureHubAuthSecret(p)
  assertEq(secret, 'preset-secret-value', 'returned the pre-existing secret')
  rmSync(dir, { recursive: true, force: true })
})

test('concurrent fresh boots CONVERGE on one secret (atomic create-if-absent)', () => {
  // Simulate two hubs racing against the SAME fresh hub.state.json. Both call
  // ensureHubAuthSecret with no file present; only one wins the `wx` create, the
  // other re-reads the winner's secret → both return the SAME value, and the
  // on-disk secret equals it. (Sequential calls here still exercise the create
  // + read-back convergence path; the second call hits the file the first wrote.)
  const dir = tmp()
  const p = join(dir, 'hub.state.json')
  const a = ensureHubAuthSecret(p)
  const b = ensureHubAuthSecret(p)
  assertEq(a, b, 'both boots converge on ONE secret')
  assertEq(loadHubStateFile(p).runnerTransportSecret, a, 'on-disk secret matches')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: SLAYZONE_ROOT honored')
console.log('─'.repeat(40))

test('getHubConfigFilePath / getHubStateFilePath resolve under SLAYZONE_ROOT', () => {
  const dir = tmp()
  const prev = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  try {
    assertEq(getHubConfigFilePath(), join(dir, 'hub.config.json'), 'config path under root override')
    assertEq(getHubStateFilePath(), join(dir, 'hub.state.json'), 'state path under root override')
    saveHubConfigFile({ port: 1234 })
    const raw = readFileSync(join(dir, 'hub.config.json'), 'utf8')
    assert(/1234/.test(raw), 'wrote to the overridden root dir')
    assertEq(loadHubConfigFile().port, 1234, 'default-path load reads the override')
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\nhub-config-file: legacy shared config.json fallback')
console.log('─'.repeat(40))

test('hub.config.json absent, legacy config.json present ⇒ hub keys coerced from it', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ address: '0.0.0.0:9000', hubName: 'legacy-hub' }))
  const cfgPath = join(dir, 'hub.config.json')
  const cfg = loadHubConfigFile(cfgPath)
  assertEq(cfg.address, '0.0.0.0:9000', 'address from legacy file')
  assertEq(cfg.hubName, 'legacy-hub', 'hubName from legacy file')
  assert(!existsSync(cfgPath), 'never auto-upgrades — hub.config.json not created by a read')
  rmSync(dir, { recursive: true, force: true })
})

test('hub.state.json absent, legacy config.json present ⇒ secret coerced from it', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ runnerTransportSecret: 'legacy-secret' }))
  const statePath = join(dir, 'hub.state.json')
  const state = loadHubStateFile(statePath)
  assertEq(state.runnerTransportSecret, 'legacy-secret', 'secret from legacy file')
  assert(!existsSync(statePath), 'never auto-upgrades — hub.state.json not created by a read')
  rmSync(dir, { recursive: true, force: true })
})

test('ensureHubAuthSecret reuses a legacy secret rather than generating a new one', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ runnerTransportSecret: 'legacy-secret-value' }))
  const statePath = join(dir, 'hub.state.json')
  const secret = ensureHubAuthSecret(statePath)
  assertEq(secret, 'legacy-secret-value', 'the legacy secret, not a freshly generated one')
  rmSync(dir, { recursive: true, force: true })
})

test('new file present takes priority over the legacy file even if both exist', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ address: 'from-legacy:1' }))
  const cfgPath = join(dir, 'hub.config.json')
  saveHubConfigFile({ address: 'from-new:2' }, cfgPath)
  assertEq(loadHubConfigFile(cfgPath).address, 'from-new:2', 'new file wins once it exists')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
