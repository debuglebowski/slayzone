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
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
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
            url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux64/chrome-headless-shell-linux64.zip'
          },
          {
            platform: 'mac-arm64',
            url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/mac-arm64/chrome-headless-shell-mac-arm64.zip'
          },
          {
            platform: 'win64',
            url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/win64/chrome-headless-shell-win64.zip'
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
      url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/mac-arm64/chrome-headless-shell-mac-arm64.zip'
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

// Review 6, #6: the zip is downloaded and executed with no hash to check it against,
// so where it comes from is the only check. The real list names one place only.
describe('selectHeadlessShellDownload: the download host is pinned', () => {
  const listNaming = (url: string) => ({
    channels: {
      Stable: {
        version: '1.2.3.4',
        downloads: { 'chrome-headless-shell': [{ platform: 'mac-arm64', url }] }
      }
    }
  })

  test('the Chrome for Testing bucket on storage.googleapis.com is accepted', () => {
    const url =
      'https://storage.googleapis.com/chrome-for-testing-public/1.2.3.4/mac-arm64/chrome-headless-shell-mac-arm64.zip'
    expect(selectHeadlessShellDownload(listNaming(url), 'mac-arm64')?.url).toBe(url)
  })

  test.each([
    ['another host', 'https://evil.example/chrome-headless-shell-mac-arm64.zip'],
    [
      'a lookalike host',
      'https://storage.googleapis.com.evil.example/chrome-for-testing-public/x.zip'
    ],
    [
      'credentials in the URL',
      'https://storage.googleapis.com@evil.example/chrome-for-testing-public/x.zip'
    ],
    ['a non-default port', 'https://storage.googleapis.com:8443/chrome-for-testing-public/x.zip'],
    [
      'another bucket on the same host',
      'https://storage.googleapis.com/someone-elses-bucket/x.zip'
    ],
    [
      'a path climbing out of the bucket',
      'https://storage.googleapis.com/chrome-for-testing-public/../evil/x.zip'
    ],
    [
      'an encoded climb',
      'https://storage.googleapis.com/chrome-for-testing-public/%2e%2e/evil/x.zip'
    ],
    ['not a URL', 'chrome-headless-shell.zip']
  ])('%s is refused', (_what, url) => {
    expect(() => selectHeadlessShellDownload(listNaming(url), 'mac-arm64')).toThrow(
      BrowserInstallError
    )
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

// Review 2, L4: an interrupted install must not leave 100–300 MB in the cache for good.
describe('interrupted installs', () => {
  const cacheRoot = (home: string) => path.join(home, '.cache/slayzone/chrome-headless-shell')
  const zipWithShell = () =>
    makeZip([
      {
        name: 'chrome-headless-shell-linux64/chrome-headless-shell',
        data: Buffer.from('#!/bin/sh\n'),
        mode: 0o755
      }
    ])

  test("the next install sweeps an earlier run's leftovers (but not a live one's)", async () => {
    const home = path.join(tmp, 'home-sweep')
    const root = cacheRoot(home)
    fs.mkdirSync(root, { recursive: true })
    const stale = ['.install-dead', '.download-dead.zip', '157.0.8103.38.partial-dead']
    for (const n of stale) {
      const p = path.join(root, n)
      if (n.endsWith('.zip')) fs.writeFileSync(p, 'x'.repeat(1000))
      else fs.mkdirSync(path.join(p, 'deep'), { recursive: true })
      const old = new Date(Date.now() - 2 * 3600_000)
      fs.utimesSync(p, old, old)
    }
    fs.mkdirSync(path.join(root, '.install-live'))
    await installHeadlessShell({
      ctx: realCtx(home),
      fetchImpl: fakeFetch(zipWithShell(), []),
      log: () => {}
    })
    expect(fs.readdirSync(root).sort()).toEqual(['.install-live', '157.0.8103.38'])
  })

  test.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)(
    '%s mid-download removes the work dir and still ends the process',
    async (signal) => {
      const home = fs.mkdtempSync(path.join(tmp, `sig-${signal}-`))
      const driver = path.join(home, 'driver.mts')
      const mod = path.resolve(__dirname, 'browser-install.ts')
      fs.writeFileSync(
        driver,
        `import fs from 'node:fs'
import { installHeadlessShell } from ${JSON.stringify(mod)}
const sample = ${JSON.stringify(SAMPLE)}
const fetchImpl = async (input) => {
  if (String(input).endsWith('.json')) return new Response(JSON.stringify(sample))
  // A download that sends a first piece, then stalls: the install is mid-download.
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(64 * 1024)); console.log('downloading') }
  }))
}
// A real stalled download holds a socket open; without a handle the process would
// exit by itself (unsettled top-level await) before the signal arrives.
setInterval(() => {}, 1 << 30)
const ctx = {
  platform: 'linux', arch: 'x64', env: { PATH: '' }, homedir: ${JSON.stringify(home)},
  isExecutable: () => false,
  listDir: (p) => { try { return fs.readdirSync(p) } catch { return [] } }
}
await installHeadlessShell({ ctx, fetchImpl, log: () => {} })
`
      )
      const { spawn } = await import('node:child_process')
      const child = spawn('node', ['--import', 'tsx', driver], {
        cwd: path.resolve(__dirname, '../../../../..'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d
      })
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (d) => String(d).includes('downloading') && resolve())
        child.once('exit', () => reject(new Error(`driver exited early: ${stderr}`)))
      })
      // The work dir exists while it downloads.
      await expect
        .poll(() => fs.readdirSync(cacheRoot(home)).filter((n) => n.startsWith('.install-')))
        .toHaveLength(1)
      const ended = new Promise<NodeJS.Signals | null>((r) =>
        child.once('exit', (_c, sig) => r(sig))
      )
      child.kill(signal)
      expect(await ended).toBe(signal)
      expect(fs.readdirSync(cacheRoot(home))).toEqual([])
    },
    30_000
  )
})

// Review 4, C4: two installs at once (parallel agents) never delete each other's
// finished version: the one that finds it already in place keeps it.
test('a concurrent install that finished first is kept, not replaced', async () => {
  const home = path.join(tmp, 'home-race')
  const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
  const theirs = path.join(
    root,
    '157.0.8103.38/chrome-headless-shell-linux64/chrome-headless-shell'
  )
  const zip = makeZip([
    {
      name: 'chrome-headless-shell-linux64/chrome-headless-shell',
      data: Buffer.from('#!/bin/sh\n# ours\n'),
      mode: 0o755
    }
  ])
  const racing = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('.json')) return new Response(JSON.stringify(SAMPLE))
    // While this download runs, the other install finishes the same version.
    fs.mkdirSync(path.dirname(theirs), { recursive: true })
    fs.writeFileSync(theirs, '#!/bin/sh\n# theirs\n', { mode: 0o755 })
    return new Response(new Uint8Array(zip))
  }) as typeof fetch
  const bin = await installHeadlessShell({ ctx: realCtx(home), fetchImpl: racing, log: () => {} })
  expect(bin).toBe(theirs)
  expect(fs.readFileSync(theirs, 'utf8')).toContain('# theirs')
  expect(fs.readdirSync(root)).toEqual(['157.0.8103.38'])
})

// Review 5, #13: concurrent `--install-browser` runs (parallel agents, separate
// processes). The commit must be atomic: a working install already in place — or one
// landing between our check and our rename — is kept, never deleted.
describe('concurrent installs (review 5, #13)', () => {
  afterEach(() => vi.restoreAllMocks())
  const VERSION_DIR = '157.0.8103.38'
  const BIN_REL = 'chrome-headless-shell-linux64/chrome-headless-shell'
  const zipWithShell = (tag: string) =>
    makeZip([{ name: BIN_REL, data: Buffer.from(`#!/bin/sh\n# ${tag}\n`), mode: 0o755 }])
  const plainFetch = (zip: Buffer): typeof fetch =>
    (async (input: string | URL | Request) =>
      String(input).endsWith('.json')
        ? new Response(JSON.stringify(SAMPLE))
        : new Response(new Uint8Array(zip))) as typeof fetch

  test('another install landing after the download is kept (never deleted, no ENOTEMPTY)', async () => {
    const home = path.join(tmp, 'home-race2')
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    const finalDir = path.join(root, VERSION_DIR)
    const theirs = path.join(finalDir, BIN_REL)
    let downloaded = false
    let landed = false
    // The other process finishes the moment ours is about to commit: right after any
    // existence check we make, or right before our rename — whichever comes first.
    const land = (): void => {
      if (!downloaded || landed) return
      landed = true
      fs.mkdirSync(path.dirname(theirs), { recursive: true })
      fs.writeFileSync(theirs, '#!/bin/sh\n# theirs\n', { mode: 0o755 })
    }
    const base = realCtx(home)
    const ctx: BrowserEnv = {
      ...base,
      isExecutable: (p) => {
        const answer = base.isExecutable(p)
        if (p === theirs) land()
        return answer
      }
    }
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === finalDir) land()
      return realRename(from, to)
    })
    const zip = zipWithShell('ours')
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return new Response(JSON.stringify(SAMPLE))
      downloaded = true
      return new Response(new Uint8Array(zip))
    }) as typeof fetch
    const bin = await installHeadlessShell({ ctx, fetchImpl, log: () => {} })
    expect(landed).toBe(true)
    expect(bin).toBe(theirs)
    expect(fs.readFileSync(theirs, 'utf8')).toContain('# theirs')
    expect(fs.readdirSync(root)).toEqual([VERSION_DIR])
  })

  test('a leftover version dir with no working executable is replaced', async () => {
    const home = path.join(tmp, 'home-broken')
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    fs.mkdirSync(path.join(root, VERSION_DIR, 'junk'), { recursive: true })
    fs.writeFileSync(path.join(root, VERSION_DIR, 'junk', 'x'), 'x')
    const bin = await installHeadlessShell({
      ctx: realCtx(home),
      fetchImpl: plainFetch(zipWithShell('ours')),
      log: () => {}
    })
    expect(fs.readFileSync(bin, 'utf8')).toContain('# ours')
    expect(fs.existsSync(path.join(root, VERSION_DIR, 'junk'))).toBe(false)
    expect(fs.readdirSync(root)).toEqual([VERSION_DIR])
  })

  test('a version list naming another host is refused before any download', async () => {
    const home = path.join(tmp, 'home-foreign-host')
    const seen: string[] = []
    const foreign = JSON.parse(
      JSON.stringify(SAMPLE).replaceAll(
        'https://storage.googleapis.com/',
        'https://mirror.example/'
      )
    )
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('.json')) return new Response(JSON.stringify(foreign))
      return new Response(new Uint8Array(zipWithShell('foreign')))
    }) as typeof fetch
    const err = await installHeadlessShell({ ctx: realCtx(home), fetchImpl, log: () => {} }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(BrowserInstallError)
    expect(String((err as Error).message)).toContain('https://mirror.example/')
    // Only the version list was fetched.
    expect(seen).toEqual([
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
    ])
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })

  test('a redirect to plain http is refused', async () => {
    const home = path.join(tmp, 'home-redirect')
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return new Response(JSON.stringify(SAMPLE))
      const res = new Response(new Uint8Array(zipWithShell('mitm')))
      // What fetch reports after following a redirect: the final URL.
      Object.defineProperty(res, 'url', { value: 'http://mirror.example/shell.zip' })
      return res
    }) as typeof fetch
    const err = await installHeadlessShell({ ctx: realCtx(home), fetchImpl, log: () => {} }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(BrowserInstallError)
    expect(String((err as Error).message)).toMatch(/https/)
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })

  test('a download larger than the cap is refused while streaming', async () => {
    const home = path.join(tmp, 'home-big')
    let sent = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('.json')) return new Response(JSON.stringify(SAMPLE))
      // Endless body, no Content-Length: only counting while streaming can stop it.
      return new Response(
        new ReadableStream({
          pull(c) {
            sent += 64 * 1024
            c.enqueue(new Uint8Array(64 * 1024))
          }
        })
      )
    }) as typeof fetch
    const err = await installHeadlessShell({
      ctx: realCtx(home),
      fetchImpl,
      log: () => {},
      maxDownloadBytes: 1024 * 1024
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserInstallError)
    expect(String((err as Error).message)).toMatch(/larger than/)
    expect(sent).toBeLessThan(8 * 1024 * 1024)
    const root = path.join(home, '.cache/slayzone/chrome-headless-shell')
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  }, 30_000)
})
