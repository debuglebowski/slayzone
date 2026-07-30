import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/platform/slayzone-config'
import { assertPathAllowed, ENV_VARS, loadRunnerConfig } from './config'
import { JOIN_TOKEN_PREFIX, type JoinTokenPayload } from '@slayzone/platform/join-token'

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
  it('builds a config from env with sensible defaults (ADDRESS → ws:// in local mode)', () => {
    // Env carries authority only; local mode (default) composes ws://…/runners.
    const config = loadRunnerConfig({
      [ENV_VARS.hubAddress]: 'hub.example:8443',
      [ENV_VARS.joinToken]: 'jt-1'
    })
    expect(config).toEqual({
      hubUrl: 'ws://hub.example:8443/runners',
      joinToken: 'jt-1',
      name: hostname(),
      allowedRoots: [],
      capabilities: ['pty', 'git', 'fs', 'proc']
    })
  })

  it('ADDRESS composes wss://…/runners in remote mode', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubAddress]: 'hub.example.com',
      SLAYZONE_MODE: 'remote'
    })
    expect(config.hubUrl).toBe('wss://hub.example.com/runners')
  })

  it('reads allowedRoots from the shared config (standalone operator channel)', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example' },
      { allowedRoots: ['/srv/a', '/srv/b'] }
    )
    expect(config.allowedRoots).toEqual(['/srv/a', '/srv/b'])
    // capabilities always defaults to the full set (env knob removed).
    expect(config.capabilities).toEqual(['pty', 'git', 'fs', 'proc'])
  })

  it('allowedRoots defaults to [homedir()] when SUPERVISED (no env channel)', () => {
    // The supervised local runner self-derives its FS path-jail — the former
    // SLAYZONE_RUNNER_ALLOWED_ROOTS host-injection channel is gone. shared={}
    // for a supervised runner, so this default holds untouched.
    const config = loadRunnerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_SUPERVISED: '1'
    })
    expect(config.allowedRoots).toEqual([homedir()])
  })

  it('name defaults to the local-runner const when SUPERVISED (dedup pair)', () => {
    // No env name channel anymore: a supervised runner derives the shared const
    // so the hub composition can collapse it to one row.
    const config = loadRunnerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_SUPERVISED: '1'
    })
    expect(config.name).toBe(DEFAULT_LOCAL_RUNNER_NAME)
  })

  it('name defaults to the hostname when NOT supervised and no config', () => {
    const config = loadRunnerConfig({ [ENV_VARS.hubAddress]: 'hub.example' })
    expect(config.name).toBe(hostname())
  })

  it('config.json runnerName overrides the hostname default (standalone rename)', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example' },
      { runnerName: 'from-config' }
    )
    expect(config.name).toBe('from-config')
  })

  it('reads hubUrl/name/pinnedCertSha256 from the shared config', () => {
    // The single <ROOT>/config.json carries the pin too (the former
    // SLAYZONE_RUNNER_CONFIG path-pointing env var is gone). Creds always derive
    // from the ROOT anchor (`<ROOT>/runners`) — no credentialsDir knob.
    const config = loadRunnerConfig(
      {},
      {
        hubUrl: 'wss://from-config.example/runners',
        runnerName: 'from-config',
        pinnedCertSha256: 'a'.repeat(64)
      }
    )
    expect(config.hubUrl).toBe('wss://from-config.example/runners')
    expect(config.name).toBe('from-config')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('env ADDRESS wins over the shared config full url', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubAddress]: 'from-env.example' },
      { hubUrl: 'wss://from-config.example/runners' }
    )
    // Env authority (local mode) composes ws://…/runners and beats config.json.
    expect(config.hubUrl).toBe('ws://from-env.example/runners')
  })

  it('fails with a readable error when hub address is missing', () => {
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_ADDRESS/)
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

  it('lets an explicit env hubUrl + config pin override the join-token values', () => {
    const token = mintToken({
      hubUrl: 'wss://from-token/runners',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    // hub address overrides via env; the pin has no env channel — config.json is
    // its explicit override path and still beats the token-decoded fingerprint.
    // remote mode so the env authority composes wss:// (matches the token's TLS).
    const config = loadRunnerConfig(
      {
        [ENV_VARS.joinToken]: token,
        [ENV_VARS.hubAddress]: 'override.example',
        SLAYZONE_MODE: 'remote'
      },
      { pinnedCertSha256: 'b'.repeat(64) }
    )
    expect(config.hubUrl).toBe('wss://override.example/runners')
    expect(config.pinnedCertSha256).toBe('b'.repeat(64))
  })

  it('ignores a malformed join token for fallback (schema still reports missing address)', () => {
    expect(() => loadRunnerConfig({ [ENV_VARS.joinToken]: 'not-a-token' })).toThrow(
      /SLAYZONE_HUB_ADDRESS/
    )
  })

  it('fails fast when an EXPLICIT config.json pin is set on a ws:// hub url (no silent downgrade)', () => {
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

  it('accepts an explicit config.json pin on a wss:// hub url', () => {
    const config = loadRunnerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example', SLAYZONE_MODE: 'remote' },
      { pinnedCertSha256: 'a'.repeat(64) }
    )
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  // --- SLAYZONE_MODE=remote hardening: plaintext ws:// hub is a hard error ------
  // NOTE: an env SLAYZONE_HUB_ADDRESS can no longer PRODUCE ws:// in remote mode
  // (hubUrlFromAddr forces wss:// there — the whole point of the redesign). The
  // guard now only catches a full ws:// url supplied via config.json / join token,
  // so drive it through the shared config.
  it('rejects a plaintext ws:// hub url (from config.json) in remote mode', () => {
    expect(() =>
      loadRunnerConfig({ SLAYZONE_MODE: 'remote' }, { hubUrl: 'ws://hub.example/runners' })
    ).toThrow(/wss:\/\//)
  })

  it('ADDRESS in remote mode composes wss:// (never ws://)', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_MODE: 'remote'
    })
    expect(config.hubUrl).toBe('wss://hub.example/runners')
  })

  it('still composes ws:// in local mode (dev/loopback)', () => {
    const config = loadRunnerConfig({ [ENV_VARS.hubAddress]: '127.0.0.1:9000' })
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
      { [ENV_VARS.hubAddress]: 'from-env.example' },
      { hubUrl: 'wss://shared.example/runners', runnerName: 'shared-runner' }
    )
    // Env authority (local mode) composes ws://…/runners and beats config.json.
    expect(config.hubUrl).toBe('ws://from-env.example/runners')
    expect(config.name).toBe('shared-runner') // shared name survives (no env override)
  })

  it('does not read the developer real config when an explicit env is passed (hermetic)', () => {
    // Passing an `env` object other than process.env ⇒ shared defaults to {} so
    // tests never accidentally pick up ~/.slayzone/config.json.
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_ADDRESS/)
  })

  it('SUPERVISED runner does NOT layer in the shared config (mirrors hub no-op)', () => {
    // The app-spawned local runner inherits SLAYZONE_SUPERVISED=1 via {...process.env}.
    // Drive the DEFAULT `shared` param (real process.env) with SUPERVISED set + a real
    // config.json (via SLAYZONE_ROOT) carrying a hubUrl. The shared file MUST be
    // skipped → the only hubUrl source is missing → schema throws. Without the gate
    // the shared hubUrl would leak in and it would NOT throw.
    const savedHome = process.env.SLAYZONE_ROOT
    const savedSup = process.env.SLAYZONE_SUPERVISED
    const savedAddr = process.env.SLAYZONE_HUB_ADDRESS
    const savedToken = process.env.SLAYZONE_HUB_JOIN_TOKEN
    try {
      delete process.env.SLAYZONE_HUB_ADDRESS
      delete process.env.SLAYZONE_HUB_JOIN_TOKEN
      process.env.SLAYZONE_ROOT = dir
      process.env.SLAYZONE_SUPERVISED = '1'
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ hubUrl: 'wss://shared.example/runners' }))
      // Supervised ⇒ shared skipped ⇒ no hub source anywhere ⇒ throws.
      expect(() => loadRunnerConfig()).toThrow(/SLAYZONE_HUB_ADDRESS/)
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
      restore('SLAYZONE_HUB_ADDRESS', savedAddr)
      restore('SLAYZONE_HUB_JOIN_TOKEN', savedToken)
    }
  })

  // --- join token: ONE env name, no aliases ---
  // The token is minted BY the hub and embeds the hub's url + cert pin + a secret
  // verified against the hub's `join_tokens` row; `mintJoinToken` binds it to NO
  // runner (runner_id is NULL until redemption). So the value is hub-scoped, and
  // the pre-rename `SLAYZONE_RUNNER_JOIN_TOKEN` described its consumer — the one
  // thing CLAUDE.md rule 2 forbids. It is RETIRED outright, not aliased: it never
  // shipped (published runner betas 0.36.0-beta.2/3 read `SLAYZONE_JOIN_TOKEN`),
  // so no operator env anywhere carries it. Same treatment as the other unshipped
  // renames in this sweep, which were all dropped cold.
  describe('join-token env name', () => {
    it('reads the canonical SLAYZONE_HUB_JOIN_TOKEN', () => {
      const config = loadRunnerConfig({
        [ENV_VARS.hubAddress]: 'hub.example',
        [ENV_VARS.joinToken]: 'jt-new'
      })
      expect(config.joinToken).toBe('jt-new')
    })

    it('exposes exactly one join-token env name (no alias in ENV_VARS)', () => {
      expect(Object.values(ENV_VARS).filter((v) => v.includes('JOIN_TOKEN'))).toEqual([
        'SLAYZONE_HUB_JOIN_TOKEN'
      ])
    })

    it('IGNORES the retired SLAYZONE_RUNNER_JOIN_TOKEN', () => {
      // A retired name must not stay a silent input channel. `joinToken` is
      // optional (an enrolled runner reconnects on stored credentials), so the old
      // name simply yields no token — first contact then fails at enrollment, not
      // with a half-honoured config.
      const config = loadRunnerConfig({
        [ENV_VARS.hubAddress]: 'hub.example',
        SLAYZONE_RUNNER_JOIN_TOKEN: 'jt-old'
      })
      expect(config.joinToken).toBeUndefined()
    })

    it('IGNORES a retired-name token for the hubUrl/pin fallback too', () => {
      // The decode fallback reads the SAME resolved value, so a token supplied only
      // under the old name cannot smuggle in a hub url either: with no hubAddress
      // there is no hub source left and the schema reports it.
      const token = mintToken({
        hubUrl: 'wss://hub.example:8443/runners',
        certFingerprint: 'a'.repeat(64),
        secret: 's'
      })
      expect(() => loadRunnerConfig({ SLAYZONE_RUNNER_JOIN_TOKEN: token })).toThrow(
        /SLAYZONE_HUB_ADDRESS/
      )
    })

    it('is self-sufficient from the token alone (hubUrl + pin extracted)', () => {
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

    it('names the canonical var in the missing-config error', () => {
      expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_JOIN_TOKEN/)
    })

    it('env beats a config.json joinToken', () => {
      const fromEnv = loadRunnerConfig(
        { [ENV_VARS.hubAddress]: 'hub.example', [ENV_VARS.joinToken]: 'jt-env' },
        { joinToken: 'jt-file' }
      )
      expect(fromEnv.joinToken).toBe('jt-env')
    })
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
