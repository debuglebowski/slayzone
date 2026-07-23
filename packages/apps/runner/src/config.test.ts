import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/platform/slayzone-config'
import { assertPathAllowed, ENV_VARS, loadRunnerConfig } from './config'
import { JOIN_TOKEN_PREFIX, type JoinTokenPayload } from './join-token'

function mintToken(payload: JoinTokenPayload): string {
  return `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadRunnerConfig', () => {
  it('builds a config from env with sensible defaults', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example:8443/runners',
      [ENV_VARS.joinToken]: 'jt-1'
    })
    expect(config).toEqual({
      hubUrl: 'wss://hub.example:8443/runners',
      joinToken: 'jt-1',
      name: hostname(),
      allowedRoots: [],
      capabilities: ['pty', 'git', 'fs', 'proc']
    })
  })

  it('reads allowedRoots from the shared config (standalone operator channel)', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubUrl]: 'wss://hub.example/runners' },
      { allowedRoots: ['/srv/a', '/srv/b'] }
    )
    expect(config.allowedRoots).toEqual(['/srv/a', '/srv/b'])
    // capabilities always defaults to the full set (env knob removed).
    expect(config.capabilities).toEqual(['pty', 'git', 'fs', 'proc'])
  })

  it('env allowedRoots wins (the supervised host-injection channel)', () => {
    // The Electron host injects SLAYZONE_RUNNER_ALLOWED_ROOTS into its local
    // runner; env must override the shared config.
    const config = loadRunnerConfig(
      {
        [ENV_VARS.hubUrl]: 'wss://hub.example/runners',
        [ENV_VARS.allowedRoots]: ['/home/me', '/srv/x'].join(delimiter)
      },
      { allowedRoots: ['/from/config'] }
    )
    expect(config.allowedRoots).toEqual(['/home/me', '/srv/x'])
  })

  it('name defaults to the local-runner const when SUPERVISED (dedup pair)', () => {
    // No env name channel anymore: a supervised runner derives the shared const
    // so the hub composition can collapse it to one row.
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/runners',
      SLAYZONE_SUPERVISED: '1'
    })
    expect(config.name).toBe(DEFAULT_LOCAL_RUNNER_NAME)
  })

  it('name defaults to the hostname when NOT supervised and no config', () => {
    const config = loadRunnerConfig({ [ENV_VARS.hubUrl]: 'wss://hub.example/runners' })
    expect(config.name).toBe(hostname())
  })

  it('config.json runnerName overrides the hostname default (standalone rename)', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubUrl]: 'wss://hub.example/runners' },
      { runnerName: 'from-config' }
    )
    expect(config.name).toBe('from-config')
  })

  it('reads hubUrl/name/pinnedCertSha256/credentialsDir from the shared config', () => {
    // The single <ROOT>/config.json now carries pin + creds-dir too (the former
    // SLAYZONE_RUNNER_CONFIG path-pointing env var is gone).
    const config = loadRunnerConfig(
      {},
      {
        hubUrl: 'wss://from-config.example/runners',
        runnerName: 'from-config',
        pinnedCertSha256: 'a'.repeat(64),
        credentialsDir: '/var/lib/slayzone/runner'
      }
    )
    expect(config.hubUrl).toBe('wss://from-config.example/runners')
    expect(config.name).toBe('from-config')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
    expect(config.credentialsDir).toBe('/var/lib/slayzone/runner')
  })

  it('env wins over the shared config', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubUrl]: 'wss://from-env.example/runners' },
      { hubUrl: 'wss://from-config.example/runners' }
    )
    expect(config.hubUrl).toBe('wss://from-env.example/runners')
  })

  it('fails with a readable error when hubUrl is missing', () => {
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_URL/)
  })

  it('is self-sufficient from a join token alone (hubUrl + pin extracted)', () => {
    const token = mintToken({
      hubUrl: 'wss://hub.example:8443/runners',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('wss://hub.example:8443/runners')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
    expect(config.joinToken).toBe(token)
  })

  it('lets an explicit env hubUrl + pin override the join-token values', () => {
    const token = mintToken({
      hubUrl: 'wss://from-token/runners',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({
      [ENV_VARS.joinToken]: token,
      [ENV_VARS.hubUrl]: 'wss://override.example/runners',
      [ENV_VARS.pinnedCertSha256]: 'b'.repeat(64)
    })
    expect(config.hubUrl).toBe('wss://override.example/runners')
    expect(config.pinnedCertSha256).toBe('b'.repeat(64))
  })

  it('ignores a malformed join token for fallback (schema still reports missing hubUrl)', () => {
    expect(() => loadRunnerConfig({ [ENV_VARS.joinToken]: 'not-a-token' })).toThrow(
      /SLAYZONE_HUB_URL/
    )
  })

  it('fails fast when an EXPLICIT env pin is set on a ws:// hub url (no silent downgrade)', () => {
    expect(() =>
      loadRunnerConfig({
        [ENV_VARS.hubUrl]: 'ws://hub.example/runners',
        [ENV_VARS.pinnedCertSha256]: 'a'.repeat(64)
      })
    ).toThrow(/requires a wss:\/\/ hub url/)
  })

  it('fails fast when an EXPLICIT config.json pin is set on a ws:// hub url', () => {
    expect(() =>
      loadRunnerConfig(
        {},
        { hubUrl: 'ws://hub.example/runners', pinnedCertSha256: 'a'.repeat(64) }
      )
    ).toThrow(/requires a wss:\/\/ hub url/)
  })

  it('does NOT fail when only the join-token pin lands on a ws:// url (soft auto path)', () => {
    // A ws:// join token carries a fingerprint but the pin is NOT explicit — it is
    // softly ignored downstream (startRunner), so config assembly must not throw.
    const token = mintToken({
      hubUrl: 'ws://127.0.0.1:9000/runners',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('ws://127.0.0.1:9000/runners')
    // The decoded pin is still present in config; startRunner drops it for ws://.
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('accepts an explicit pin on a wss:// hub url', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/runners',
      [ENV_VARS.pinnedCertSha256]: 'a'.repeat(64)
    })
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  // --- SLAYZONE_MODE=remote hardening: plaintext ws:// hub is a hard error ------
  it('rejects a plaintext ws:// hub url in remote mode', () => {
    expect(() =>
      loadRunnerConfig({ [ENV_VARS.hubUrl]: 'ws://hub.example/runners', SLAYZONE_MODE: 'remote' })
    ).toThrow(/wss:\/\//)
  })

  it('accepts a wss:// hub url in remote mode', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/runners',
      SLAYZONE_MODE: 'remote'
    })
    expect(config.hubUrl).toBe('wss://hub.example/runners')
  })

  it('still allows ws:// in local mode (dev/loopback)', () => {
    const config = loadRunnerConfig({ [ENV_VARS.hubUrl]: 'ws://127.0.0.1:9000/runners' })
    expect(config.hubUrl).toBe('ws://127.0.0.1:9000/runners')
  })

  // --- shared <ROOT>/config.json layering (env > shared > default) ---
  it('reads hubUrl/joinToken/runnerName from the shared config as a base', () => {
    const config = loadRunnerConfig(
      {},
      { hubUrl: 'wss://shared.example/runners', joinToken: 'jt-shared', runnerName: 'shared-runner' }
    )
    expect(config.hubUrl).toBe('wss://shared.example/runners')
    expect(config.joinToken).toBe('jt-shared')
    expect(config.name).toBe('shared-runner')
  })

  it('ENV wins over the shared config; unset keys fall through', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubUrl]: 'wss://from-env.example/runners' },
      { hubUrl: 'wss://shared.example/runners', runnerName: 'shared-runner' }
    )
    expect(config.hubUrl).toBe('wss://from-env.example/runners')
    expect(config.name).toBe('shared-runner') // shared name survives (no env override)
  })

  it('does not read the developer real config when an explicit env is passed (hermetic)', () => {
    // Passing an `env` object other than process.env ⇒ shared defaults to {} so
    // tests never accidentally pick up ~/.slayzone/config.json.
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_URL/)
  })

  it('SUPERVISED runner does NOT layer in the shared config (mirrors hub no-op)', () => {
    // The app-spawned local runner inherits SLAYZONE_SUPERVISED=1 via {...process.env}.
    // Drive the DEFAULT `shared` param (real process.env) with SUPERVISED set + a real
    // config.json (via SLAYZONE_ROOT) carrying a hubUrl. The shared file MUST be
    // skipped → the only hubUrl source is missing → schema throws. Without the gate
    // the shared hubUrl would leak in and it would NOT throw.
    const savedHome = process.env.SLAYZONE_ROOT
    const savedSup = process.env.SLAYZONE_SUPERVISED
    const savedHub = process.env.SLAYZONE_HUB_URL
    const savedToken = process.env.SLAYZONE_RUNNER_JOIN_TOKEN
    try {
      delete process.env.SLAYZONE_HUB_URL
      delete process.env.SLAYZONE_RUNNER_JOIN_TOKEN
      process.env.SLAYZONE_ROOT = dir
      process.env.SLAYZONE_SUPERVISED = '1'
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ hubUrl: 'wss://shared.example/runners' }))
      // Supervised ⇒ shared skipped ⇒ no hubUrl anywhere ⇒ throws.
      expect(() => loadRunnerConfig()).toThrow(/SLAYZONE_HUB_URL/)
      // Sanity: with SUPERVISED unset, the SAME shared config IS read (no throw).
      delete process.env.SLAYZONE_SUPERVISED
      expect(loadRunnerConfig().hubUrl).toBe('wss://shared.example/runners')
    } finally {
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      restore('SLAYZONE_ROOT', savedHome)
      restore('SLAYZONE_SUPERVISED', savedSup)
      restore('SLAYZONE_HUB_URL', savedHub)
      restore('SLAYZONE_RUNNER_JOIN_TOKEN', savedToken)
    }
  })
})

describe('assertPathAllowed', () => {
  it('accepts a path inside an allowed root and returns its canonical path', () => {
    const root = realpathSync(dir)
    const nested = join(root, 'a', 'b')
    expect(assertPathAllowed(nested, [root])).toBe(nested)
    // The root itself is allowed.
    expect(assertPathAllowed(root, [root])).toBe(root)
  })

  it('rejects ../ traversal that escapes every allowed root', () => {
    const root = realpathSync(dir)
    expect(() => assertPathAllowed(join(root, '..', 'outside'), [root])).toThrow(/allowedRoots/)
    expect(() => assertPathAllowed(join(root, 'sub', '..', '..', 'escape'), [root])).toThrow(
      /allowedRoots/
    )
  })

  it('rejects a sibling directory sharing a name prefix with the root', () => {
    const root = realpathSync(dir)
    // `${root}-evil` textually starts with `${root}` but is NOT contained.
    expect(() => assertPathAllowed(`${root}-evil/x`, [root])).toThrow(/allowedRoots/)
  })

  it('resolves symlinked ancestors so they cannot smuggle a path out of a root', () => {
    const root = realpathSync(dir)
    const outside = mkdtempSync(join(tmpdir(), 'runner-outside-'))
    try {
      // A symlink INSIDE the root pointing OUT of it must not grant access.
      const link = join(root, 'escape-link')
      symlinkSync(realpathSync(outside), link)
      expect(() => assertPathAllowed(join(link, 'secret'), [root])).toThrow(/allowedRoots/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws when no roots are configured', () => {
    expect(() => assertPathAllowed('/anything', [])).toThrow(/no allowedRoots/)
  })
})
