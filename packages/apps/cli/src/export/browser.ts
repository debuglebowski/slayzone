/**
 * Which local Chrome-family browser renders a PDF/PNG export. Searched in order:
 *   1. `--browser <path>` (the caller handles it; see export-artifact.ts)
 *   2. an installed Chrome / Chromium / Edge / Brave at its standard location
 *   3. a chrome-headless-shell previously downloaded by `--install-browser` into the
 *      per-user cache (`headlessShellCacheRoot`)
 *
 * Pure: platform, env, home and the two filesystem probes come in as a `BrowserEnv`,
 * so each OS's search order is testable from any OS. Paths are joined with that
 * platform's separator (`path.win32` for Windows), never the host's.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface BrowserEnv {
  platform: NodeJS.Platform
  arch: string
  env: Record<string, string | undefined>
  homedir: string
  /** A regular file this process may execute. */
  isExecutable: (p: string) => boolean
  /** Entry names of a directory; [] when it does not exist. */
  listDir: (p: string) => string[]
}

export function defaultBrowserEnv(): BrowserEnv {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: os.homedir(),
    isExecutable: (p) => {
      try {
        if (!fs.statSync(p).isFile()) return false
        fs.accessSync(p, fs.constants.X_OK)
        return true
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

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser'
]

const LINUX_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge-stable',
  'microsoft-edge',
  'brave-browser'
]

/** Relative to Program Files / Program Files (x86) / LocalAppData. */
const WINDOWS_APPS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Chromium\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
]

/** Every place an installed browser may live on this platform, most preferred first. */
export function systemBrowserCandidates(ctx: BrowserEnv): string[] {
  const p = pathFor(ctx.platform)
  switch (ctx.platform) {
    case 'darwin':
      return [
        ...MAC_APPS.map((a) => p.join('/Applications', a)),
        ...MAC_APPS.map((a) => p.join(ctx.homedir, 'Applications', a))
      ]
    case 'win32': {
      const roots = [
        ctx.env.ProgramFiles || 'C:\\Program Files',
        ctx.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        ctx.env.LOCALAPPDATA || p.join(ctx.homedir, 'AppData', 'Local')
      ]
      return roots.flatMap((root) => WINDOWS_APPS.map((a) => p.join(root, a)))
    }
    default: {
      const dirs = (ctx.env.PATH ?? '').split(':').filter(Boolean)
      return dirs.flatMap((dir) => LINUX_NAMES.map((name) => p.join(dir, name)))
    }
  }
}

export function findSystemBrowser(ctx: BrowserEnv): string | null {
  return systemBrowserCandidates(ctx).find((c) => ctx.isExecutable(c)) ?? null
}

/** Chrome for Testing's name for an OS/arch, or null when it publishes no build for it. */
export function cftPlatformFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin')
    return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null
  if (platform === 'linux')
    return arch === 'x64' ? 'linux64' : arch === 'arm64' ? 'linux-arm64' : null
  if (platform === 'win32') {
    if (arch === 'ia32') return 'win32'
    // Windows on ARM runs the x64 build under emulation; CfT publishes no arm64 one.
    return arch === 'x64' || arch === 'arm64' ? 'win64' : null
  }
  return null
}

/** `<per-user cache>/slayzone/chrome-headless-shell`; one subdirectory per version. */
export function headlessShellCacheRoot(ctx: BrowserEnv): string {
  const p = pathFor(ctx.platform)
  let cache: string
  if (ctx.platform === 'darwin') cache = p.join(ctx.homedir, 'Library', 'Caches')
  else if (ctx.platform === 'win32')
    cache = ctx.env.LOCALAPPDATA || p.join(ctx.homedir, 'AppData', 'Local')
  else cache = ctx.env.XDG_CACHE_HOME || p.join(ctx.homedir, '.cache')
  return p.join(cache, 'slayzone', 'chrome-headless-shell')
}

/** The executable inside an unpacked CfT headless-shell zip (relative to the version dir). */
export function headlessShellBinaryRel(platform: NodeJS.Platform, cftPlatform: string): string {
  const exe = platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
  return pathFor(platform).join(`chrome-headless-shell-${cftPlatform}`, exe)
}

/** A CfT version string (`157.0.8103.38`) — the only directory names the cache holds. */
export const VERSION_RE = /^\d+(\.\d+){1,3}$/

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The newest fully installed headless shell in the cache, or null. */
export function findCachedHeadlessShell(ctx: BrowserEnv): string | null {
  const cft = cftPlatformFor(ctx.platform, ctx.arch)
  if (!cft) return null
  const root = headlessShellCacheRoot(ctx)
  const p = pathFor(ctx.platform)
  const versions = ctx
    .listDir(root)
    .filter((v) => VERSION_RE.test(v))
    .sort(compareVersions)
    .reverse()
  for (const v of versions) {
    const bin = p.join(root, v, headlessShellBinaryRel(ctx.platform, cft))
    if (ctx.isExecutable(bin)) return bin
  }
  return null
}

/** Steps 2–3 of the search order (step 1, `--browser`, is the caller's). */
export function findBrowser(ctx: BrowserEnv): string | null {
  return findSystemBrowser(ctx) ?? findCachedHeadlessShell(ctx)
}
