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
  loadHubConfigProblems,
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
  if (actual !== expected)
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
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
      listenAddress: '0.0.0.0:8080',
      publicAddress: 'hub.example:8443',
      hubName: 'my-hub',
      requireLogin: true,
      enablePassword: false,
      enableSso: true,
      ssoTenantId: 'tenant-1',
      ssoClientId: 'client-1',
      enableProcesses: false,
      enableIntegrations: false,
      // unknown → dropped
      extra: { nested: 1 }
    })
  )
  const cfg = loadHubConfigFile(p)
  assertEq(cfg.listenAddress, '0.0.0.0:8080', 'listenAddress')
  assertEq(cfg.publicAddress, 'hub.example:8443', 'publicAddress')
  assertEq(cfg.hubName, 'my-hub', 'hubName')
  assertEq(cfg.requireLogin, true, 'requireLogin')
  assertEq(cfg.enablePassword, false, 'enablePassword')
  assertEq(cfg.enableSso, true, 'enableSso')
  assertEq(cfg.ssoTenantId, 'tenant-1', 'ssoTenantId')
  assertEq(cfg.ssoClientId, 'client-1', 'ssoClientId')
  assertEq(cfg.enableProcesses, false, 'enableProcesses')
  assertEq(cfg.enableIntegrations, false, 'enableIntegrations')
  assert(!('extra' in cfg), 'unknown key dropped')
  assertEq(loadHubConfigProblems(p).length, 0, 'a clean file has no boot problems')
  rmSync(dir, { recursive: true, force: true })
})

test('wrong-typed values are dropped (empty listenAddress, numeric publicAddress, string switch)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(
    p,
    JSON.stringify({ listenAddress: '', publicAddress: 42, requireLogin: 'yes', ssoTenantId: '  ' })
  )
  const cfg = loadHubConfigFile(p)
  assert(cfg.listenAddress === undefined, 'empty listenAddress dropped')
  assert(cfg.publicAddress === undefined, 'non-string publicAddress dropped')
  assert(cfg.requireLogin === undefined, 'non-boolean switch dropped from the config object')
  assert(cfg.ssoTenantId === undefined, 'blank ssoTenantId dropped')
  rmSync(dir, { recursive: true, force: true })
})

// The secret never lives in the file: there is no HubConfig key for it, so even a
// hand-written `ssoClientSecret` is not carried anywhere.
test('ssoClientSecret in the file is not read (secrets are env only)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ ssoClientSecret: 'nope', ssoClientId: 'c' }))
  const cfg = loadHubConfigFile(p)
  assert(!('ssoClientSecret' in cfg), 'secret key not loaded')
  assertEq(cfg.ssoClientId, 'c', 'its sibling still loads')
  rmSync(dir, { recursive: true, force: true })
})

// `mode` was the FILE channel for SLAYZONE_MODE. The mode is gone: the key is
// ignored — it is neither read nor a boot problem.
test('mode is ignored: not read, not a problem', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ mode: 'remote', hubName: 'h' }))
  const cfg = loadHubConfigFile(p)
  assert(!('mode' in cfg), 'mode not carried')
  assertEq(cfg.hubName, 'h', 'rest of the file loads')
  assertEq(loadHubConfigProblems(p).length, 0, 'a leftover mode key is NOT a boot problem')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: boot problems (B4, B5)')
console.log('─'.repeat(40))

test('B5: the old `address` key is a boot problem naming listenAddress', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ address: '0.0.0.0:8080' }))
  const problems = loadHubConfigProblems(p)
  assertEq(problems.length, 1, 'one problem')
  assertEq(problems[0]!.key, 'address', 'names the key')
  assert(/renamed to 'listenAddress'/.test(problems[0]!.message), problems[0]!.message)
  rmSync(dir, { recursive: true, force: true })
})

test('B5: the old `port` key is a boot problem naming listenAddress', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ port: 8080 }))
  const problems = loadHubConfigProblems(p)
  assertEq(problems.length, 1, 'one problem')
  assertEq(problems[0]!.key, 'port', 'names the key')
  assert(/renamed to 'listenAddress/.test(problems[0]!.message), problems[0]!.message)
  rmSync(dir, { recursive: true, force: true })
})

test('B5: the old `publicUrl` key is a boot problem naming publicAddress', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ publicUrl: 'https://hub.example' }))
  const problems = loadHubConfigProblems(p)
  assertEq(problems.length, 1, 'one problem')
  assertEq(problems[0]!.key, 'publicUrl', 'names the key')
  assert(/renamed to 'publicAddress/.test(problems[0]!.message), problems[0]!.message)
  rmSync(dir, { recursive: true, force: true })
})

test('B5: every renamed key present is reported, not just the first', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ address: 'a:1', port: 2, publicUrl: 'https://x' }))
  const keys = loadHubConfigProblems(p)
    .map((x) => x.key)
    .sort()
  assertEq(keys.join(','), 'address,port,publicUrl', 'all three reported')
  rmSync(dir, { recursive: true, force: true })
})

test('B4: a switch key that is not a boolean is a boot problem (never silently unset)', () => {
  const dir = tmp()
  for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
    const p = join(dir, 'bad.json')
    writeFileSync(p, JSON.stringify({ requireLogin: bad }))
    const problems = loadHubConfigProblems(p)
    assertEq(problems.length, 1, `reported: ${JSON.stringify(bad)}`)
    assertEq(problems[0]!.key, 'requireLogin', 'names the key')
    assert(/true or false/.test(problems[0]!.message), problems[0]!.message)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('B4: each of the five switch keys is checked', () => {
  const dir = tmp()
  for (const key of [
    'requireLogin',
    'enablePassword',
    'enableSso',
    'enableProcesses',
    'enableIntegrations'
  ]) {
    const p = join(dir, `${key}.json`)
    writeFileSync(p, JSON.stringify({ [key]: 'x' }))
    assertEq(loadHubConfigProblems(p)[0]?.key, key, `${key} validated`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('problems come from the legacy config.json too when hub.config.json is absent', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ address: '0.0.0.0:9' }))
  assertEq(
    loadHubConfigProblems(join(dir, 'hub.config.json'))[0]?.key,
    'address',
    'legacy file checked'
  )
  rmSync(dir, { recursive: true, force: true })
})

test('no file ⇒ no problems', () => {
  const dir = tmp()
  assertEq(loadHubConfigProblems(join(dir, 'nope.json')).length, 0, 'no file, no problems')
  rmSync(dir, { recursive: true, force: true })
})

test('switches round-trip through update without clobbering the address keys', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  saveHubConfigFile({ listenAddress: '0.0.0.0:8443', publicAddress: 'hub.example:8443' }, p)
  updateHubConfigFile({ requireLogin: true, enableProcesses: false }, p)
  const back = loadHubConfigFile(p)
  assertEq(back.requireLogin, true, 'requireLogin written')
  assertEq(back.enableProcesses, false, 'enableProcesses written (false survives the merge)')
  assertEq(back.listenAddress, '0.0.0.0:8443', 'listenAddress preserved')
  assertEq(back.publicAddress, 'hub.example:8443', 'publicAddress preserved')
  rmSync(dir, { recursive: true, force: true })
})

test('an update drops the renamed keys it rewrites over (no stale address survives)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  writeFileSync(p, JSON.stringify({ address: 'old:1', hubName: 'h' }))
  updateHubConfigFile({ requireLogin: true }, p)
  assertEq(loadHubConfigProblems(p).length, 0, 'rewritten file no longer carries `address`')
  assertEq(loadHubConfigFile(p).hubName, 'h', 'other keys kept')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: save / update round-trip')
console.log('─'.repeat(40))

test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
  const dir = tmp()
  const p = join(dir, 'sub', 'hub.config.json')
  saveHubConfigFile({ listenAddress: '127.0.0.1:8443', publicAddress: 'hub.example' }, p)
  const back = loadHubConfigFile(p)
  assertEq(back.listenAddress, '127.0.0.1:8443', 'listenAddress round-trip')
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
  saveHubConfigFile({ publicAddress: 'hub.example:9', hubName: 'first' }, p)
  const merged = updateHubConfigFile({ listenAddress: '0.0.0.0:8443' }, p)
  assertEq(merged.publicAddress, 'hub.example:9', 'kept publicAddress')
  assertEq(merged.hubName, 'first', 'kept hubName')
  assertEq(merged.listenAddress, '0.0.0.0:8443', 'added listenAddress')
  const onDisk = loadHubConfigFile(p)
  assertEq(onDisk.listenAddress, '0.0.0.0:8443', 'persisted')
  assertEq(onDisk.publicAddress, 'hub.example:9', 'persisted publicAddress')
  rmSync(dir, { recursive: true, force: true })
})

test('update ignores undefined patch values (does not erase)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.config.json')
  saveHubConfigFile({ hubName: 'keepme' }, p)
  const merged = updateHubConfigFile({ hubName: undefined, listenAddress: '127.0.0.1:5' }, p)
  assertEq(merged.hubName, 'keepme', 'undefined did not erase hubName')
  assertEq(merged.listenAddress, '127.0.0.1:5', 'added listenAddress')
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
  assertEq(onDisk.computerTransportSecret, secret, 'persisted into hub.state.json')
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

test('honors a pre-existing state-file computerTransportSecret (does not overwrite)', () => {
  const dir = tmp()
  const p = join(dir, 'hub.state.json')
  saveHubStateFile({ computerTransportSecret: 'preset-secret-value' }, p)
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
  assertEq(loadHubStateFile(p).computerTransportSecret, a, 'on-disk secret matches')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nhub-config-file: SLAYZONE_ROOT honored')
console.log('─'.repeat(40))

test('getHubConfigFilePath / getHubStateFilePath resolve under SLAYZONE_ROOT', () => {
  const dir = tmp()
  const prev = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  try {
    assertEq(
      getHubConfigFilePath(),
      join(dir, 'hub.config.json'),
      'config path under root override'
    )
    assertEq(getHubStateFilePath(), join(dir, 'hub.state.json'), 'state path under root override')
    saveHubConfigFile({ listenAddress: '127.0.0.1:1234' })
    const raw = readFileSync(join(dir, 'hub.config.json'), 'utf8')
    assert(/1234/.test(raw), 'wrote to the overridden root dir')
    assertEq(
      loadHubConfigFile().listenAddress,
      '127.0.0.1:1234',
      'default-path load reads the override'
    )
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
  writeFileSync(
    legacyPath,
    JSON.stringify({ listenAddress: '0.0.0.0:9000', hubName: 'legacy-hub' })
  )
  const cfgPath = join(dir, 'hub.config.json')
  const cfg = loadHubConfigFile(cfgPath)
  assertEq(cfg.listenAddress, '0.0.0.0:9000', 'listenAddress from legacy file')
  assertEq(cfg.hubName, 'legacy-hub', 'hubName from legacy file')
  assert(!existsSync(cfgPath), 'never auto-upgrades — hub.config.json not created by a read')
  rmSync(dir, { recursive: true, force: true })
})

test('hub.state.json absent, legacy config.json present ⇒ secret coerced from it', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ computerTransportSecret: 'legacy-secret' }))
  const statePath = join(dir, 'hub.state.json')
  const state = loadHubStateFile(statePath)
  assertEq(state.computerTransportSecret, 'legacy-secret', 'secret from legacy file')
  assert(!existsSync(statePath), 'never auto-upgrades — hub.state.json not created by a read')
  rmSync(dir, { recursive: true, force: true })
})

test('ensureHubAuthSecret reuses a legacy secret rather than generating a new one', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ computerTransportSecret: 'legacy-secret-value' }))
  const statePath = join(dir, 'hub.state.json')
  const secret = ensureHubAuthSecret(statePath)
  assertEq(secret, 'legacy-secret-value', 'the legacy secret, not a freshly generated one')
  rmSync(dir, { recursive: true, force: true })
})

test('new file present takes priority over the legacy file even if both exist', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ listenAddress: 'from-legacy:1' }))
  const cfgPath = join(dir, 'hub.config.json')
  saveHubConfigFile({ listenAddress: 'from-new:2' }, cfgPath)
  assertEq(loadHubConfigFile(cfgPath).listenAddress, 'from-new:2', 'new file wins once it exists')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
