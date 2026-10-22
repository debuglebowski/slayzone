/**
 * Hub standalone-config resolve — applyStandaloneHubConfig folds
 * hub.config.json/hub.state.json into process.env with env>file>default
 * precedence, and resolves/persists the hub-auth secret (security fix).
 * Supervised = no-op (no file read/write).
 *
 * Pure Node (real temp home dir via SLAYZONE_ROOT, no native deps) → runs
 * under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/standalone-config.test.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEV_HUB_AUTH_SECRET,
  getHubConfigFilePath,
  getHubStateFilePath,
  loadHubStateFile,
  saveHubConfigFile,
  saveHubStateFile
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
  if (actual !== expected)
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

/** Env keys this module touches — scrubbed + restored around each case. */
const ENV_KEYS = [
  'SLAYZONE_SUPERVISED',
  'SLAYZONE_ROOT',
  'SLAYZONE_HUB_AUTH_SECRET',
  'SLAYZONE_HUB_ADDRESS',
  'SLAYZONE_HUB_LISTEN_ADDRESS',
  'SLAYZONE_HUB_PUBLIC_ADDRESS',
  'SLAYZONE_HUB_NAME',
  'SLAYZONE_HUB_REQUIRE_LOGIN',
  'SLAYZONE_HUB_ENABLE_PASSWORD',
  'SLAYZONE_HUB_ENABLE_SSO',
  'SLAYZONE_HUB_ENABLE_PROCESSES',
  'SLAYZONE_HUB_ENABLE_INTEGRATIONS',
  'SLAYZONE_HUB_SSO_TENANT_ID',
  'SLAYZONE_HUB_SSO_CLIENT_ID',
  'SLAYZONE_HUB_SSO_CLIENT_SECRET',
  'SLAYZONE_MODE'
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

test('hub.config.json fills unset env (listenAddress, publicAddress)', () => {
  // A hub with a public address is reachable (B13), so it also needs login and the
  // secret in env — the file alone would be refused.
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: 'env-secret' }, () => {
    saveHubConfigFile({
      listenAddress: '0.0.0.0:8080',
      publicAddress: 'hub.example:8443',
      requireLogin: true
    })
    applyStandaloneHubConfig()
    // No DB path is seeded anywhere in this chain: it DERIVES from SLAYZONE_ROOT
    // (<ROOT>, flat) via platform.getStorageDir() and is not overridable.
    assertEq(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, '0.0.0.0:8080', 'listenAddress')
    assertEq(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'hub.example:8443', 'publicAddress')
    assert(
      process.env.SLAYZONE_HUB_ADDRESS === undefined,
      'the dial-side name is never seeded onto a hub'
    )
  })
})

test('env WINS over hub.config.json (does not overwrite a set env)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:9999' }, () => {
    saveHubConfigFile({ listenAddress: '0.0.0.0:8080' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, '127.0.0.1:9999', 'env address kept')
  })
})

// ── the switches: file booleans become the 0|1 env channel ───────────────────
test('hub.config.json switches seed the env as 0|1', () => {
  // SSO on needs its certificate + key paths, which only env supplies, and a public
  // address (B7) — which makes the hub reachable, so the auth secret too (B14).
  const SSO_ENV = {
    SLAYZONE_HUB_SSO_CERT_PATH: '/run/sso/cert.pem',
    SLAYZONE_HUB_SSO_KEY_PATH: '/run/sso/key.pem',
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
    SLAYZONE_HUB_AUTH_SECRET: 'a-long-random-secret'
  }
  const TENANT = '11111111-2222-3333-4444-555555555555'
  const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  withIsolatedEnv(SSO_ENV, () => {
    saveHubConfigFile({
      requireLogin: true,
      enablePassword: false,
      enableSso: true,
      ssoTenantId: TENANT,
      ssoClientId: CLIENT,
      enableProcesses: false,
      enableIntegrations: false
    })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, '1', 'requireLogin true → 1')
    assertEq(process.env.SLAYZONE_HUB_ENABLE_PASSWORD, '0', 'enablePassword false → 0')
    assertEq(process.env.SLAYZONE_HUB_ENABLE_SSO, '1', 'enableSso true → 1')
    assertEq(process.env.SLAYZONE_HUB_ENABLE_PROCESSES, '0', 'enableProcesses false → 0')
    assertEq(process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS, '0', 'enableIntegrations false → 0')
    assertEq(process.env.SLAYZONE_HUB_SSO_TENANT_ID, TENANT, 'ssoTenantId')
    assertEq(process.env.SLAYZONE_HUB_SSO_CLIENT_ID, CLIENT, 'ssoClientId')
  })
})

test('an ABSENT switch key leaves the env unset (the default applies, not an invented value)', () => {
  withIsolatedEnv({}, () => {
    saveHubConfigFile({ requireLogin: true })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, '1', 'the key that is there')
    assert(process.env.SLAYZONE_HUB_ENABLE_PASSWORD === undefined, 'enablePassword not seeded')
    assert(process.env.SLAYZONE_HUB_ENABLE_SSO === undefined, 'enableSso not seeded')
    assert(process.env.SLAYZONE_HUB_ENABLE_PROCESSES === undefined, 'enableProcesses not seeded')
    assert(
      process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS === undefined,
      'enableIntegrations not seeded'
    )
  })
})

test('env switches WIN over the file (false in the file, 1 in env → 1)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PROCESSES: '0' }, () => {
    saveHubConfigFile({ requireLogin: false, enableProcesses: true })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, '1', 'env requireLogin kept')
    assertEq(process.env.SLAYZONE_HUB_ENABLE_PROCESSES, '0', 'env enableProcesses kept')
  })
})

test('the SSO client secret has NO file channel: it is never seeded, even if written there', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(
      join(home, 'hub.config.json'),
      JSON.stringify({ ssoClientSecret: 'from-file', ssoClientSecretEnv: 'x', ssoClientId: 'c' })
    )
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_SSO_CLIENT_SECRET === undefined, 'secret is env only')
    assertEq(process.env.SLAYZONE_HUB_SSO_CLIENT_ID, 'c', 'the non-secret id is seeded')
  })
})

// ── B5: renamed keys refuse boot ─────────────────────────────────────────────
function throwsFrom(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

test('B5: the old `address` key refuses boot with a "renamed to listenAddress" message', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'hub.config.json'), JSON.stringify({ address: '0.0.0.0:8080' }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, 'boot refused')
    assert(/'address' was renamed to 'listenAddress'/.test(msg), msg)
    assert(msg.includes(join(home, 'hub.config.json')), `names the file: ${msg}`)
    assert(process.env.SLAYZONE_HUB_LISTEN_ADDRESS === undefined, 'nothing seeded before refusing')
  })
})

test('B5: the old `port` key refuses boot, naming listenAddress', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'hub.config.json'), JSON.stringify({ port: 8080 }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /'port' was renamed to 'listenAddress/.test(msg), String(msg))
  })
})

// Decision (T-02): `publicUrl` REFUSES, like `address`. Ignoring it silently would
// leave the hub with no public address, so join tokens and links would point at
// 127.0.0.1 — a deployment that boots and then does not work.
test('B5: the old `publicUrl` key refuses boot, naming publicAddress', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(
      join(home, 'hub.config.json'),
      JSON.stringify({ publicUrl: 'https://hub.example:8443/' })
    )
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /'publicUrl' was renamed to 'publicAddress/.test(msg), String(msg))
  })
})

test('B5 applies to the legacy shared config.json fallback too', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ address: '0.0.0.0:8080' }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /renamed/.test(msg), String(msg))
  })
})

test('B4: a non-boolean switch in the file refuses boot, naming the key', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'hub.config.json'), JSON.stringify({ requireLogin: 'true' }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /'requireLogin' must be true or false/.test(msg), String(msg))
  })
})

test('a leftover `mode` key in the file is IGNORED — not seeded, not a refusal', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(
      join(home, 'hub.config.json'),
      JSON.stringify({ mode: 'remote', hubName: 'from-file' })
    )
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_MODE === undefined, 'SLAYZONE_MODE is never seeded any more')
    assertEq(process.env.SLAYZONE_HUB_NAME, 'from-file', 'rest of the file loads')
  })
})

test('a leftover SLAYZONE_MODE in env is ignored too (left exactly as it was)', () => {
  withIsolatedEnv({ SLAYZONE_MODE: 'remote' }, () => {
    saveHubConfigFile({ listenAddress: '127.0.0.1:8080' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_MODE, 'remote', 'untouched, unread')
    assert(!!process.env.SLAYZONE_HUB_AUTH_SECRET, 'and it does not change the secret handling')
  })
})

test('no config + no env ⇒ only the generated hub-auth secret is set (defaults elsewhere)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_LISTEN_ADDRESS === undefined, 'no address default here')
    assert(!!process.env.SLAYZONE_HUB_AUTH_SECRET, 'hub-auth secret resolved on a local-only hub')
  })
})

console.log('\nstandalone-config: hub-auth secret (security fix)')
console.log('─'.repeat(40))

test('generates + persists a hub-auth secret into hub.state.json (!= dev constant)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    assert(!!secret, 'env set')
    assert(secret !== DEV_HUB_AUTH_SECRET, 'not the shared dev constant')
    assertEq(secret!.length, 64, '256-bit hex')
    // persisted into the temp hub.state.json
    assertEq(loadHubStateFile().computerTransportSecret, secret, 'persisted')
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

test('env SLAYZONE_HUB_AUTH_SECRET wins + no state-file write', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: 'ci-pinned-secret' }, () => {
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, 'ci-pinned-secret', 'env secret kept')
    // hub.state.json should NOT have been created (no generate/persist path taken)
    assert(!existsSync(getHubStateFilePath()), 'no state file written when env pins the secret')
  })
})

test('hub.state.json computerTransportSecret used (env unset) and NOT regenerated', () => {
  withIsolatedEnv({}, () => {
    saveHubStateFile({ computerTransportSecret: 'from-state-file' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, 'from-state-file', 'state-file secret used')
  })
})

test('EMPTY env SLAYZONE_HUB_AUTH_SECRET counts as absent ⇒ generates (no misleading throw)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: '' }, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    assert(!!secret, 'a real secret was generated (empty treated as absent)')
    assert(secret !== DEV_HUB_AUTH_SECRET, 'not the dev constant')
    assertEq(secret!.length, 64, '256-bit hex generated')
    assertEq(loadHubStateFile().computerTransportSecret, secret, 'persisted')
  })
})

// ── B14: a hub other machines can reach gets no generated secret ─────────────
const REACH_OK = { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' }

test('B13/B14: a reachable hub with no secret in env is REFUSED — and writes no state file', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:8080' }, () => {
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /SLAYZONE_HUB_AUTH_SECRET is required/.test(msg), String(msg))
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'nothing generated into env')
    assert(!existsSync(getHubStateFilePath()), 'hub.state.json not written')
  })
})

test('B13/B14: a loopback hub WITH a public address (same-box proxy) is refused the same way', () => {
  withIsolatedEnv(REACH_OK, () => {
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /SLAYZONE_HUB_AUTH_SECRET is required/.test(msg), String(msg))
    assert(!existsSync(getHubStateFilePath()), 'hub.state.json not written')
  })
})

test('B13/B14: reachability that comes from the FILE is honored the same way', () => {
  withIsolatedEnv({}, () => {
    saveHubConfigFile({
      listenAddress: '0.0.0.0:8080',
      publicAddress: 'hub.example.com',
      requireLogin: true
    })
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /SLAYZONE_HUB_AUTH_SECRET is required/.test(msg), String(msg))
    assert(!existsSync(getHubStateFilePath()), 'hub.state.json not written')
  })
})

test('B14: a reachable hub with the secret in env keeps it, and still writes nothing', () => {
  withIsolatedEnv(
    {
      ...REACH_OK,
      SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:8080',
      SLAYZONE_HUB_AUTH_SECRET: 'from-env'
    },
    () => {
      applyStandaloneHubConfig()
      assertEq(process.env.SLAYZONE_HUB_AUTH_SECRET, 'from-env', 'env secret kept')
      assert(!existsSync(getHubStateFilePath()), 'hub.state.json not written')
    }
  )
})

test('a reachable hub does NOT read a persisted state-file secret either: env or refuse', () => {
  withIsolatedEnv(REACH_OK, () => {
    saveHubStateFile({ computerTransportSecret: 'from-state-file' })
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null && /SLAYZONE_HUB_AUTH_SECRET is required/.test(msg), String(msg))
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'the state file is not a source')
  })
})

// ── the boot rules run here too, so a refused hub leaves nothing behind ──────
test('a refused hub writes NO hub.state.json (the rules run before the secret is generated)', () => {
  const cases: Array<Record<string, string>> = [
    { SLAYZONE_HUB_REQUIRE_LOGIN: 'true' }, // B4
    { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' }, // B5
    { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PASSWORD: '0' }, // B2
    { SLAYZONE_HUB_PUBLIC_ADDRESS: 'https://hub.example.com' } // B8
  ]
  for (const env of cases) {
    withIsolatedEnv(env, () => {
      const msg = throwsFrom(() => applyStandaloneHubConfig())
      assert(msg !== null, `refused: ${JSON.stringify(env)}`)
      assert(!existsSync(getHubStateFilePath()), `no state file for ${JSON.stringify(env)}`)
      assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'no secret generated')
    })
  }
})

console.log('\nstandalone-config: hub name (env > config > basename(ROOT))')
console.log('─'.repeat(40))

test('defaults to the ROOT directory name — no config, no env', () => {
  withIsolatedEnv({}, (home) => {
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_NAME, basename(home), 'name = basename(ROOT)')
  })
})

test('hub.config.json hubName beats the ROOT-name default', () => {
  withIsolatedEnv({}, () => {
    saveHubConfigFile({ hubName: 'staging' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_NAME, 'staging', 'config hubName')
  })
})

test('env SLAYZONE_HUB_NAME beats hub.config.json', () => {
  withIsolatedEnv({ SLAYZONE_HUB_NAME: 'from-env' }, () => {
    saveHubConfigFile({ hubName: 'from-file' })
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_NAME, 'from-env', 'env wins')
  })
})

test('a blank env name falls through to the default (not an empty hub name)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_NAME: '   ' }, (home) => {
    applyStandaloneHubConfig()
    assertEq(process.env.SLAYZONE_HUB_NAME, basename(home), 'blank treated as unset')
  })
})

console.log('\nstandalone-config: supervised = no-op')
console.log('─'.repeat(40))

test('supervised does NOT read or write hub.config.json/hub.state.json (no file created, no env seeded)', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'no secret seeded when supervised')
    assert(!existsSync(getHubConfigFilePath()), 'no config file written when supervised')
    assert(!existsSync(getHubStateFilePath()), 'no state file written when supervised')
  })
})

test('supervised IGNORES an existing hub.config.json/hub.state.json entirely', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    saveHubConfigFile({ listenAddress: '0.0.0.0:8080', requireLogin: true })
    saveHubStateFile({ computerTransportSecret: 'should-be-ignored' })
    applyStandaloneHubConfig()
    assert(process.env.SLAYZONE_HUB_LISTEN_ADDRESS === undefined, 'ignored address')
    assert(process.env.SLAYZONE_HUB_REQUIRE_LOGIN === undefined, 'ignored switches')
    assert(process.env.SLAYZONE_HUB_AUTH_SECRET === undefined, 'ignored computerTransportSecret')
  })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
