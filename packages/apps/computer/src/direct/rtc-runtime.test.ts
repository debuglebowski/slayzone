/**
 * The computer's WebRTC runtime (docs/direct-link.md): node-datachannel, loaded
 * lazily and optional — a computer without it simply does not offer WebRTC.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findRtcBinary, loadRtcRuntime, rtcRuntimeAvailable } from './rtc-runtime'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

it('loads node-datachannel and moves a message between two in-process peers', async () => {
  const rtc = loadRtcRuntime()
  expect(rtc).not.toBeNull()
  if (!rtc) return
  const a = new rtc.PeerConnection('a', { iceServers: [] })
  const b = new rtc.PeerConnection('b', { iceServers: [] })
  cleanups.push(
    () => a.close(),
    () => b.close()
  )
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type))
  a.onLocalCandidate((c, mid) => b.addRemoteCandidate(c, mid))
  b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type))
  b.onLocalCandidate((c, mid) => a.addRemoteCandidate(c, mid))
  const got = new Promise<string>((resolve) => {
    b.onDataChannel((dc) => dc.onMessage((m) => resolve(String(m))))
  })
  const dc = a.createDataChannel('direct')
  dc.onOpen(() => dc.sendMessage('hello'))
  expect(await got).toBe('hello')
})

/**
 * What the computer advertises (`directRtc`) without loading the addon. A resolve of
 * node-datachannel alone said yes for a release built on another arch: the macOS x64
 * and Windows arm64 builds packed only the BUILD host's per-platform binary, so the
 * main package resolved, every offer then failed to load it, and the hub kept
 * sending them. The binary node-datachannel would load must be on disk.
 */
describe('findRtcBinary', () => {
  const PLATFORM_PACKAGES: Record<string, { os: string; cpu: string; libc?: string }> = {
    'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
    'darwin-x64': { os: 'darwin', cpu: 'x64' },
    'linux-x64-gnu': { os: 'linux', cpu: 'x64', libc: 'glibc' },
    'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
    'win32-arm64-msvc': { os: 'win32', cpu: 'arm64' },
    'win32-x64-msvc': { os: 'win32', cpu: 'x64' }
  }

  /**
   * A node_modules tree shaped like node-datachannel 0.33's: the main package lists
   * every per-platform package as optional, and only `installed` are on disk.
   * Returns the path a require is resolved from (an app file beside node_modules).
   */
  function tree(
    installed: string[],
    opts: { main?: boolean; localBuild?: string; noBinary?: boolean } = {}
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'rtc-binary-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const write = (rel: string, content: string) => {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    write('app/index.js', '')
    if (opts.main !== false) {
      write(
        'node_modules/node-datachannel/package.json',
        JSON.stringify({
          name: 'node-datachannel',
          version: '0.33.4',
          main: './dist/cjs/lib/index.cjs',
          exports: {
            '.': { require: './dist/cjs/lib/index.cjs' },
            './polyfill': { require: './dist/cjs/polyfill/index.cjs' }
          },
          optionalDependencies: Object.fromEntries(
            Object.keys(PLATFORM_PACKAGES).map((p) => [`@node-datachannel/${p}`, '0.33.4'])
          )
        })
      )
      write('node_modules/node-datachannel/dist/cjs/lib/index.cjs', '')
      write('node_modules/node-datachannel/dist/cjs/polyfill/index.cjs', '')
      if (opts.localBuild) write(`node_modules/node-datachannel/${opts.localBuild}`, 'local')
    }
    for (const name of installed) {
      const meta = PLATFORM_PACKAGES[name]
      write(
        `node_modules/@node-datachannel/${name}/package.json`,
        JSON.stringify({
          name: `@node-datachannel/${name}`,
          version: '0.33.4',
          main: 'node_datachannel.node',
          os: [meta.os],
          cpu: [meta.cpu],
          ...(meta.libc ? { libc: [meta.libc] } : {})
        })
      )
      if (!opts.noBinary)
        write(`node_modules/@node-datachannel/${name}/node_datachannel.node`, 'bin')
    }
    return join(root, 'app', 'index.js')
  }
  const binaryOf = (name: string) =>
    expect.stringMatching(
      new RegExp(`${['@node-datachannel', name, 'node_datachannel.node'].join(`\\${sep}`)}$`)
    )

  it('finds the per-platform binary node-datachannel loads on this target', () => {
    const from = tree(['darwin-arm64'])
    expect(findRtcBinary(from, { platform: 'darwin', arch: 'arm64' })).toEqual(
      binaryOf('darwin-arm64')
    )
  })

  it('answers null when only another arch’s binary is installed (x64 app packed on arm64)', () => {
    const from = tree(['darwin-arm64'])
    expect(findRtcBinary(from, { platform: 'darwin', arch: 'x64' })).toBeNull()
  })

  it('answers null for Windows arm64 when only the x64 binary is installed', () => {
    const from = tree(['win32-x64-msvc'])
    expect(findRtcBinary(from, { platform: 'win32', arch: 'arm64' })).toBeNull()
    expect(
      findRtcBinary(tree(['win32-x64-msvc', 'win32-arm64-msvc']), {
        platform: 'win32',
        arch: 'arm64'
      })
    ).toEqual(binaryOf('win32-arm64-msvc'))
  })

  it('matches the libc on Linux, as the loader does', () => {
    const from = tree(['linux-x64-gnu'])
    expect(findRtcBinary(from, { platform: 'linux', arch: 'x64', libc: 'musl' })).toBeNull()
    expect(findRtcBinary(from, { platform: 'linux', arch: 'x64', libc: 'glibc' })).toEqual(
      binaryOf('linux-x64-gnu')
    )
  })

  it('answers null when the package is there but its binary is not', () => {
    const from = tree(['darwin-x64'], { noBinary: true })
    expect(findRtcBinary(from, { platform: 'darwin', arch: 'x64' })).toBeNull()
  })

  it('answers null when node-datachannel itself is not installed', () => {
    const from = tree(['darwin-arm64'], { main: false })
    expect(findRtcBinary(from, { platform: 'darwin', arch: 'arm64' })).toBeNull()
  })

  it('takes a local build first, as the loader does', () => {
    const from = tree([], { localBuild: 'build/Release/node_datachannel.node' })
    expect(findRtcBinary(from, { platform: 'darwin', arch: 'x64' })).toEqual(
      expect.stringMatching(/node_datachannel\.node$/)
    )
  })

  it('agrees with the real install: the binary it finds is the one that loads here', () => {
    expect(rtcRuntimeAvailable()).toBe(true)
    expect(loadRtcRuntime()).not.toBeNull()
    const req = createRequire(import.meta.url)
    const real = findRtcBinary(req.resolve('node-datachannel'), {
      platform: process.platform,
      arch: process.arch
    })
    expect(real).not.toBeNull()
    // Every per-platform package installed here; the one found is among them.
    const ndcRoot = join(dirname(req.resolve('node-datachannel')), '..', '..', '..')
    const manifest = JSON.parse(readFileSync(join(ndcRoot, 'package.json'), 'utf8')) as {
      optionalDependencies: Record<string, string>
    }
    const ndc = createRequire(join(ndcRoot, 'package.json'))
    const loadable = Object.keys(manifest.optionalDependencies).flatMap((n) => {
      try {
        return [ndc.resolve(n)]
      } catch {
        return []
      }
    })
    expect(loadable).toContain(real)
  })
})
