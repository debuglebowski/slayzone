import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeRemoteUrl,
  toHubOrigin,
  readBootConfig,
  writeBootSettings,
  probeRemoteHealth,
  hubDeviceCode,
  isHubOwnPage,
  waitForHubDeviceToken,
  resolveHubRegistry,
  resolveDefaultHubId,
  localHubEntry,
  LOCAL_HUB_ID,
  LEGACY_REMOTE_HUB_ID,
  type BootConfig
} from './boot-config'

describe('normalizeRemoteUrl', () => {
  it('canonicalizes every accepted scheme to ws(s)://host[:port]/trpc', () => {
    expect(normalizeRemoteUrl('http://example.com:4400')).toBe('ws://example.com:4400/trpc')
    expect(normalizeRemoteUrl('https://example.com')).toBe('wss://example.com/trpc')
    expect(normalizeRemoteUrl('ws://example.com:4400')).toBe('ws://example.com:4400/trpc')
    expect(normalizeRemoteUrl('wss://example.com/trpc')).toBe('wss://example.com/trpc')
  })

  it('forces the path to /trpc and strips query + hash', () => {
    expect(normalizeRemoteUrl('http://example.com:4400/some/path?windowId=3#frag')).toBe(
      'ws://example.com:4400/trpc'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRemoteUrl('  http://example.com:4400  ')).toBe('ws://example.com:4400/trpc')
  })

  it('rejects empty, scheme-less, and non-http(s)/ws(s) input', () => {
    expect(normalizeRemoteUrl('')).toBeNull()
    expect(normalizeRemoteUrl('   ')).toBeNull()
    expect(normalizeRemoteUrl('example.com:4400')).toBeNull()
    expect(normalizeRemoteUrl('ftp://example.com')).toBeNull()
    expect(normalizeRemoteUrl('not a url')).toBeNull()
  })
})

describe('toHubOrigin', () => {
  it('maps the canonical ws URL to its http(s) origin', () => {
    expect(toHubOrigin('ws://example.com:4400/trpc')).toBe('http://example.com:4400')
    expect(toHubOrigin('wss://example.com/trpc')).toBe('https://example.com')
    expect(toHubOrigin('ws://[::1]:4400/trpc')).toBe('http://[::1]:4400')
  })
})

describe('readBootConfig / writeBootSettings', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slayzone-boot-config-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to local when the file is missing', () => {
    expect(readBootConfig(dir)).toEqual({ server_mode: 'local' })
  })

  it('defaults to local when the file is corrupt JSON', () => {
    writeFileSync(join(dir, 'client.boot.json'), '{nope')
    expect(readBootConfig(dir)).toEqual({ server_mode: 'local' })
  })

  it('defaults to local when server_mode has an invalid value', () => {
    writeFileSync(join(dir, 'client.boot.json'), JSON.stringify({ server_mode: 'cloud' }))
    expect(readBootConfig(dir)).toEqual({ server_mode: 'local' })
  })

  it('round-trips a remote config and normalizes the URL on write', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'http://example.com:4400' })
    expect(readBootConfig(dir)).toEqual({
      server_mode: 'remote',
      remote_server_url: 'ws://example.com:4400/trpc'
    })
  })

  it('merges partial updates instead of clobbering', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'ws://example.com:1/trpc' })
    writeBootSettings(dir, { server_mode: 'local' })
    expect(readBootConfig(dir)).toEqual({
      server_mode: 'local',
      remote_server_url: 'ws://example.com:1/trpc'
    })
  })

  it('rejects an unnormalizable URL without touching the file', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'ws://example.com:1/trpc' })
    expect(() => writeBootSettings(dir, { remote_server_url: 'not a url' })).toThrow()
    expect(readBootConfig(dir)).toEqual({
      server_mode: 'remote',
      remote_server_url: 'ws://example.com:1/trpc'
    })
  })

  it('writes pretty-printed JSON (hand-editable pre-boot file)', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'ws://example.com:1/trpc' })
    const raw = readFileSync(join(dir, 'client.boot.json'), 'utf8')
    expect(raw).toContain('\n')
    expect(JSON.parse(raw).server_mode).toBe('remote')
  })
})

// boot-config.json → client.boot.json. This file decides whether a local hub runs at
// all and holds the user's remote-hub list, and it is read at the most fragile moment
// in boot. Every location a beta could have left it in must still be found, nothing
// may be lost on the first write, and the old file must never be touched.
describe('client.boot.json rename', () => {
  let dir: string
  let hubRoot: string
  const OLD = 'boot-config.json'
  const NEW = 'client.boot.json'
  const remote = (url: string): string =>
    JSON.stringify({ server_mode: 'remote', remote_server_url: url })

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'slayzone-boot-rename-'))
    dir = join(base, 'client')
    hubRoot = join(base, 'hub')
    mkdirSync(dir)
    mkdirSync(hubRoot)
  })
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('writes client.boot.json and never creates the old name', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'ws://a.example.com/trpc' })
    expect(existsSync(join(dir, NEW))).toBe(true)
    expect(existsSync(join(dir, OLD))).toBe(false)
  })

  it('reads the old name in the client dir (beta.14+ layout)', () => {
    writeFileSync(join(dir, OLD), remote('ws://beta.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot)).toEqual({
      server_mode: 'remote',
      remote_server_url: 'ws://beta.example.com/trpc'
    })
  })

  it('reads the old name in the hub root (pre-client-dir layout)', () => {
    writeFileSync(join(hubRoot, OLD), remote('ws://older.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot)).toEqual({
      server_mode: 'remote',
      remote_server_url: 'ws://older.example.com/trpc'
    })
  })

  it('prefers the new file, then the old file in the client dir, then the hub root', () => {
    writeFileSync(join(hubRoot, OLD), remote('ws://hubroot.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot).remote_server_url).toBe('ws://hubroot.example.com/trpc')
    writeFileSync(join(dir, OLD), remote('ws://olddir.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot).remote_server_url).toBe('ws://olddir.example.com/trpc')
    writeFileSync(join(dir, NEW), remote('ws://new.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot).remote_server_url).toBe('ws://new.example.com/trpc')
  })

  it('first write carries the old settings forward and leaves the old file byte-identical', () => {
    const oldBytes = JSON.stringify({
      server_mode: 'remote',
      remote_server_url: 'ws://beta.example.com/trpc',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }]
    })
    writeFileSync(join(dir, OLD), oldBytes)
    writeBootSettings(dir, { default_hub_id: 'fp-1' }, hubRoot)
    const after = readBootConfig(dir, hubRoot)
    expect(after.server_mode).toBe('remote')
    expect(after.multi_hub).toBe(true)
    expect(after.hubs).toHaveLength(1)
    expect(after.default_hub_id).toBe('fp-1')
    expect(JSON.parse(readFileSync(join(dir, NEW), 'utf8')).hubs).toHaveLength(1)
    expect(readFileSync(join(dir, OLD), 'utf8')).toBe(oldBytes)
  })

  it('an unreadable new file falls through to the old name instead of resetting to local', () => {
    writeFileSync(join(dir, NEW), '{nope')
    writeFileSync(join(dir, OLD), remote('ws://beta.example.com/trpc'))
    expect(readBootConfig(dir, hubRoot).server_mode).toBe('remote')
  })

  it('nothing anywhere still defaults to local', () => {
    expect(readBootConfig(dir, hubRoot)).toEqual({ server_mode: 'local' })
  })
})

describe('multi-hub boot config (Phase 0)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slayzone-boot-config-mh-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // --- byte-identical: the new fields must be absent for single-hub users ---

  it('local-only config reads back with NO multi-hub keys (byte-identical)', () => {
    writeBootSettings(dir, { server_mode: 'local' })
    const cfg = readBootConfig(dir)
    expect(cfg).toEqual({ server_mode: 'local' })
    expect(cfg.multi_hub).toBeUndefined()
    expect(cfg.hubs).toBeUndefined()
    expect(cfg.default_hub_id).toBeUndefined()
  })

  it('single-remote config reads back unchanged (no multi-hub keys)', () => {
    writeBootSettings(dir, { server_mode: 'remote', remote_server_url: 'https://hub.example.com' })
    expect(readBootConfig(dir)).toEqual({
      server_mode: 'remote',
      remote_server_url: 'wss://hub.example.com/trpc'
    })
  })

  // --- persistence of the new fields ---

  it('round-trips multi_hub: true and clears it back to absent', () => {
    writeBootSettings(dir, { multi_hub: true })
    expect(readBootConfig(dir).multi_hub).toBe(true)
    writeBootSettings(dir, { multi_hub: false })
    expect(readBootConfig(dir).multi_hub).toBeUndefined()
  })

  it('persists + normalizes remote hub entries and drops the list when empty', () => {
    writeBootSettings(dir, {
      hubs: [{ id: 'fp-abc', kind: 'remote', label: 'Prod', url: 'https://prod.example.com' }]
    })
    expect(readBootConfig(dir).hubs).toEqual([
      { id: 'fp-abc', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }
    ])
    writeBootSettings(dir, { hubs: [] })
    expect(readBootConfig(dir).hubs).toBeUndefined()
  })

  it('throws on an invalid hub entry url without persisting it', () => {
    expect(() =>
      writeBootSettings(dir, {
        hubs: [{ id: 'bad', kind: 'remote', label: 'Bad', url: 'not a url' }]
      })
    ).toThrow()
    expect(readBootConfig(dir).hubs).toBeUndefined()
  })

  it('drops malformed hub entries on read (hand-edited file)', () => {
    writeFileSync(
      join(dir, 'client.boot.json'),
      JSON.stringify({
        server_mode: 'local',
        multi_hub: true,
        hubs: [
          { id: 'ok', kind: 'remote', label: 'OK', url: 'wss://ok.example.com/trpc' },
          { id: 'no-url', kind: 'remote', label: 'NoUrl' },
          { id: 'local-not-allowed', kind: 'local', label: 'Nope' },
          'garbage'
        ]
      })
    )
    expect(readBootConfig(dir).hubs).toEqual([
      { id: 'ok', kind: 'remote', label: 'OK', url: 'wss://ok.example.com/trpc' }
    ])
  })

  it('a certificate pin an older release kept per hub is dropped, the hub kept', () => {
    // Remote hubs are verified the normal way (CA chain + hostname) — no pin is ever
    // read back, and the next write no longer carries it.
    writeFileSync(
      join(dir, 'client.boot.json'),
      JSON.stringify({
        server_mode: 'local',
        multi_hub: true,
        hubs: [
          {
            id: 'hub:wss://prod.example.com/trpc',
            kind: 'remote',
            label: 'Prod',
            url: 'wss://prod.example.com/trpc',
            fingerprint: 'ab'.repeat(32)
          }
        ]
      })
    )
    const hub = {
      id: 'hub:wss://prod.example.com/trpc',
      kind: 'remote',
      label: 'Prod',
      url: 'wss://prod.example.com/trpc'
    }
    expect(readBootConfig(dir).hubs).toEqual([hub])
    writeBootSettings(dir, { default_hub_id: hub.id })
    expect(readFileSync(join(dir, 'client.boot.json'), 'utf8')).not.toContain('fingerprint')
    expect(readBootConfig(dir).hubs).toEqual([hub])
  })

  it('round-trips default_hub_id and clears it', () => {
    writeBootSettings(dir, { default_hub_id: 'fp-abc' })
    expect(readBootConfig(dir).default_hub_id).toBe('fp-abc')
    writeBootSettings(dir, { default_hub_id: '' })
    expect(readBootConfig(dir).default_hub_id).toBeUndefined()
  })
})

describe('resolveHubRegistry (synthesis / migration)', () => {
  it('local mode, multi_hub off → exactly [local]', () => {
    const reg = resolveHubRegistry({ server_mode: 'local' })
    expect(reg).toEqual([localHubEntry()])
    expect(reg[0].id).toBe(LOCAL_HUB_ID)
  })

  it('legacy remote mode, multi_hub off → exactly [remote-legacy], NO local', () => {
    const reg = resolveHubRegistry({
      server_mode: 'remote',
      remote_server_url: 'wss://hub.example.com/trpc'
    })
    expect(reg).toEqual([
      {
        id: LEGACY_REMOTE_HUB_ID,
        kind: 'remote',
        label: 'Remote',
        url: 'wss://hub.example.com/trpc'
      }
    ])
    expect(reg.some((h) => h.kind === 'local')).toBe(false)
  })

  it('remote mode with no url falls back to [local] (nothing to connect to)', () => {
    expect(resolveHubRegistry({ server_mode: 'remote' })).toEqual([localHubEntry()])
  })

  it('multi_hub on → local is always first + present, remotes follow', () => {
    const reg = resolveHubRegistry({
      server_mode: 'local',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }]
    })
    expect(reg[0]).toEqual(localHubEntry())
    expect(reg.map((h) => h.id)).toEqual([LOCAL_HUB_ID, 'fp-1'])
  })

  it('multi_hub on folds a not-yet-migrated remote_server_url into the list once', () => {
    // server_mode 'local' → local is present; the stray remote_server_url folds in.
    const cfg: BootConfig = {
      server_mode: 'local',
      remote_server_url: 'wss://old.example.com/trpc',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }]
    }
    const reg = resolveHubRegistry(cfg)
    expect(reg.map((h) => h.id)).toEqual([LOCAL_HUB_ID, 'fp-1', LEGACY_REMOTE_HUB_ID])
    // Idempotent: an already-migrated remote (same url) is not duplicated.
    const cfg2: BootConfig = {
      server_mode: 'local',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }],
      remote_server_url: 'wss://prod.example.com/trpc'
    }
    expect(resolveHubRegistry(cfg2).map((h) => h.id)).toEqual([LOCAL_HUB_ID, 'fp-1'])
  })

  it('multi_hub on + server_mode remote → NO local (pure client, "run local hub" off)', () => {
    const reg = resolveHubRegistry({
      server_mode: 'remote',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }]
    })
    expect(reg.map((h) => h.id)).toEqual(['fp-1'])
    expect(reg.some((h) => h.kind === 'local')).toBe(false)
  })

  it('server_mode remote but NO remotes → keeps local (never an empty registry)', () => {
    const reg = resolveHubRegistry({ server_mode: 'remote', multi_hub: true })
    expect(reg).toEqual([localHubEntry()])
  })
})

describe('resolveDefaultHubId', () => {
  it('honors an explicit default_hub_id present in the registry', () => {
    const cfg: BootConfig = {
      server_mode: 'local',
      multi_hub: true,
      hubs: [{ id: 'fp-1', kind: 'remote', label: 'Prod', url: 'wss://prod.example.com/trpc' }],
      default_hub_id: 'fp-1'
    }
    expect(resolveDefaultHubId(cfg)).toBe('fp-1')
  })

  it('falls back to the first registry entry when default_hub_id is absent or stale', () => {
    expect(resolveDefaultHubId({ server_mode: 'local' })).toBe(LOCAL_HUB_ID)
    expect(
      resolveDefaultHubId({ server_mode: 'local', multi_hub: true, default_hub_id: 'ghost' })
    ).toBe(LOCAL_HUB_ID)
  })

  it('legacy remote mode defaults to the sole remote hub', () => {
    expect(
      resolveDefaultHubId({
        server_mode: 'remote',
        remote_server_url: 'wss://hub.example.com/trpc'
      })
    ).toBe(LEGACY_REMOTE_HUB_ID)
  })
})

describe('probeRemoteHealth', () => {
  let server: http.Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  const listen = (handler: http.RequestListener): Promise<number> => {
    server = http.createServer(handler)
    return new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as AddressInfo).port)
      })
    })
  }

  it('rejects plaintext for a non-loopback host before any request (hub scheme rule)', async () => {
    // Loopback → ws, anything else → wss (hubUrlFromAddr). A plaintext remote
    // could never connect — the renderer CSP floor is TLS-only off-loopback —
    // so the add flow fails here with a clear reason instead of later, silently.
    for (const raw of ['ws://192.168.1.20:4400', 'http://hub.example.com']) {
      const result = await probeRemoteHealth(raw)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.error).toMatch(/wss:\/\//)
    }
  })

  it('still probes plaintext loopback hubs (127.0.0.1 and localhost)', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    expect((await probeRemoteHealth(`ws://127.0.0.1:${port}`)).ok).toBe(true)
    expect((await probeRemoteHealth(`ws://localhost:${port}`)).ok).toBe(true)
  })

  it('reports ok + the normalized ws URL when /health answers 200 {ok:true}', async () => {
    const port = await listen((req, res) => {
      expect(req.url).toBe('/health')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, port, dbPath: '/x', uptimeMs: 1 }))
    })
    const result = await probeRemoteHealth(`http://127.0.0.1:${port}`)
    expect(result).toEqual({ ok: true, normalizedUrl: `ws://127.0.0.1:${port}/trpc` })
  })

  it('reports the HTTP status when /health answers non-200', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, reason: 'starting' }))
    })
    const result = await probeRemoteHealth(`http://127.0.0.1:${port}`)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('503')
  })

  it('reports connection errors for an unreachable host', async () => {
    // Bind + close to get a port that is guaranteed dead right now.
    const port = await listen(() => {})
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    const result = await probeRemoteHealth(`http://127.0.0.1:${port}`)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('reports how the hub signs people in from its switches', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          authRequired: true,
          switches: { enableSso: true, enablePassword: false }
        })
      )
    })
    const result = await probeRemoteHealth(`http://127.0.0.1:${port}`)
    expect(result.signIn).toEqual({ sso: true, password: false })
  })

  it('rejects invalid URLs without attempting a request', async () => {
    const result = await probeRemoteHealth('not a url')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid/i)
  })

  it('times out a wedged server', async () => {
    const port = await listen(() => {
      /* never respond */
    })
    const result = await probeRemoteHealth(`http://127.0.0.1:${port}`, 200)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  })
})

/**
 * Device sign-in against an Entra hub (T-14), against a stub of the hub's two routes:
 * the code request names the desktop client, the poll honours `slow_down`, and each
 * end state (token, denied, expired) comes back as what the dialog shows. Plain
 * `http.request`, so no Fetch Metadata reaches the hub (MISSING_OR_NULL_ORIGIN).
 */
describe('device sign-in (hubDeviceCode / waitForHubDeviceToken)', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  /** Stub hub: answers `/device/code`, then each `/device/token` poll from `polls`. */
  const stubHub = (polls: Array<[number, Record<string, unknown>]>) => {
    const seen: Array<{
      url: string
      body: Record<string, unknown>
      headers: http.IncomingHttpHeaders
    }> = []
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        seen.push({ url: req.url ?? '', body, headers: req.headers })
        const [status, reply] =
          req.url === '/api/auth/device/code'
            ? [
                200,
                {
                  device_code: 'dev-code',
                  user_code: 'ABCDEFGH',
                  verification_uri: `http://${req.headers.host}/device`,
                  verification_uri_complete: `http://${req.headers.host}/device?user_code=ABCDEFGH`,
                  expires_in: 600,
                  interval: 5
                }
              ]
            : (polls.shift() ?? [400, { error: 'expired_token' }])
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      })
    })
    return new Promise<{ url: string; seen: typeof seen }>((resolve) =>
      server!.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen })
      )
    )
  }

  const sleeps: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms)
  }

  beforeEach(() => {
    sleeps.length = 0
  })

  it('asks for a code as the desktop client, with no Fetch Metadata', async () => {
    const hub = await stubHub([])
    const code = await hubDeviceCode(hub.url)
    expect(code).toMatchObject({
      ok: true,
      deviceCode: 'dev-code',
      userCode: 'ABCD-EFGH',
      intervalSec: 5
    })
    expect(hub.seen[0]!.body).toEqual({ client_id: 'slayzone-desktop' })
    expect(hub.seen[0]!.headers['sec-fetch-mode']).toBeUndefined()
    expect(hub.seen[0]!.headers.origin).toBeUndefined()
  })

  it('polls through pending and slow_down to the token', async () => {
    const hub = await stubHub([
      [400, { error: 'authorization_pending' }],
      [400, { error: 'slow_down' }],
      [200, { access_token: 'bearer-1', token_type: 'Bearer' }]
    ])
    const result = await waitForHubDeviceToken(
      hub.url,
      { deviceCode: 'dev-code', expiresInSec: 600, intervalSec: 5 },
      { sleep }
    )
    expect(result).toEqual({ ok: true, token: 'bearer-1' })
    expect(sleeps).toEqual([5000, 5000, 10000])
    expect(hub.seen.map((s) => s.body.device_code)).toEqual(['dev-code', 'dev-code', 'dev-code'])
  })

  it('denied and expired end the wait with a clean error', async () => {
    const denied = await stubHub([[400, { error: 'access_denied' }]])
    expect(
      await waitForHubDeviceToken(
        denied.url,
        { deviceCode: 'd', expiresInSec: 600, intervalSec: 5 },
        { sleep }
      )
    ).toEqual({ ok: false, error: 'Sign-in was denied in the browser' })
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    const expired = await stubHub([[400, { error: 'expired_token' }]])
    expect(
      await waitForHubDeviceToken(
        expired.url,
        { deviceCode: 'd', expiresInSec: 600, intervalSec: 5 },
        { sleep }
      )
    ).toEqual({ ok: false, error: 'The sign-in code expired' })
  })

  it('stops when cancelled', async () => {
    const hub = await stubHub([[400, { error: 'authorization_pending' }]])
    const abort = new AbortController()
    abort.abort()
    const result = await waitForHubDeviceToken(
      hub.url,
      { deviceCode: 'd', expiresInSec: 600, intervalSec: 5 },
      { sleep, signal: abort.signal }
    )
    expect(result).toEqual({ ok: false, error: 'Sign-in cancelled' })
  })

  it("opens only the hub's own page in the browser", () => {
    expect(
      isHubOwnPage('https://hub.example.com', 'https://hub.example.com/device?user_code=X')
    ).toBe(true)
    expect(isHubOwnPage('wss://hub.example.com/trpc', 'https://hub.example.com/device')).toBe(true)
    expect(isHubOwnPage('https://hub.example.com', 'https://evil.example/device')).toBe(false)
    expect(isHubOwnPage('https://hub.example.com', 'javascript:alert(1)')).toBe(false)
  })
})
