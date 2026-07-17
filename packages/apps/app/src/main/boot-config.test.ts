import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeRemoteUrl,
  toHealthUrl,
  readBootConfig,
  writeBootSettings,
  probeRemoteHealth,
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

describe('toHealthUrl', () => {
  it('maps the canonical ws URL to its http /health endpoint', () => {
    expect(toHealthUrl('ws://example.com:4400/trpc')).toBe('http://example.com:4400/health')
    expect(toHealthUrl('wss://example.com/trpc')).toBe('https://example.com/health')
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
    writeFileSync(join(dir, 'boot-config.json'), '{nope')
    expect(readBootConfig(dir)).toEqual({ server_mode: 'local' })
  })

  it('defaults to local when server_mode has an invalid value', () => {
    writeFileSync(join(dir, 'boot-config.json'), JSON.stringify({ server_mode: 'cloud' }))
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
    const raw = readFileSync(join(dir, 'boot-config.json'), 'utf8')
    expect(raw).toContain('\n')
    expect(JSON.parse(raw).server_mode).toBe('remote')
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
      join(dir, 'boot-config.json'),
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
      { id: LEGACY_REMOTE_HUB_ID, kind: 'remote', label: 'Remote', url: 'wss://hub.example.com/trpc' }
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
      resolveDefaultHubId({ server_mode: 'remote', remote_server_url: 'wss://hub.example.com/trpc' })
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
