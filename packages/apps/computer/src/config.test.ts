import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/slayzone-config'
import { assertPathAllowed, effectiveHubUrls, ENV_VARS, loadComputerConfig } from './config'
import { JOIN_TOKEN_PREFIX, type JoinTokenPayload } from '@slayzone/platform/join-token'

function mintToken(payload: JoinTokenPayload): string {
  return `${JOIN_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadComputerConfig', () => {
  it('builds a config from env with sensible defaults (ADDRESS → wss:// for a non-loopback host)', () => {
    // Env carries authority only; the scheme follows the host (A1): any host that
    // is not loopback composes wss://…/computers.
    const config = loadComputerConfig({
      [ENV_VARS.hubAddress]: 'hub.example:8443',
      [ENV_VARS.joinToken]: 'jt-1'
    })
    expect(config).toEqual({
      hubUrl: 'wss://hub.example:8443/computers',
      joinToken: 'jt-1',
      name: hostname(),
      allowedRoots: [],
      capabilities: ['pty', 'git', 'fs', 'proc']
    })
  })

  it('ADDRESS composes wss://…/computers for a public host, with no mode needed', () => {
    const config = loadComputerConfig({ [ENV_VARS.hubAddress]: 'hub.example.com' })
    expect(config.hubUrl).toBe('wss://hub.example.com/computers')
  })

  it('reads allowedRoots from the shared config (standalone operator channel)', () => {
    const config = loadComputerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example' },
      { allowedRoots: ['/srv/a', '/srv/b'] }
    )
    expect(config.allowedRoots).toEqual(['/srv/a', '/srv/b'])
    // capabilities always defaults to the full set (env knob removed).
    expect(config.capabilities).toEqual(['pty', 'git', 'fs', 'proc'])
  })

  it('allowedRoots defaults to [homedir()] when SUPERVISED (no env channel)', () => {
    // The supervised local computer self-derives its FS path-jail — the former
    // SLAYZONE_COMPUTER_ALLOWED_ROOTS host-injection channel is gone. shared={}
    // for a supervised computer, so this default holds untouched.
    const config = loadComputerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_SUPERVISED: '1'
    })
    expect(config.allowedRoots).toEqual([homedir()])
  })

  it('name defaults to the local-computer const when SUPERVISED (dedup pair)', () => {
    // No env name channel anymore: a supervised computer derives the shared const
    // so the hub composition can collapse it to one row.
    const config = loadComputerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_SUPERVISED: '1'
    })
    expect(config.name).toBe(DEFAULT_LOCAL_COMPUTER_NAME)
  })

  it('name defaults to the hostname when NOT supervised and no config', () => {
    const config = loadComputerConfig({ [ENV_VARS.hubAddress]: 'hub.example' })
    expect(config.name).toBe(hostname())
  })

  it('config.json computerName overrides the hostname default (standalone rename)', () => {
    const config = loadComputerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example' },
      { computerName: 'from-config' }
    )
    expect(config.name).toBe('from-config')
  })

  it('reads hubUrl/name/pinnedCertSha256 from the shared config', () => {
    // The single <ROOT>/config.json carries the pin too (the former
    // SLAYZONE_COMPUTER_CONFIG path-pointing env var is gone). Creds always derive
    // from the ROOT anchor (`<ROOT>/computers`) — no credentialsDir knob.
    const config = loadComputerConfig(
      {},
      {
        hubUrl: 'wss://from-config.example/computers',
        computerName: 'from-config',
        pinnedCertSha256: 'a'.repeat(64)
      }
    )
    expect(config.hubUrl).toBe('wss://from-config.example/computers')
    expect(config.name).toBe('from-config')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('env ADDRESS wins over the shared config full url', () => {
    const config = loadComputerConfig(
      { [ENV_VARS.hubAddress]: 'from-env.example' },
      { hubUrl: 'wss://from-config.example/computers' }
    )
    // Env authority composes wss://…/computers (non-loopback host) and beats config.json.
    expect(config.hubUrl).toBe('wss://from-env.example/computers')
  })

  it('fails with a readable error when hub address is missing', () => {
    expect(() => loadComputerConfig({})).toThrow(/SLAYZONE_HUB_ADDRESS/)
  })

  it('is self-sufficient from a join token alone (hubUrl + pin extracted)', () => {
    const token = mintToken({
      hubUrl: 'wss://hub.example:8443/computers',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadComputerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('wss://hub.example:8443/computers')
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
    expect(config.joinToken).toBe(token)
  })

  it('lets an explicit env hubUrl + config pin override the join-token values', () => {
    const token = mintToken({
      hubUrl: 'wss://from-token/computers',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    // hub address overrides via env; the pin has no env channel — config.json is
    // its explicit override path and still beats the token-decoded fingerprint.
    // A non-loopback env authority composes wss:// (matches the token's TLS).
    const config = loadComputerConfig(
      {
        [ENV_VARS.joinToken]: token,
        [ENV_VARS.hubAddress]: 'override.example'
      },
      { pinnedCertSha256: 'b'.repeat(64) }
    )
    expect(config.hubUrl).toBe('wss://override.example/computers')
    expect(config.pinnedCertSha256).toBe('b'.repeat(64))
  })

  it('ignores a malformed join token for fallback (schema still reports missing address)', () => {
    expect(() => loadComputerConfig({ [ENV_VARS.joinToken]: 'not-a-token' })).toThrow(
      /SLAYZONE_HUB_ADDRESS/
    )
  })

  it('fails fast when an EXPLICIT config.json pin is set on a ws:// hub url (no silent downgrade)', () => {
    expect(() =>
      loadComputerConfig(
        {},
        { hubUrl: 'ws://hub.example/computers', pinnedCertSha256: 'a'.repeat(64) }
      )
    ).toThrow(/requires a wss:\/\/ hub url/)
  })

  it('does NOT fail when only the join-token pin lands on a ws:// url (soft auto path)', () => {
    // A ws:// join token carries a fingerprint but the pin is NOT explicit — it is
    // softly ignored downstream (startComputer), so config assembly must not throw.
    const token = mintToken({
      hubUrl: 'ws://127.0.0.1:9000/computers',
      certFingerprint: 'a'.repeat(64),
      secret: 's'
    })
    const config = loadComputerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('ws://127.0.0.1:9000/computers')
    // The decoded pin is still present in config; startComputer drops it for ws://.
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('accepts an explicit config.json pin on a wss:// hub url', () => {
    const config = loadComputerConfig(
      { [ENV_VARS.hubAddress]: 'hub.example' },
      { pinnedCertSha256: 'a'.repeat(64) }
    )
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  // --- pin-less join tokens (the hub no longer presents a certificate) -----------
  // A token minted by the current hub carries an EMPTY certFingerprint. The computer
  // must accept it: no pin, normal CA verification of the front end's certificate.
  it('accepts a pin-less join token (empty fingerprint) — no pin, no schema failure', () => {
    const token = mintToken({
      hubUrl: 'wss://hub.example.com/computers',
      certFingerprint: '',
      secret: 's'
    })
    const config = loadComputerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('wss://hub.example.com/computers')
    expect(config.pinnedCertSha256).toBeUndefined()
    expect(config.joinToken).toBe(token)
  })

  it('accepts a pin-less join token for a loopback ws:// hub', () => {
    const token = mintToken({
      hubUrl: 'ws://127.0.0.1:51100/computers',
      certFingerprint: '',
      secret: 's'
    })
    const config = loadComputerConfig({ [ENV_VARS.joinToken]: token })
    expect(config.hubUrl).toBe('ws://127.0.0.1:51100/computers')
    expect(config.pinnedCertSha256).toBeUndefined()
  })

  it('a pinned token from an OLDER hub still carries its pin', () => {
    const token = mintToken({
      hubUrl: 'wss://old-hub.example/computers',
      certFingerprint: 'c'.repeat(64),
      secret: 's'
    })
    expect(loadComputerConfig({ [ENV_VARS.joinToken]: token }).pinnedCertSha256).toBe(
      'c'.repeat(64)
    )
  })

  // --- plaintext ws:// is for this machine only (A1) ----------------------------
  // The env channel cannot PRODUCE ws:// for a non-loopback host (hubUrlFromAddr picks
  // wss://), so the guard only catches a full ws:// url supplied via config.json /
  // a join token — drive it through the shared config.
  it('rejects a plaintext ws:// hub url (from config.json) on a non-loopback host', () => {
    expect(() => loadComputerConfig({}, { hubUrl: 'ws://hub.example/computers' })).toThrow(
      /only allowed for a hub on this machine/
    )
  })

  it('rejects a plaintext ws:// hub url from a join token on a non-loopback host', () => {
    const token = mintToken({
      hubUrl: 'ws://10.0.0.5:51100/computers',
      certFingerprint: '',
      secret: 's'
    })
    expect(() => loadComputerConfig({ [ENV_VARS.joinToken]: token })).toThrow(/wss:\/\//)
  })

  it('rejects a plaintext ws:// url in ANY hubUrls entry, not only hubUrl', () => {
    // `hubUrls` wins over `hubUrl` at dial time, so the loopback `hubUrl` here would
    // otherwise let the off-box ws:// entry through.
    expect(() =>
      loadComputerConfig(
        {},
        {
          hubUrl: 'ws://127.0.0.1:9000/computers',
          hubUrls: ['wss://hub.example/computers', 'ws://10.0.0.5:51100/computers']
        }
      )
    ).toThrow(/only allowed for a hub on this machine.*10\.0\.0\.5/)
  })

  it('allows hubUrls mixing wss:// with loopback ws://', () => {
    const config = loadComputerConfig(
      {},
      {
        hubUrl: 'wss://hub.example/computers',
        hubUrls: ['wss://hub.example/computers', 'ws://localhost:9000/computers']
      }
    )
    expect(config.hubUrls).toEqual(['wss://hub.example/computers', 'ws://localhost:9000/computers'])
  })

  it('allows ws:// on loopback hosts (127.0.0.1, localhost, ::1)', () => {
    for (const host of ['127.0.0.1:9000', 'localhost:9000', '[::1]:9000']) {
      const config = loadComputerConfig({}, { hubUrl: `ws://${host}/computers` })
      expect(config.hubUrl).toBe(`ws://${host}/computers`)
    }
  })

  it('a leftover SLAYZONE_MODE changes nothing (the mode is gone)', () => {
    const remote = loadComputerConfig({
      [ENV_VARS.hubAddress]: '127.0.0.1:9000',
      SLAYZONE_MODE: 'remote'
    })
    expect(remote.hubUrl).toBe('ws://127.0.0.1:9000/computers')
    const local = loadComputerConfig({
      [ENV_VARS.hubAddress]: 'hub.example',
      SLAYZONE_MODE: 'local'
    })
    expect(local.hubUrl).toBe('wss://hub.example/computers')
  })

  it('ADDRESS composes wss:// for a non-loopback host (never ws://)', () => {
    const config = loadComputerConfig({ [ENV_VARS.hubAddress]: 'hub.example' })
    expect(config.hubUrl).toBe('wss://hub.example/computers')
  })

  it('still composes ws:// for a loopback host (dev)', () => {
    const config = loadComputerConfig({ [ENV_VARS.hubAddress]: '127.0.0.1:9000' })
    expect(config.hubUrl).toBe('ws://127.0.0.1:9000/computers')
  })

  // --- shared <ROOT>/config.json layering (env > shared > default) ---
  it('reads hubUrl/joinToken/computerName from the shared config as a base', () => {
    const config = loadComputerConfig(
      {},
      {
        hubUrl: 'wss://shared.example/computers',
        joinToken: 'jt-shared',
        computerName: 'shared-computer'
      }
    )
    expect(config.hubUrl).toBe('wss://shared.example/computers')
    expect(config.joinToken).toBe('jt-shared')
    expect(config.name).toBe('shared-computer')
  })

  it('ENV wins over the shared config; unset keys fall through', () => {
    const config = loadComputerConfig(
      { [ENV_VARS.hubAddress]: 'from-env.example' },
      { hubUrl: 'wss://shared.example/computers', computerName: 'shared-computer' }
    )
    // Env authority composes wss://…/computers (non-loopback host) and beats config.json.
    expect(config.hubUrl).toBe('wss://from-env.example/computers')
    expect(config.name).toBe('shared-computer') // shared name survives (no env override)
  })

  it('does not read the developer real config when an explicit env is passed (hermetic)', () => {
    // Passing an `env` object other than process.env ⇒ shared defaults to {} so
    // tests never accidentally pick up ~/.slayzone/config.json.
    expect(() => loadComputerConfig({})).toThrow(/SLAYZONE_HUB_ADDRESS/)
  })

  it('SUPERVISED computer does NOT layer in the shared config (mirrors hub no-op)', () => {
    // The app-spawned local computer inherits SLAYZONE_SUPERVISED=1 via {...process.env}.
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
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ hubUrl: 'wss://shared.example/computers' })
      )
      // Supervised ⇒ shared skipped ⇒ no hub source anywhere ⇒ throws.
      expect(() => loadComputerConfig()).toThrow(/SLAYZONE_HUB_ADDRESS/)
      // Sanity: with SUPERVISED unset, the SAME shared config IS read (no throw).
      delete process.env.SLAYZONE_SUPERVISED
      expect(loadComputerConfig().hubUrl).toBe('wss://shared.example/computers')
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
  // computer (computer_id is NULL until redemption). So the value is hub-scoped, and
  // the pre-rename `SLAYZONE_RUNNER_JOIN_TOKEN` described its consumer — the one
  // thing CLAUDE.md rule 2 forbids. It is RETIRED outright, not aliased: it never
  // shipped (published computer betas 0.36.0-beta.2/3 read `SLAYZONE_JOIN_TOKEN`),
  // so no operator env anywhere carries it. Same treatment as the other unshipped
  // renames in this sweep, which were all dropped cold.
  describe('join-token env name', () => {
    it('reads the canonical SLAYZONE_HUB_JOIN_TOKEN', () => {
      const config = loadComputerConfig({
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
      // optional (an enrolled computer reconnects on stored credentials), so the old
      // name simply yields no token — first contact then fails at enrollment, not
      // with a half-honoured config.
      const config = loadComputerConfig({
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
        hubUrl: 'wss://hub.example:8443/computers',
        certFingerprint: 'a'.repeat(64),
        secret: 's'
      })
      expect(() => loadComputerConfig({ SLAYZONE_RUNNER_JOIN_TOKEN: token })).toThrow(
        /SLAYZONE_HUB_ADDRESS/
      )
    })

    it('is self-sufficient from the token alone (hubUrl + pin extracted)', () => {
      const token = mintToken({
        hubUrl: 'wss://hub.example:8443/computers',
        certFingerprint: 'a'.repeat(64),
        secret: 's'
      })
      const config = loadComputerConfig({ [ENV_VARS.joinToken]: token })
      expect(config.hubUrl).toBe('wss://hub.example:8443/computers')
      expect(config.pinnedCertSha256).toBe('a'.repeat(64))
      expect(config.joinToken).toBe(token)
    })

    it('names the canonical var in the missing-config error', () => {
      expect(() => loadComputerConfig({})).toThrow(/SLAYZONE_HUB_JOIN_TOKEN/)
    })

    it('env beats a config.json joinToken', () => {
      const fromEnv = loadComputerConfig(
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
    const outside = mkdtempSync(join(tmpdir(), 'computer-outside-'))
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

describe('effectiveHubUrls', () => {
  it('is the single hubUrl when no list is configured', () => {
    const config = loadComputerConfig(
      { SLAYZONE_HUB_ADDRESS: '127.0.0.1:8788', SLAYZONE_HUB_JOIN_TOKEN: 't' },
      {}
    )
    expect(effectiveHubUrls(config)).toEqual([config.hubUrl])
  })

  it('uses the list when set, de-duplicated', () => {
    const config = loadComputerConfig(
      { SLAYZONE_HUB_ADDRESS: '127.0.0.1:8788', SLAYZONE_HUB_JOIN_TOKEN: 't' },
      { hubUrls: ['wss://a/computers', 'wss://b/computers', 'wss://a/computers'] }
    )
    // Two dialers for one hub would race over a single credential entry.
    expect(effectiveHubUrls(config)).toEqual(['wss://a/computers', 'wss://b/computers'])
  })
})
