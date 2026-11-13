/**
 * The computer's WebRTC runtime for the direct link (docs/direct-link.md):
 * node-datachannel (libdatachannel: OpenSSL DTLS, usrsctp, libjuice ICE).
 *
 * Loaded lazily and optional, never at import (like node-pty). It ships Node-API
 * prebuilds as per-platform optional packages (macOS, Linux gnu/musl, Windows; x64
 * and arm64), so the same binary loads under plain Node and under Electron's Node.
 * Where none fits, this answers null and the computer does not offer WebRTC: clients
 * use the hub relay, as before. A failure is not cached: a later call retries.
 *
 * @module computer/direct/rtc-runtime
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export type RtcRuntime = typeof import('node-datachannel')
/** The standards-shaped API (RTCPeerConnection, RTCDataChannel) over the same addon. */
export type RtcPolyfill = typeof import('node-datachannel/polyfill')

let loaded: RtcRuntime | undefined
let polyfill: RtcPolyfill | undefined

let resolvable: boolean | undefined

/** The platform a native binary must be built for (`process.platform` / `process.arch`). */
export interface RtcBinaryTarget {
  platform: string
  arch: string
  /** Linux only: the C library, as node-datachannel's loader detects it (detect-libc). */
  libc?: string | null
}

/**
 * node-datachannel's local builds, relative to its package root, in the order its
 * loader tries them (from `dist/cjs/lib`: `../../build/…` and `../../../build/…`)
 * before any per-platform package.
 */
const LOCAL_BUILDS = ['dist', '.'].flatMap((base) =>
  ['build', 'build/Release', 'build/Debug'].map((dir) => join(base, dir, 'node_datachannel.node'))
)

/** npm's `os`/`cpu`/`libc` field semantics: absent = any; `!x` entries exclude. */
function fieldAllows(field: unknown, value: string): boolean {
  if (!Array.isArray(field) || field.length === 0) return true
  if (field.includes(value)) return true
  if (field.includes(`!${value}`)) return false
  return field.every((v) => typeof v === 'string' && v.startsWith('!'))
}

/** The directory of the package that owns `file` (nearest package.json named `name`). */
function packageRootOf(file: string, name: string): string | null {
  let dir = dirname(file)
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === name) {
          return dir
        }
      } catch {
        // Not a readable manifest: keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The native binary node-datachannel would load for `target`, as resolved from
 * `from` (a file a require is resolved relative to), WITHOUT loading it — or null
 * when there is none. Its loader takes a local build first, then the per-platform
 * package for this platform (an optional dependency, so a package manager installs
 * only the host's). The package is found by what its own package.json declares
 * (`os`/`cpu`/`libc`), not by the loader's private name mapping, and its binary
 * must be on disk: a release packed on another arch carries the main package with
 * the BUILD host's binary only, which resolves fine and then fails every load.
 */
export function findRtcBinary(from: string, target: RtcBinaryTarget): string | null {
  let main: string
  try {
    main = createRequire(from).resolve('node-datachannel')
  } catch {
    return null
  }
  const root = packageRootOf(main, 'node-datachannel')
  if (!root) return null
  for (const rel of LOCAL_BUILDS) {
    const candidate = join(root, rel)
    if (existsSync(candidate)) return candidate
  }
  let optional: Record<string, unknown>
  try {
    optional =
      (
        JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          optionalDependencies?: Record<string, unknown>
        }
      ).optionalDependencies ?? {}
  } catch {
    return null
  }
  const fromRoot = createRequire(join(root, 'package.json'))
  for (const name of Object.keys(optional)) {
    let manifest: { os?: unknown; cpu?: unknown; libc?: unknown }
    try {
      manifest = JSON.parse(readFileSync(fromRoot.resolve(`${name}/package.json`), 'utf8'))
    } catch {
      continue // not installed here
    }
    if (!fieldAllows(manifest.os, target.platform) || !fieldAllows(manifest.cpu, target.arch)) {
      continue
    }
    if (target.platform === 'linux' && target.libc && !fieldAllows(manifest.libc, target.libc)) {
      continue
    }
    try {
      // The package's main is the .node file itself; resolving proves it is on disk.
      return fromRoot.resolve(name)
    } catch {
      // Installed without its binary.
    }
  }
  return null
}

/** Where this module's requires resolve from: the computer bundle, or (tests) the entry script. */
function requireBase(): string {
  if (typeof require === 'function' && typeof __filename === 'string') return __filename
  return process.argv[1] ?? join(process.cwd(), 'index.js')
}

/** The running C library on Linux, decided as node-datachannel's loader decides it. */
function currentLibc(from: string): string | null {
  try {
    const fromMain = createRequire(createRequire(from).resolve('node-datachannel'))
    const detect = fromMain('detect-libc') as { familySync(): string | null }
    return detect.familySync()
  } catch {
    return null
  }
}

/**
 * Whether node-datachannel can load here, without loading it: what the computer
 * advertises (`directRtc`) at boot. Its polyfill entry must resolve and the native
 * binary for THIS platform and arch must be on disk ({@link findRtcBinary}) — a
 * resolve of the main package alone also says yes for a build packed with another
 * arch's binary. The addon itself is loaded on the first offer
 * ({@link loadRtcPolyfill}); a binary that then fails to load refuses that offer,
 * the client uses the hub relay, and the computer stops advertising (main.ts).
 */
export function rtcRuntimeAvailable(): boolean {
  if (resolvable !== undefined) return resolvable
  try {
    const from = requireBase()
    createRequire(from).resolve('node-datachannel/polyfill')
    resolvable =
      findRtcBinary(from, {
        platform: process.platform,
        arch: process.arch,
        libc: process.platform === 'linux' ? currentLibc(from) : null
      }) !== null
  } catch {
    resolvable = false
  }
  return resolvable
}

/** node-datachannel, or null when it cannot load on this machine. */
export function loadRtcRuntime(
  log?: (message: string, detail?: Record<string, unknown>) => void
): RtcRuntime | null {
  if (loaded) return loaded
  try {
    loaded =
      typeof require === 'function'
        ? // The computer's CJS bundle: esbuild leaves this call in place, external.
          (require('node-datachannel') as RtcRuntime)
        : // Unbundled ESM (tests): resolve from the entry script.
          (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-datachannel'
          ) as RtcRuntime)
    return loaded
  } catch (err) {
    log?.('WebRTC unavailable on this computer — clients use the hub relay', {
      error: String(err)
    })
    return null
  }
}

/** node-datachannel's standards-shaped API, or null (see {@link loadRtcRuntime}). */
export function loadRtcPolyfill(
  log?: (message: string, detail?: Record<string, unknown>) => void
): RtcPolyfill | null {
  if (polyfill) return polyfill
  if (!loadRtcRuntime(log)) return null
  try {
    polyfill =
      typeof require === 'function'
        ? (require('node-datachannel/polyfill') as RtcPolyfill)
        : (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-datachannel/polyfill'
          ) as RtcPolyfill)
    return polyfill
  } catch (err) {
    log?.('WebRTC unavailable on this computer — clients use the hub relay', {
      error: String(err)
    })
    return null
  }
}
