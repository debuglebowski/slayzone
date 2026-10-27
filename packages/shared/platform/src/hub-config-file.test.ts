/**
 * hub.config.json / hub.state.json — loadHubConfigFile / loadHubStateFile /
 * save / update / ensureHubAuthSecret, plus the legacy shared-config.json
 * fallback. Pure Node (real temp files, no native deps) → runs under plain
 * `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-config-file.test.ts
 */
import { describe, expect, test } from 'vitest'
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

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-hubcfg-'))
}

describe('hub-config-file: loadHubConfigFile', () => {
  test('missing file ⇒ {} (no throw)', () => {
    const dir = tmp()
    try {
      const cfg = loadHubConfigFile(join(dir, 'nope.json'))
      expect(Object.keys(cfg).length, 'empty config').toBe(0)
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
      expect(Object.keys(cfg).length, 'empty config on corrupt').toBe(0)
      expect(warned, 'warned about invalid JSON').toMatch(/not valid JSON/)
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
      expect(Object.keys(cfg).length, 'empty on array').toBe(0)
      expect(warned, 'warned about non-object').toMatch(/not a JSON object/)
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
    expect(cfg.listenAddress, 'listenAddress').toBe('0.0.0.0:8080')
    expect(cfg.publicAddress, 'publicAddress').toBe('hub.example:8443')
    expect(cfg.hubName, 'hubName').toBe('my-hub')
    expect(cfg.requireLogin, 'requireLogin').toBe(true)
    expect(cfg.enablePassword, 'enablePassword').toBe(false)
    expect(cfg.enableSso, 'enableSso').toBe(true)
    expect(cfg.ssoTenantId, 'ssoTenantId').toBe('tenant-1')
    expect(cfg.ssoClientId, 'ssoClientId').toBe('client-1')
    expect(cfg.enableProcesses, 'enableProcesses').toBe(false)
    expect(cfg.enableIntegrations, 'enableIntegrations').toBe(false)
    expect(cfg, 'unknown key dropped').not.toHaveProperty('extra')
    expect(loadHubConfigProblems(p).length, 'a clean file has no boot problems').toBe(0)
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
    expect(cfg.listenAddress, 'empty listenAddress dropped').toBeUndefined()
    expect(cfg.publicAddress, 'non-string publicAddress dropped').toBeUndefined()
    expect(cfg.requireLogin, 'non-boolean switch dropped from the config object').toBeUndefined()
    expect(cfg.ssoTenantId, 'blank ssoTenantId dropped').toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  // The secret never lives in the file: there is no HubConfig key for it, so even a
  // hand-written `ssoClientSecret` is not carried anywhere.
  test('ssoClientSecret in the file is not read (secrets are env only)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ ssoClientSecret: 'nope', ssoClientId: 'c' }))
    const cfg = loadHubConfigFile(p)
    expect(cfg, 'secret key not loaded').not.toHaveProperty('ssoClientSecret')
    expect(cfg.ssoClientId, 'its sibling still loads').toBe('c')
    rmSync(dir, { recursive: true, force: true })
  })

  // `mode` was the FILE channel for SLAYZONE_MODE. The mode is gone: the key is
  // ignored — it is neither read nor a boot problem.
  test('mode is ignored: not read, not a problem', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ mode: 'remote', hubName: 'h' }))
    const cfg = loadHubConfigFile(p)
    expect(cfg, 'mode not carried').not.toHaveProperty('mode')
    expect(cfg.hubName, 'rest of the file loads').toBe('h')
    expect(loadHubConfigProblems(p).length, 'a leftover mode key is NOT a boot problem').toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('hub-config-file: boot problems (B4, B5)', () => {
  test('B5: the old `address` key is a boot problem naming listenAddress', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ address: '0.0.0.0:8080' }))
    const problems = loadHubConfigProblems(p)
    expect(problems.length, 'one problem').toBe(1)
    expect(problems[0]!.key, 'names the key').toBe('address')
    expect(problems[0]!.message, problems[0]!.message).toMatch(/renamed to 'listenAddress'/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('B5: the old `port` key is a boot problem naming listenAddress', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ port: 8080 }))
    const problems = loadHubConfigProblems(p)
    expect(problems.length, 'one problem').toBe(1)
    expect(problems[0]!.key, 'names the key').toBe('port')
    expect(problems[0]!.message, problems[0]!.message).toMatch(/renamed to 'listenAddress/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('B5: the old `publicUrl` key is a boot problem naming publicAddress', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ publicUrl: 'https://hub.example' }))
    const problems = loadHubConfigProblems(p)
    expect(problems.length, 'one problem').toBe(1)
    expect(problems[0]!.key, 'names the key').toBe('publicUrl')
    expect(problems[0]!.message, problems[0]!.message).toMatch(/renamed to 'publicAddress/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('B5: every renamed key present is reported, not just the first', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ address: 'a:1', port: 2, publicUrl: 'https://x' }))
    const keys = loadHubConfigProblems(p)
      .map((x) => x.key)
      .sort()
    expect(keys.join(','), 'all three reported').toBe('address,port,publicUrl')
    rmSync(dir, { recursive: true, force: true })
  })

  test('B4: a switch key that is not a boolean is a boot problem (never silently unset)', () => {
    const dir = tmp()
    for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
      const p = join(dir, 'bad.json')
      writeFileSync(p, JSON.stringify({ requireLogin: bad }))
      const problems = loadHubConfigProblems(p)
      expect(problems.length, `reported: ${JSON.stringify(bad)}`).toBe(1)
      expect(problems[0]!.key, 'names the key').toBe('requireLogin')
      expect(problems[0]!.message, problems[0]!.message).toMatch(/true or false/)
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
      expect(loadHubConfigProblems(p)[0]?.key, `${key} validated`).toBe(key)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('problems come from the legacy config.json too when hub.config.json is absent', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ address: '0.0.0.0:9' }))
    expect(loadHubConfigProblems(join(dir, 'hub.config.json'))[0]?.key, 'legacy file checked').toBe('address')
    rmSync(dir, { recursive: true, force: true })
  })

  test('no file ⇒ no problems', () => {
    const dir = tmp()
    expect(loadHubConfigProblems(join(dir, 'nope.json')).length, 'no file, no problems').toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test('switches round-trip through update without clobbering the address keys', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    saveHubConfigFile({ listenAddress: '0.0.0.0:8443', publicAddress: 'hub.example:8443' }, p)
    updateHubConfigFile({ requireLogin: true, enableProcesses: false }, p)
    const back = loadHubConfigFile(p)
    expect(back.requireLogin, 'requireLogin written').toBe(true)
    expect(back.enableProcesses, 'enableProcesses written (false survives the merge)').toBe(false)
    expect(back.listenAddress, 'listenAddress preserved').toBe('0.0.0.0:8443')
    expect(back.publicAddress, 'publicAddress preserved').toBe('hub.example:8443')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an update drops the renamed keys it rewrites over (no stale address survives)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    writeFileSync(p, JSON.stringify({ address: 'old:1', hubName: 'h' }))
    updateHubConfigFile({ requireLogin: true }, p)
    expect(loadHubConfigProblems(p).length, 'rewritten file no longer carries `address`').toBe(0)
    expect(loadHubConfigFile(p).hubName, 'other keys kept').toBe('h')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('hub-config-file: save / update round-trip', () => {
  test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
    const dir = tmp()
    const p = join(dir, 'sub', 'hub.config.json')
    saveHubConfigFile({ listenAddress: '127.0.0.1:8443', publicAddress: 'hub.example' }, p)
    const back = loadHubConfigFile(p)
    expect(back.listenAddress, 'listenAddress round-trip').toBe('127.0.0.1:8443')
    expect(back.publicAddress, 'publicAddress round-trip').toBe('hub.example')
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777, 'file mode 0600').toBe(0o600)
      expect(statSync(join(dir, 'sub')).mode & 0o777, 'dir mode 0700').toBe(0o700)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('updateHubConfigFile merges over on-disk base (no clobber of other keys)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    saveHubConfigFile({ publicAddress: 'hub.example:9', hubName: 'first' }, p)
    const merged = updateHubConfigFile({ listenAddress: '0.0.0.0:8443' }, p)
    expect(merged.publicAddress, 'kept publicAddress').toBe('hub.example:9')
    expect(merged.hubName, 'kept hubName').toBe('first')
    expect(merged.listenAddress, 'added listenAddress').toBe('0.0.0.0:8443')
    const onDisk = loadHubConfigFile(p)
    expect(onDisk.listenAddress, 'persisted').toBe('0.0.0.0:8443')
    expect(onDisk.publicAddress, 'persisted publicAddress').toBe('hub.example:9')
    rmSync(dir, { recursive: true, force: true })
  })

  test('update ignores undefined patch values (does not erase)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.config.json')
    saveHubConfigFile({ hubName: 'keepme' }, p)
    const merged = updateHubConfigFile({ hubName: undefined, listenAddress: '127.0.0.1:5' }, p)
    expect(merged.hubName, 'undefined did not erase hubName').toBe('keepme')
    expect(merged.listenAddress, 'added listenAddress').toBe('127.0.0.1:5')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('hub-config-file: ensureHubAuthSecret', () => {
  test('generates + persists a secret when absent (0600, != dev constant)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.state.json')
    const secret = ensureHubAuthSecret(p)
    expect(secret.length, '256-bit hex = 64 chars').toBe(64)
    expect(secret, 'not the shared dev constant').not.toBe(DEV_HUB_AUTH_SECRET)
    expect(secret, 'lowercase hex').toMatch(/^[0-9a-f]{64}$/)
    const onDisk = loadHubStateFile(p)
    expect(onDisk.computerTransportSecret, 'persisted into hub.state.json').toBe(secret)
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777, 'file mode 0600').toBe(0o600)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('stable across calls (reuses persisted secret, no re-generate)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.state.json')
    const s1 = ensureHubAuthSecret(p)
    const s2 = ensureHubAuthSecret(p)
    expect(s1, 'same secret on second call').toBe(s2)
    rmSync(dir, { recursive: true, force: true })
  })

  test('honors a pre-existing state-file computerTransportSecret (does not overwrite)', () => {
    const dir = tmp()
    const p = join(dir, 'hub.state.json')
    saveHubStateFile({ computerTransportSecret: 'preset-secret-value' }, p)
    const secret = ensureHubAuthSecret(p)
    expect(secret, 'returned the pre-existing secret').toBe('preset-secret-value')
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
    expect(a, 'both boots converge on ONE secret').toBe(b)
    expect(loadHubStateFile(p).computerTransportSecret, 'on-disk secret matches').toBe(a)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('hub-config-file: SLAYZONE_ROOT honored', () => {
  test('getHubConfigFilePath / getHubStateFilePath resolve under SLAYZONE_ROOT', () => {
    const dir = tmp()
    const prev = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = dir
    try {
      expect(getHubConfigFilePath(), 'config path under root override').toBe(join(dir, 'hub.config.json'))
      expect(getHubStateFilePath(), 'state path under root override').toBe(join(dir, 'hub.state.json'))
      saveHubConfigFile({ listenAddress: '127.0.0.1:1234' })
      const raw = readFileSync(join(dir, 'hub.config.json'), 'utf8')
      expect(raw, 'wrote to the overridden root dir').toMatch(/1234/)
      expect(loadHubConfigFile().listenAddress, 'default-path load reads the override').toBe('127.0.0.1:1234')
    } finally {
      if (prev === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('hub-config-file: legacy shared config.json fallback', () => {
  test('hub.config.json absent, legacy config.json present ⇒ hub keys coerced from it', () => {
    const dir = tmp()
    const legacyPath = join(dir, 'config.json')
    writeFileSync(
      legacyPath,
      JSON.stringify({ listenAddress: '0.0.0.0:9000', hubName: 'legacy-hub' })
    )
    const cfgPath = join(dir, 'hub.config.json')
    const cfg = loadHubConfigFile(cfgPath)
    expect(cfg.listenAddress, 'listenAddress from legacy file').toBe('0.0.0.0:9000')
    expect(cfg.hubName, 'hubName from legacy file').toBe('legacy-hub')
    expect(existsSync(cfgPath), 'never auto-upgrades — hub.config.json not created by a read').toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('hub.state.json absent, legacy config.json present ⇒ secret coerced from it', () => {
    const dir = tmp()
    const legacyPath = join(dir, 'config.json')
    writeFileSync(legacyPath, JSON.stringify({ computerTransportSecret: 'legacy-secret' }))
    const statePath = join(dir, 'hub.state.json')
    const state = loadHubStateFile(statePath)
    expect(state.computerTransportSecret, 'secret from legacy file').toBe('legacy-secret')
    expect(existsSync(statePath), 'never auto-upgrades — hub.state.json not created by a read').toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('ensureHubAuthSecret reuses a legacy secret rather than generating a new one', () => {
    const dir = tmp()
    const legacyPath = join(dir, 'config.json')
    writeFileSync(legacyPath, JSON.stringify({ computerTransportSecret: 'legacy-secret-value' }))
    const statePath = join(dir, 'hub.state.json')
    const secret = ensureHubAuthSecret(statePath)
    expect(secret, 'the legacy secret, not a freshly generated one').toBe('legacy-secret-value')
    rmSync(dir, { recursive: true, force: true })
  })

  test('new file present takes priority over the legacy file even if both exist', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ listenAddress: 'from-legacy:1' }))
    const cfgPath = join(dir, 'hub.config.json')
    saveHubConfigFile({ listenAddress: 'from-new:2' }, cfgPath)
    expect(loadHubConfigFile(cfgPath).listenAddress, 'new file wins once it exists').toBe('from-new:2')
    rmSync(dir, { recursive: true, force: true })
  })
})
