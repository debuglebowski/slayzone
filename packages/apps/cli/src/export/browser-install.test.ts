/**
 * `--install-browser`: Chrome for Testing's chrome-headless-shell, picked from the CfT
 * "last known good versions" JSON for this OS/arch, downloaded and unpacked into the
 * per-user cache. The JSON → URL choice is pure; the install itself runs against a
 * fake `fetch` serving a real zip, so no network is touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, test } from 'vitest'
import {
  BrowserInstallError,
  cftPlatformFor,
  installHeadlessShell,
  selectHeadlessShellDownload
} from './browser-install'
import { findCachedHeadlessShell, type BrowserEnv } from './browser'

const SAMPLE = {
  timestamp: '2026-11-04T12:18:26.781Z',
  channels: {
    Beta: { channel: 'Beta', version: '158.0.1.1', revision: '1', downloads: {} },
    Stable: {
      channel: 'Stable',
      version: '157.0.8103.38',
      revision: '1717349',
      downloads: {
        chrome: [{ platform: 'mac-arm64', url: 'https://example.invalid/chrome-mac-arm64.zip' }],
        'chrome-headless-shell': [
          {
            platform: 'linux64',
            url: 'https://storage.googleapis.com/cft/157.0.8103.38/linux64/chrome-headless-shell-linux64.zip'
          },
          {
            platform: 'mac-arm64',
            url: 'https://storage.googleapis.com/cft/157.0.8103.38/mac-arm64/chrome-headless-shell-mac-arm64.zip'
          },
          {
            platform: 'win64',
            url: 'https://storage.googleapis.com/cft/157.0.8103.38/win64/chrome-headless-shell-win64.zip'
          }
        ]
      }
    }
  }
}

describe('cftPlatformFor', () => {
  test.each([
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['linux', 'x64', 'linux64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['win32', 'x64', 'win64'],
    ['win32', 'ia32', 'win32'],
    ['win32', 'arm64', 'win64']
  ] as const)('%s/%s → %s', (platform, arch, expected) => {
    expect(cftPlatformFor(platform, arch)).toBe(expected)
  })

  test('unsupported OS/arch → null', () => {
    expect(cftPlatformFor('freebsd', 'x64')).toBeNull()
    expect(cftPlatformFor('linux', 'ppc64')).toBeNull()
  })
})

describe('selectHeadlessShellDownload', () => {
  test('the Stable channel headless-shell build for the platform', () => {
    expect(selectHeadlessShellDownload(SAMPLE, 'mac-arm64')).toEqual({
      version: '157.0.8103.38',
      url: 'https://storage.googleapis.com/cft/157.0.8103.38/mac-arm64/chrome-headless-shell-mac-arm64.zip'
    })
  })

  test('null when Stable has no headless-shell build for the platform', () => {
    expect(selectHeadlessShellDownload(SAMPLE, 'linux-arm64')).toBeNull()
  })

  test('a malformed document is refused, not guessed at', () => {
    expect(() => selectHeadlessShellDownload({}, 'mac-arm64')).toThrow(BrowserInstallError)
    expect(() =>
      selectHeadlessShellDownload(
        {
          channels: {
            Stable: {
              version: '../../etc',
              downloads: { 'chrome-headless-shell': [{ platform: 'mac-arm64', url: 'x' }] }
            }
          }
        },
        'mac-arm64'
      )
    ).toThrow(BrowserInstallError)
    expect(() =>
      selectHeadlessShellDownload(
        {
          channels: {
            Stable: {
              version: '1.2.3.4',
              downloads: {
                'chrome-headless-shell': [
                  { platform: 'mac-arm64', url: 'http://plain.example/x.zip' }
                ]
              }
            }
          }
        },
        'mac-arm64'
      )
    ).toThrow(/https/)
  })
})

// --- install, end to end against a fake fetch ---

/** A minimal stored-entry zip writer (the format the extractor reads), for the fake download. */
function makeZip(entries: Array<{ name: string; data: Buffer; mode: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const crc = zlib.crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE((3 << 8) | 20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cft-install-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function realCtx(home: string): BrowserEnv {
  return {
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '' },
    homedir: home,
    isExecutable: (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p)
      } catch {
        return []
      }
    }
  }
}

function fakeFetch(zip: Buffer, seen: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    if (url.endsWith('.json')) return new Response(JSON.stringify(SAMPLE))
    if (url.endsWith('chrome-headless-shell-linux64.zip')) return new Response(new Uint8Array(zip))
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}

describe('installHeadlessShell', () => {
  test('downloads, unpacks into <cache>/<version>, marks the binary executable', async () => {
    const home = path.join(tmp, 'home1')
    const zip = makeZip([
      // mode 0o644 on purpose: the installer chmods the binary itself.
      {
        name: 'chrome-headless-shell-linux64/chrome-headless-shell',
        data: Buffer.from('#!/bin/sh\n'),
        mode: 0o644
      },
      { name: 'chrome-headless-shell-linux64/icudtl.dat', data: Buffer.from('icu'), mode: 0o644 }
    ])
    const seen: string[] = []
    const logs: string[] = []
    const ctx = realCtx(home)
    const bin = await installHeadlessShell({
      ctx,
      fetchImpl: fakeFetch(zip, seen),
      log: (l) => logs.push(l)
    })
    expect(bin).toBe(
      path.join(
        home,
        '.cache/slayzone/chrome-headless-shell/157.0.8103.38/chrome-headless-shell-linux64/chrome-headless-shell'
      )
    )
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0)
    expect(seen[0]).toBe(
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
    )
    // Discovery step (d) now finds it — no flag needed next time.
    expect(findCachedHeadlessShell(ctx)).toBe(bin)
    // No partial/temp leftovers beside the version dir.
    expect(fs.readdirSync(path.dirname(path.dirname(path.dirname(bin))))).toEqual(['157.0.8103.38'])
    expect(logs.join('\n')).toContain('157.0.8103.38')
  })

  test('already installed → no download', async () => {
    const home = path.join(tmp, 'home1')
    const seen: string[] = []
    const bin = await installHeadlessShell({
      ctx: realCtx(home),
      fetchImpl: fakeFetch(Buffer.alloc(0), seen),
      log: () => {}
    })
    expect(fs.existsSync(bin)).toBe(true)
    expect(seen.filter((u) => u.endsWith('.zip'))).toEqual([])
  })

  test('platform with no build → error that names the alternatives', async () => {
    const ctx = { ...realCtx(path.join(tmp, 'home2')), arch: 'arm64' }
    const err = await installHeadlessShell({
      ctx,
      fetchImpl: fakeFetch(Buffer.alloc(0), []),
      log: () => {}
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserInstallError)
    expect(String((err as Error).message)).toMatch(/linux-arm64/)
    expect(String((err as Error).message)).toMatch(/package manager/)
    expect(String((err as Error).message)).toMatch(/--browser/)
  })

  test('a zip without the expected binary fails and leaves nothing behind', async () => {
    const home = path.join(tmp, 'home3')
    const zip = makeZip([{ name: 'other/thing', data: Buffer.from('x'), mode: 0o644 }])
    const err = await installHeadlessShell({
      ctx: realCtx(home),
      fetchImpl: fakeFetch(zip, []),
      log: () => {}
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserInstallError)
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })

  test('HTTP failure surfaces the status', async () => {
    const failing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    const err = await installHeadlessShell({
      ctx: realCtx(path.join(tmp, 'home4')),
      fetchImpl: failing,
      log: () => {}
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserInstallError)
    expect(String((err as Error).message)).toContain('503')
  })
})
