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
  probeRemoteHealth
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
