import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
      [ENV_VARS.hubUrl]: 'wss://hub.example:8443/fleet',
      [ENV_VARS.joinToken]: 'jt-1'
    })
    expect(config).toEqual({
      hubUrl: 'wss://hub.example:8443/fleet',
      joinToken: 'jt-1',
      name: hostname(),
      allowedRoots: [],
      capabilities: ['pty', 'git', 'fs', 'proc']
    })
  })

  it('parses list-shaped env vars', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/fleet',
      [ENV_VARS.allowedRoots]: ['/srv/a', '/srv/b'].join(delimiter),
      [ENV_VARS.capabilities]: 'pty, git',
      [ENV_VARS.name]: 'runner-9',
      [ENV_VARS.heartbeatIntervalMs]: '5000'
    })
    expect(config.allowedRoots).toEqual(['/srv/a', '/srv/b'])
    expect(config.capabilities).toEqual(['pty', 'git'])
    expect(config.name).toBe('runner-9')
    expect(config.heartbeatIntervalMs).toBe(5000)
  })

  it('merges config file under env (env wins)', () => {
    const filePath = join(dir, 'runner.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        hubUrl: 'wss://from-file.example/fleet',
        name: 'from-file',
        capabilities: ['pty', 'fs'],
        pinnedCertSha256: 'a'.repeat(64)
      })
    )
    const config = loadRunnerConfig({
      [ENV_VARS.configFile]: filePath,
      [ENV_VARS.name]: 'from-env'
    })
    expect(config.hubUrl).toBe('wss://from-file.example/fleet')
    expect(config.name).toBe('from-env')
    expect(config.capabilities).toEqual(['pty', 'fs'])
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('fails with a readable error when hubUrl is missing', () => {
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_URL/)
  })

  it('is self-sufficient from a join token alone (hubUrl + pin extracted)', () => {
    const token = mintToken({
      hubUrl: 'wss://hub.example:8443/fleet',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('wss://hub.example:8443/fleet')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
    expect(config.joinToken).toBe(token)
  })

  it('lets an explicit env hubUrl + pin override the join-token values', () => {
    const token = mintToken({
      hubUrl: 'wss://from-token/fleet',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({
      [ENV_VARS.joinToken]: token,
      [ENV_VARS.hubUrl]: 'wss://override.example/fleet',
      [ENV_VARS.pinnedCertSha256]: 'b'.repeat(64)
    })
    expect(config.hubUrl).toBe('wss://override.example/fleet')
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
        [ENV_VARS.hubUrl]: 'ws://hub.example/fleet',
        [ENV_VARS.pinnedCertSha256]: 'a'.repeat(64)
      })
    ).toThrow(/requires a wss:\/\/ hub url/)
  })

  it('fails fast when an EXPLICIT config-file pin is set on a ws:// hub url', () => {
    const filePath = join(dir, 'runner.json')
    writeFileSync(
      filePath,
      JSON.stringify({ hubUrl: 'ws://hub.example/fleet', pinnedCertSha256: 'a'.repeat(64) })
    )
    expect(() => loadRunnerConfig({ [ENV_VARS.configFile]: filePath })).toThrow(
      /requires a wss:\/\/ hub url/
    )
  })

  it('does NOT fail when only the join-token pin lands on a ws:// url (soft auto path)', () => {
    // A ws:// join token carries a fingerprint but the pin is NOT explicit — it is
    // softly ignored downstream (startRunner), so config assembly must not throw.
    const token = mintToken({
      hubUrl: 'ws://127.0.0.1:9000/fleet',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadRunnerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('ws://127.0.0.1:9000/fleet')
    // The decoded pin is still present in config; startRunner drops it for ws://.
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('accepts an explicit pin on a wss:// hub url', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/fleet',
      [ENV_VARS.pinnedCertSha256]: 'a'.repeat(64)
    })
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('rejects malformed config files and non-integer heartbeat', () => {
    const filePath = join(dir, 'bad.json')
    writeFileSync(filePath, '{not json')
    expect(() => loadRunnerConfig({ [ENV_VARS.configFile]: filePath })).toThrow(/not valid JSON/)
    expect(() =>
      loadRunnerConfig({ [ENV_VARS.hubUrl]: 'wss://x/fleet', [ENV_VARS.heartbeatIntervalMs]: 'soon' })
    ).toThrow(/integer/)
  })

  // --- shared ~/.slayzone/config.json layering (env > runner file > shared > default) ---
  it('reads hubUrl/joinToken/runnerName from the shared config as a base', () => {
    const config = loadRunnerConfig(
      {},
      { hubUrl: 'wss://shared.example/fleet', joinToken: 'jt-shared', runnerName: 'shared-runner' }
    )
    expect(config.hubUrl).toBe('wss://shared.example/fleet')
    expect(config.joinToken).toBe('jt-shared')
    expect(config.name).toBe('shared-runner')
  })

  it('runner config FILE wins over the shared config', () => {
    const filePath = join(dir, 'runner.json')
    writeFileSync(filePath, JSON.stringify({ hubUrl: 'wss://from-file.example/fleet' }))
    const config = loadRunnerConfig(
      { [ENV_VARS.configFile]: filePath },
      { hubUrl: 'wss://shared.example/fleet', joinToken: 'jt-shared' }
    )
    expect(config.hubUrl).toBe('wss://from-file.example/fleet')
    // joinToken only in shared → still used (file did not set it)
    expect(config.joinToken).toBe('jt-shared')
  })

  it('ENV wins over both the runner file and the shared config', () => {
    const filePath = join(dir, 'runner.json')
    writeFileSync(filePath, JSON.stringify({ hubUrl: 'wss://from-file.example/fleet' }))
    const config = loadRunnerConfig(
      { [ENV_VARS.configFile]: filePath, [ENV_VARS.hubUrl]: 'wss://from-env.example/fleet' },
      { hubUrl: 'wss://shared.example/fleet', runnerName: 'shared-runner' }
    )
    expect(config.hubUrl).toBe('wss://from-env.example/fleet')
    expect(config.name).toBe('shared-runner') // shared name survives (no file/env override)
  })

  it('does not read the developer real config when an explicit env is passed (hermetic)', () => {
    // Passing an `env` object other than process.env ⇒ shared defaults to {} so
    // tests never accidentally pick up ~/.slayzone/config.json.
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_URL/)
  })

  it('SUPERVISED runner does NOT layer in the shared config (mirrors hub no-op)', () => {
    // The app-spawned local runner inherits SLAYZONE_SUPERVISED=1 via {...process.env}.
    // Drive the DEFAULT `shared` param (real process.env) with SUPERVISED set + a real
    // config.json (via SLAYZONE_HOME_DIR) carrying a hubUrl. The shared file MUST be
    // skipped → the only hubUrl source is missing → schema throws. Without the gate
    // the shared hubUrl would leak in and it would NOT throw.
    const savedHome = process.env.SLAYZONE_HOME_DIR
    const savedSup = process.env.SLAYZONE_SUPERVISED
    const savedHub = process.env.SLAYZONE_HUB_URL
    const savedToken = process.env.SLAYZONE_JOIN_TOKEN
    const savedCfg = process.env.SLAYZONE_RUNNER_CONFIG
    try {
      delete process.env.SLAYZONE_HUB_URL
      delete process.env.SLAYZONE_JOIN_TOKEN
      delete process.env.SLAYZONE_RUNNER_CONFIG
      process.env.SLAYZONE_HOME_DIR = dir
      process.env.SLAYZONE_SUPERVISED = '1'
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ hubUrl: 'wss://shared.example/fleet' }))
      // Supervised ⇒ shared skipped ⇒ no hubUrl anywhere ⇒ throws.
      expect(() => loadRunnerConfig()).toThrow(/SLAYZONE_HUB_URL/)
      // Sanity: with SUPERVISED unset, the SAME shared config IS read (no throw).
      delete process.env.SLAYZONE_SUPERVISED
      expect(loadRunnerConfig().hubUrl).toBe('wss://shared.example/fleet')
    } finally {
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      restore('SLAYZONE_HOME_DIR', savedHome)
      restore('SLAYZONE_SUPERVISED', savedSup)
      restore('SLAYZONE_HUB_URL', savedHub)
      restore('SLAYZONE_JOIN_TOKEN', savedToken)
      restore('SLAYZONE_RUNNER_CONFIG', savedCfg)
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
