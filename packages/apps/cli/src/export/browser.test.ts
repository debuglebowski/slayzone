/**
 * Browser discovery for `slay tasks artifacts download --type pdf|png`: which local
 * Chrome-family executable renders the export. Pure — platform, env, home and the
 * filesystem probes are injected, so every OS's search order is pinned from any OS.
 */
import { describe, expect, test } from 'vitest'
import {
  type BrowserEnv,
  findBrowser,
  findCachedHeadlessShell,
  headlessShellCacheRoot,
  systemBrowserCandidates
} from './browser'

function ctx(over: Partial<BrowserEnv> & { files?: string[]; dirs?: Record<string, string[]> }) {
  const files = new Set(over.files ?? [])
  const dirs = over.dirs ?? {}
  const base: BrowserEnv = {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    homedir: '/Users/me',
    isExecutable: (p) => files.has(p),
    listDir: (p) => dirs[p] ?? []
  }
  return { ...base, ...over }
}

describe('systemBrowserCandidates', () => {
  test('macOS: Chrome, Chromium, Edge, Brave in /Applications then ~/Applications', () => {
    const c = systemBrowserCandidates(ctx({}))
    expect(c[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(c).toContain('/Applications/Chromium.app/Contents/MacOS/Chromium')
    expect(c).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    expect(c).toContain('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
    expect(c).toContain('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  test('Linux: every PATH dir × the known executable names, in PATH order', () => {
    const c = systemBrowserCandidates(
      ctx({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' } })
    )
    expect(c.slice(0, 2)).toEqual([
      '/usr/local/bin/google-chrome-stable',
      '/usr/local/bin/google-chrome'
    ])
    for (const name of [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
      'brave-browser'
    ]) {
      expect(c).toContain(`/usr/bin/${name}`)
    }
  })

  test('Windows: Program Files, Program Files (x86) and LocalAppData installs', () => {
    const c = systemBrowserCandidates(
      ctx({
        platform: 'win32',
        arch: 'x64',
        homedir: 'C:\\Users\\me',
        env: {
          ProgramFiles: 'C:\\Program Files',
          'ProgramFiles(x86)': 'C:\\Program Files (x86)',
          LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
        }
      })
    )
    expect(c[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(c).toContain('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(c).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    expect(c).toContain('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')
  })

  test('Windows without the env vars falls back to the default install roots', () => {
    const c = systemBrowserCandidates(ctx({ platform: 'win32', homedir: 'C:\\Users\\me' }))
    expect(c[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(c).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  })
})

describe('headlessShellCacheRoot', () => {
  test('macOS: ~/Library/Caches', () => {
    expect(headlessShellCacheRoot(ctx({}))).toBe(
      '/Users/me/Library/Caches/slayzone/chrome-headless-shell'
    )
  })
  test('Linux: XDG_CACHE_HOME, else ~/.cache', () => {
    expect(headlessShellCacheRoot(ctx({ platform: 'linux', homedir: '/home/me', env: {} }))).toBe(
      '/home/me/.cache/slayzone/chrome-headless-shell'
    )
    expect(
      headlessShellCacheRoot(
        ctx({ platform: 'linux', homedir: '/home/me', env: { XDG_CACHE_HOME: '/x/cache' } })
      )
    ).toBe('/x/cache/slayzone/chrome-headless-shell')
  })
  test('Windows: %LOCALAPPDATA%, else ~\\AppData\\Local', () => {
    expect(
      headlessShellCacheRoot(
        ctx({ platform: 'win32', homedir: 'C:\\Users\\me', env: { LOCALAPPDATA: 'D:\\L' } })
      )
    ).toBe('D:\\L\\slayzone\\chrome-headless-shell')
    expect(headlessShellCacheRoot(ctx({ platform: 'win32', homedir: 'C:\\Users\\me' }))).toBe(
      'C:\\Users\\me\\AppData\\Local\\slayzone\\chrome-headless-shell'
    )
  })
})

describe('findCachedHeadlessShell', () => {
  const root = '/Users/me/Library/Caches/slayzone/chrome-headless-shell'
  const bin = (v: string) => `${root}/${v}/chrome-headless-shell-mac-arm64/chrome-headless-shell`

  test('picks the highest installed version (numeric, not lexical)', () => {
    const c = ctx({
      dirs: { [root]: ['9.0.1.2', '157.0.8103.38', '100.0.1.1'] },
      files: [bin('9.0.1.2'), bin('157.0.8103.38'), bin('100.0.1.1')]
    })
    expect(findCachedHeadlessShell(c)).toBe(bin('157.0.8103.38'))
  })

  test('skips half-installed dirs (no binary) and temp dirs', () => {
    const c = ctx({
      dirs: { [root]: ['157.0.8103.38', '158.0.1.1.partial-abc', '120.0.1.1'] },
      files: [bin('120.0.1.1'), bin('158.0.1.1.partial-abc')]
    })
    expect(findCachedHeadlessShell(c)).toBe(bin('120.0.1.1'))
  })

  test('null when nothing is cached or the platform has no build', () => {
    expect(findCachedHeadlessShell(ctx({}))).toBeNull()
    expect(findCachedHeadlessShell(ctx({ platform: 'freebsd' }))).toBeNull()
  })

  test('Windows binary is chrome-headless-shell.exe under the win64 dir', () => {
    const wroot = 'D:\\L\\slayzone\\chrome-headless-shell'
    const wbin = `${wroot}\\157.0.8103.38\\chrome-headless-shell-win64\\chrome-headless-shell.exe`
    const c = ctx({
      platform: 'win32',
      arch: 'x64',
      env: { LOCALAPPDATA: 'D:\\L' },
      dirs: { [wroot]: ['157.0.8103.38'] },
      files: [wbin]
    })
    expect(findCachedHeadlessShell(c)).toBe(wbin)
  })
})

describe('findBrowser', () => {
  test('a system browser wins over the cached headless shell', () => {
    const root = '/Users/me/Library/Caches/slayzone/chrome-headless-shell'
    const cached = `${root}/1.0.0.0/chrome-headless-shell-mac-arm64/chrome-headless-shell`
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    const c = ctx({ dirs: { [root]: ['1.0.0.0'] }, files: [cached, edge] })
    expect(findBrowser(c)).toBe(edge)
  })

  test('falls back to the cached headless shell', () => {
    const root = '/home/me/.cache/slayzone/chrome-headless-shell'
    const cached = `${root}/1.0.0.0/chrome-headless-shell-linux64/chrome-headless-shell`
    const c = ctx({
      platform: 'linux',
      arch: 'x64',
      homedir: '/home/me',
      env: { PATH: '/usr/bin' },
      dirs: { [root]: ['1.0.0.0'] },
      files: [cached]
    })
    expect(findBrowser(c)).toBe(cached)
  })

  test('null when there is nothing at all', () => {
    expect(findBrowser(ctx({ platform: 'linux', env: { PATH: '/usr/bin' } }))).toBeNull()
  })
})
