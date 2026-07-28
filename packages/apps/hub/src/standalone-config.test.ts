/**
 * Hub standalone-config resolve — applyStandaloneHubConfig folds
 * ~/.slayzone/config.json into process.env with env>file>default precedence, and
 * resolves/persists the hub-auth secret (security fix). Supervised = no-op (no file
 * read/write).
 *
 * Pure Node (real temp home dir via SLAYZONE_ROOT, no native deps) → runs
 * under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/standalone-config.test.ts
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEV_HUB_AUTH_SECRET,
  getSlayzoneConfigPath,
  loadSlayzoneConfig,
  saveSlayzoneConfig
} from '@slayzone/platform/slayzone-config'
import { applyStandaloneHubConfig } from './standalone-config.js'

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

/** Env keys this module touches — scrubbed + restored around each case. */
const ENV_KEYS = [
  'SLAYZONE_SUPERVISED',
  'SLAYZONE_ROOT',
  'SLAYZONE_HUB_AUTH_SECRET',
  'SLAYZONE_HUB_ADDRESS',
  'SLAYZONE_HUB_PUBLIC_ADDRESS'
] as const

/** Run `fn` with a clean env + isolated temp home dir; restore env after. */
function withIsolatedEnv(seed: Record<string, string>, fn: (home: string) => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  const home = mkdtempSync(join(tmpdir(), 'slz-hub-home-'))
  process.env.SLAYZONE_ROOT = home
  for (const [k, v] of Object.entries(seed)) process.env[k] = v
  try {
    fn(home)
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('\nstandalone-config: env > file > default')
console.log('─'.repeat(40))

test('config.json fills unset env (address, publicAddress)', () => {
  withIsolatedEnv({}, () => {
    saveSlayzoneConfig({
      address: '0.0.0.0:8080',
      publicAddress: 'hub.example:8443'
    })
    applyStandaloneHubConfig()
    // No DB path is seeded anywhere in this chain: it DERIVES from SLAYZONE_ROOT
    // (<ROOT>/storage) via platform.getStorageDir() and is not overridable.
    assertEq(process.env.SLAYZONE_HUB_ADDRESS, '0.0.0.0:8080', 'address')
    assertEq(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'hub.example:8443', 'publicAddress')
  })
})

test('legacy port/publicUrl keys still boot (authority extracted, scheme dropped)', () => {
  withIsolatedEnv({}, () => {
    // An existing config.json written by an older build must keep working — the
    // legacy keys are READ (never written back).
    saveSlayzoneConfig({ port: 8080, publicUrl: 'https://hub.example:8443/' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_ADDRESS, '127.0.0.1:8080', 'legacy port → loopback address')
    assertEq(
      process.env.SLAYZONE_HUB_PUBLIC_ADDRESS,
      'hub.example:8443',
      'legacy publicUrl → authority only (https:// discarded, SLAYZONE_MODE owns the scheme)'
    )
  })
})

test('new address key WINS over the legacy port key', () => {
  withIsolatedEnv({}, () => {
    saveSlayzoneConfig({ address: '0.0.0.0:7000', port: 8080 })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_ADDRESS, '0.0.0.0:7000', 'address wins')
  })
})

test('env WINS over config.json (does not overwrite a set env)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_ADDRESS: '127.0.0.1:9999' }, () => {
    saveSlayzoneConfig({ address: '0.0.0.0:8080' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_ADDRESS, '127.0.0.1:9999', 'env address kept')
  })
})

test('no config + no env ⇒ only the generated hub-auth secret is set (defaults elsewhere)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_ADDRESS === undefined, 'no address default here')
    assert(!!process.env.SLAYZONE_HUB_AUTH_SECRET, 'hub-auth secret always resolved')
  })
})

console.log('\nstandalone-config: hub-auth secret (security fix)')
console.log('─'.repeat(40))

test('generates + persists a hub-auth secret into config.json (!= dev constant)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    assert(!!secret, 'env set')
    assert(secret !== DEV_HUB_AUTH_SECRET, 'not the shared dev constant')
    assertEq(secret!.length, 64, '256-bit hex')
    // persisted into the temp config.json
    assertEq(loadSlayzoneConfig().runnerTransportSecret, secret, 'persisted')
  })
})

test('second boot reuses the SAME persisted secret (stable)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    const first = process.env.SLAYZONE_HUB_AUTH_SECRET
    // simulate a fresh process: clear the env, keep the file
    delete process.env.SLAYZONE_HUB_AUTH_SECRET
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, first, 'same secret across boots')
  })
})

test('env SLAYZONE_HUB_AUTH_SECRET wins + no config write', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: 'ci-pinned-secret' }, () => {
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, 'ci-pinned-secret', 'env secret kept')
    // config.json should NOT have been created (no generate/persist path taken)
    assert(!existsSync(getSlayzoneConfigPath()), 'no config file written when env pins the secret')
  })
})

test('config.json runnerTransportSecret used (env unset) and NOT regenerated', () => {
  withIsolatedEnv({}, () => {
    saveSlayzoneConfig({ runnerTransportSecret: 'from-config-file' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, 'from-config-file', 'config secret used')
  })
})

test('EMPTY env SLAYZONE_HUB_AUTH_SECRET counts as absent ⇒ generates (no misleading throw)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: '' }, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    assert(!!secret, 'a real secret was generated (empty treated as absent)')
    assert(secret !== DEV_HUB_AUTH_SECRET, 'not the dev constant')
    assertEq(secret!.length, 64, '256-bit hex generated')
    assertEq(loadSlayzoneConfig().runnerTransportSecret, secret, 'persisted')
  })
})

console.log('\nstandalone-config: supervised = no-op')
console.log('─'.repeat(40))

test('supervised does NOT read or write config.json (no file created, no env seeded)', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'no secret seeded when supervised')
    assert(!existsSync(getSlayzoneConfigPath()), 'no config file written when supervised')
  })
})

test('supervised IGNORES an existing config.json entirely', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    saveSlayzoneConfig({ address: '0.0.0.0:8080', runnerTransportSecret: 'should-be-ignored' })
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_ADDRESS === undefined, 'ignored address')
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'ignored runnerTransportSecret')
  })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
