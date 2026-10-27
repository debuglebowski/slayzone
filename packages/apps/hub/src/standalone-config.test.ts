/**
 * Hub standalone-config resolve — applyStandaloneHubConfig folds
 * hub.config.json/hub.state.json into process.env with env>file>default
 * precedence, and resolves/persists the hub-auth secret (security fix).
 * Supervised = no-op (no file read/write).
 *
 * Pure Node (real temp home dir via SLAYZONE_ROOT, no native deps).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/standalone-config.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { assert, expect, test } from 'vitest'
import {
  DEV_HUB_AUTH_SECRET,
  getHubConfigFilePath,
  getHubStateFilePath,
  loadHubStateFile,
  saveHubConfigFile,
  saveHubStateFile
} from '@slayzone/platform/slayzone-config'
import { applyStandaloneHubConfig } from './standalone-config.js'

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
    expect(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, 'listenAddress').toBe('0.0.0.0:8080')
    expect(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'publicAddress').toBe('hub.example:8443')
    expect(process.env.SLAYZONE_HUB_ADDRESS, 'the dial-side name is never seeded onto a hub').toBe(
      undefined
    )
  })
})

test('env WINS over hub.config.json (does not overwrite a set env)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:9999' }, () => {
    saveHubConfigFile({ listenAddress: '0.0.0.0:8080' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, 'env address kept').toBe('127.0.0.1:9999')
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
    expect(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, 'requireLogin true → 1').toBe('1')
    expect(process.env.SLAYZONE_HUB_ENABLE_PASSWORD, 'enablePassword false → 0').toBe('0')
    expect(process.env.SLAYZONE_HUB_ENABLE_SSO, 'enableSso true → 1').toBe('1')
    expect(process.env.SLAYZONE_HUB_ENABLE_PROCESSES, 'enableProcesses false → 0').toBe('0')
    expect(process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS, 'enableIntegrations false → 0').toBe('0')
    expect(process.env.SLAYZONE_HUB_SSO_TENANT_ID, 'ssoTenantId').toEqual(TENANT)
    expect(process.env.SLAYZONE_HUB_SSO_CLIENT_ID, 'ssoClientId').toEqual(CLIENT)
  })
})

test('an ABSENT switch key leaves the env unset (the default applies, not an invented value)', () => {
  withIsolatedEnv({}, () => {
    saveHubConfigFile({ requireLogin: true })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, 'the key that is there').toBe('1')
    expect(process.env.SLAYZONE_HUB_ENABLE_PASSWORD, 'enablePassword not seeded').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_ENABLE_SSO, 'enableSso not seeded').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_ENABLE_PROCESSES, 'enableProcesses not seeded').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS, 'enableIntegrations not seeded').toBe(
      undefined
    )
  })
})

test('env switches WIN over the file (false in the file, 1 in env → 1)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PROCESSES: '0' }, () => {
    saveHubConfigFile({ requireLogin: false, enableProcesses: true })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, 'env requireLogin kept').toBe('1')
    expect(process.env.SLAYZONE_HUB_ENABLE_PROCESSES, 'env enableProcesses kept').toBe('0')
  })
})

test('the SSO client secret has NO file channel: it is never seeded, even if written there', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(
      join(home, 'hub.config.json'),
      JSON.stringify({ ssoClientSecret: 'from-file', ssoClientSecretEnv: 'x', ssoClientId: 'c' })
    )
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_SSO_CLIENT_SECRET, 'secret is env only').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_SSO_CLIENT_ID, 'the non-secret id is seeded').toBe('c')
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
    expect(msg, msg).toMatch(/'address' was renamed to 'listenAddress'/)
    expect(msg, `names the file: ${msg}`).toContain(join(home, 'hub.config.json'))
    expect(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, 'nothing seeded before refusing').toBe(
      undefined
    )
  })
})

test('B5: the old `port` key refuses boot, naming listenAddress', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'hub.config.json'), JSON.stringify({ port: 8080 }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/'port' was renamed to 'listenAddress/)
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
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/'publicUrl' was renamed to 'publicAddress/)
  })
})

test('B5 applies to the legacy shared config.json fallback too', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ address: '0.0.0.0:8080' }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/renamed/)
  })
})

test('B4: a non-boolean switch in the file refuses boot, naming the key', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(join(home, 'hub.config.json'), JSON.stringify({ requireLogin: 'true' }))
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/'requireLogin' must be true or false/)
  })
})

test('a leftover `mode` key in the file is IGNORED — not seeded, not a refusal', () => {
  withIsolatedEnv({}, (home) => {
    writeFileSync(
      join(home, 'hub.config.json'),
      JSON.stringify({ mode: 'remote', hubName: 'from-file' })
    )
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_MODE, 'SLAYZONE_MODE is never seeded any more').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_NAME, 'rest of the file loads').toBe('from-file')
  })
})

test('a leftover SLAYZONE_MODE in env is ignored too (left exactly as it was)', () => {
  withIsolatedEnv({ SLAYZONE_MODE: 'remote' }, () => {
    saveHubConfigFile({ listenAddress: '127.0.0.1:8080' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_MODE, 'untouched, unread').toBe('remote')
    expect(
      process.env.SLAYZONE_HUB_AUTH_SECRET,
      'and it does not change the secret handling'
    ).toBeTruthy()
  })
})

test('no config + no env ⇒ only the generated hub-auth secret is set (defaults elsewhere)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, 'no address default here').toBe(undefined)
    expect(
      process.env.SLAYZONE_HUB_AUTH_SECRET,
      'hub-auth secret resolved on a local-only hub'
    ).toBeTruthy()
  })
})

test('generates + persists a hub-auth secret into hub.state.json (!= dev constant)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    expect(secret, 'env set').toBeTruthy()
    expect(secret, 'not the shared dev constant').not.toBe(DEV_HUB_AUTH_SECRET)
    expect(secret!.length, '256-bit hex').toBe(64)
    // persisted into the temp hub.state.json
    expect(loadHubStateFile().computerTransportSecret, 'persisted').toEqual(secret)
  })
})

test('second boot reuses the SAME persisted secret (stable)', () => {
  withIsolatedEnv({}, () => {
    applyStandaloneHubConfig()
    const first = process.env.SLAYZONE_HUB_AUTH_SECRET
    // simulate a fresh process: clear the env, keep the file
    delete process.env.SLAYZONE_HUB_AUTH_SECRET
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'same secret across boots').toEqual(first)
  })
})

test('env SLAYZONE_HUB_AUTH_SECRET wins + no state-file write', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: 'ci-pinned-secret' }, () => {
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'env secret kept').toBe('ci-pinned-secret')
    // hub.state.json should NOT have been created (no generate/persist path taken)
    expect(
      existsSync(getHubStateFilePath()),
      'no state file written when env pins the secret'
    ).toBe(false)
  })
})

test('hub.state.json computerTransportSecret used (env unset) and NOT regenerated', () => {
  withIsolatedEnv({}, () => {
    saveHubStateFile({ computerTransportSecret: 'from-state-file' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'state-file secret used').toBe('from-state-file')
  })
})

test('EMPTY env SLAYZONE_HUB_AUTH_SECRET counts as absent ⇒ generates (no misleading throw)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: '' }, () => {
    applyStandaloneHubConfig()
    const secret = process.env.SLAYZONE_HUB_AUTH_SECRET
    expect(secret, 'a real secret was generated (empty treated as absent)').toBeTruthy()
    expect(secret, 'not the dev constant').not.toBe(DEV_HUB_AUTH_SECRET)
    expect(secret!.length, '256-bit hex generated').toBe(64)
    expect(loadHubStateFile().computerTransportSecret, 'persisted').toEqual(secret)
  })
})

// ── B14: a hub other machines can reach gets no generated secret ─────────────
const REACH_OK = { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' }

test('B13/B14: a reachable hub with no secret in env is REFUSED — and writes no state file', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:8080' }, () => {
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/SLAYZONE_HUB_AUTH_SECRET is required/)
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'nothing generated into env').toBe(undefined)
    expect(existsSync(getHubStateFilePath()), 'hub.state.json not written').toBe(false)
  })
})

test('B13/B14: a loopback hub WITH a public address (same-box proxy) is refused the same way', () => {
  withIsolatedEnv(REACH_OK, () => {
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/SLAYZONE_HUB_AUTH_SECRET is required/)
    expect(existsSync(getHubStateFilePath()), 'hub.state.json not written').toBe(false)
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
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/SLAYZONE_HUB_AUTH_SECRET is required/)
    expect(existsSync(getHubStateFilePath()), 'hub.state.json not written').toBe(false)
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
      expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'env secret kept').toBe('from-env')
      expect(existsSync(getHubStateFilePath()), 'hub.state.json not written').toBe(false)
    }
  )
})

test('a reachable hub does NOT read a persisted state-file secret either: env or refuse', () => {
  withIsolatedEnv(REACH_OK, () => {
    saveHubStateFile({ computerTransportSecret: 'from-state-file' })
    const msg = throwsFrom(() => applyStandaloneHubConfig())
    assert(msg !== null, String(msg))
    expect(msg, String(msg)).toMatch(/SLAYZONE_HUB_AUTH_SECRET is required/)
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'the state file is not a source').toBe(undefined)
  })
})

// ── B17 (T-11): a secret this hub generated earlier is compared, never written ──
/** Run `fn`, returning what it wrote to stderr (and its refusal, if any). */
function captureStderr(fn: () => void): { stderr: string; refusal: string | null } {
  const chunks: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    return { refusal: throwsFrom(fn), stderr: chunks.join('') }
  } finally {
    process.stderr.write = original
  }
}

test('B17: a reachable hub whose state file holds THE SAME secret boots, file untouched, named as deletable', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_AUTH_SECRET: 'kept-and-in-env' }, () => {
    saveHubStateFile({ computerTransportSecret: 'kept-and-in-env' })
    const before = readFileSync(getHubStateFilePath(), 'utf8')
    const { stderr, refusal } = captureStderr(() => applyStandaloneHubConfig())
    expect(refusal, 'boots').toBe(null)
    expect(readFileSync(getHubStateFilePath(), 'utf8'), 'state file untouched').toEqual(before)
    expect(stderr, `names the file: ${stderr}`).toContain(getHubStateFilePath())
    expect(stderr, 'never prints the secret').not.toContain('kept-and-in-env')
  })
})

test('B17: a reachable hub whose state file holds a DIFFERENT secret is refused, file untouched', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_AUTH_SECRET: 'the-new-env-secret' }, () => {
    saveHubStateFile({ computerTransportSecret: 'the-old-file-secret' })
    const before = readFileSync(getHubStateFilePath(), 'utf8')
    const { refusal } = captureStderr(() => applyStandaloneHubConfig())
    assert(refusal !== null, 'refused')
    expect(refusal, refusal).toContain('differs from the computerTransportSecret')
    expect(refusal, 'names the file').toContain(getHubStateFilePath())
    expect(refusal, 'neither value in the message').not.toMatch(/the-(new-env|old-file)-secret/)
    expect(readFileSync(getHubStateFilePath(), 'utf8'), 'state file untouched').toEqual(before)
  })
})

test('B17 reads the legacy config.json the same way, and names that file', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_AUTH_SECRET: 'env' }, (home) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ computerTransportSecret: 'legacy' }))
    const { refusal } = captureStderr(() => applyStandaloneHubConfig())
    expect(refusal, String(refusal)).toContain(join(home, 'config.json'))
  })
})

test('a reachable hub names a leftover hub.owner.json as deletable, and leaves it', () => {
  withIsolatedEnv({ ...REACH_OK, SLAYZONE_HUB_AUTH_SECRET: 'env' }, (home) => {
    const owner = join(home, 'hub.owner.json')
    writeFileSync(owner, '{"password":"left-from-before"}')
    const { stderr, refusal } = captureStderr(() => applyStandaloneHubConfig())
    expect(refusal, 'boots').toBe(null)
    expect(stderr, `names the owner file: ${stderr}`).toContain(owner)
    expect(stderr, 'never prints its content').not.toContain('left-from-before')
    expect(existsSync(owner), 'not deleted').toBe(true)
  })
})

test('a loopback hub with an env secret never compares (unchanged: env wins, no warning)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_AUTH_SECRET: 'env-pin' }, () => {
    saveHubStateFile({ computerTransportSecret: 'file' })
    const { stderr, refusal } = captureStderr(() => applyStandaloneHubConfig())
    expect(refusal, 'boots').toBe(null)
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'env wins').toBe('env-pin')
    expect(stderr, 'no warning').toBe('')
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
      expect(existsSync(getHubStateFilePath()), `no state file for ${JSON.stringify(env)}`).toBe(
        false
      )
      expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'no secret generated').toBe(undefined)
    })
  }
})

test('defaults to the ROOT directory name — no config, no env', () => {
  withIsolatedEnv({}, (home) => {
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_NAME, 'name = basename(ROOT)').toEqual(basename(home))
  })
})

test('hub.config.json hubName beats the ROOT-name default', () => {
  withIsolatedEnv({}, () => {
    saveHubConfigFile({ hubName: 'staging' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_NAME, 'config hubName').toBe('staging')
  })
})

test('env SLAYZONE_HUB_NAME beats hub.config.json', () => {
  withIsolatedEnv({ SLAYZONE_HUB_NAME: 'from-env' }, () => {
    saveHubConfigFile({ hubName: 'from-file' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_NAME, 'env wins').toBe('from-env')
  })
})

test('a blank env name falls through to the default (not an empty hub name)', () => {
  withIsolatedEnv({ SLAYZONE_HUB_NAME: '   ' }, (home) => {
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_NAME, 'blank treated as unset').toEqual(basename(home))
  })
})

test('supervised does NOT read or write hub.config.json/hub.state.json (no file created, no env seeded)', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'no secret seeded when supervised').toBe(undefined)
    expect(existsSync(getHubConfigFilePath()), 'no config file written when supervised').toBe(false)
    expect(existsSync(getHubStateFilePath()), 'no state file written when supervised').toBe(false)
  })
})

test('supervised IGNORES an existing hub.config.json/hub.state.json entirely', () => {
  withIsolatedEnv({ SLAYZONE_SUPERVISED: '1' }, () => {
    saveHubConfigFile({ listenAddress: '0.0.0.0:8080', requireLogin: true })
    saveHubStateFile({ computerTransportSecret: 'should-be-ignored' })
    applyStandaloneHubConfig()
    expect(process.env.SLAYZONE_HUB_LISTEN_ADDRESS, 'ignored address').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_REQUIRE_LOGIN, 'ignored switches').toBe(undefined)
    expect(process.env.SLAYZONE_HUB_AUTH_SECRET, 'ignored computerTransportSecret').toBe(undefined)
  })
})
