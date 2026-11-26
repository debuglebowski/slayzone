/**
 * The local endpoints of one computer root: the session host's control socket and
 * its launcher's single-instance endpoint, both in one private per-root directory
 * (a named pipe each on Windows).
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureComputerLauncher } from './computer-launcher'
import {
  assertUnixSocketPathFits,
  hostEndpoint,
  hostEndpointDir,
  hostLauncherEndpoint,
  prepareEndpointDir,
  probeEndpoint,
  releaseEndpointDir,
  sweepStaleEndpointDirs,
  unixSocketPathMaxBytes
} from './computer-endpoints'

const posix = process.platform !== 'win32'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => {
    const dir = hostEndpointDir(root)
    if (dir) rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((s) => s.end())
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

describe('computer endpoints', () => {
  it('naming an endpoint creates nothing on disk', () => {
    const root = tempRoot('endpoints-pure-')
    const control = hostEndpoint(root)
    const launcher = hostLauncherEndpoint(root)
    expect(control).not.toBe(launcher)
    const dir = hostEndpointDir(root)
    if (posix) {
      expect(dir).not.toBeNull()
      expect(control.startsWith(dir! + '/')).toBe(true)
      expect(launcher.startsWith(dir! + '/')).toBe(true)
      expect(existsSync(dir!)).toBe(false)
    } else {
      expect(dir).toBeNull()
      expect(control).toMatch(/^\\\\\.\\pipe\\slay-computer-[a-f0-9]{24}$/)
      expect(launcher).toMatch(/^\\\\\.\\pipe\\slay-computer-launcher-[a-f0-9]{24}$/)
    }
  })

  it('launch.cjs derives exactly the same endpoints as the platform', () => {
    const root = tempRoot('endpoints-parity-')
    const launcher = ensureComputerLauncher(root, {
      entry: join(root, 'none.cjs'),
      version: '1'
    })
    const printed = JSON.parse(
      execFileSync(process.execPath, [launcher, '--print-endpoints'], {
        env: { ...process.env, SLAYZONE_ROOT: root },
        encoding: 'utf8'
      })
    )
    expect(printed).toEqual({
      control: hostEndpoint(root),
      launcher: hostLauncherEndpoint(root)
    })
  })

  it.skipIf(!posix)(
    'the endpoint directory is created private, and an unsafe one is refused',
    () => {
      const root = tempRoot('endpoints-dir-')
      const dir = hostEndpointDir(root)!
      prepareEndpointDir(dir)
      expect(existsSync(dir)).toBe(true)
      prepareEndpointDir(dir) // idempotent
      chmodSync(dir, 0o755)
      expect(() => prepareEndpointDir(dir)).toThrow(/unsafe/)
      rmSync(dir, { recursive: true, force: true })
      const elsewhere = mkdtempSync(join(tmpdir(), 'endpoints-target-'))
      cleanup.push(() => rmSync(elsewhere, { recursive: true, force: true }))
      symlinkSync(elsewhere, dir)
      expect(() => prepareEndpointDir(dir)).toThrow(/unsafe/)
      // unlink, not rmSync: Node 24's rmSync refuses a symlink to a directory.
      unlinkSync(dir)
    }
  )

  it.skipIf(!posix)(
    'releasing the directory removes it only when nothing is left in it',
    async () => {
      const root = tempRoot('endpoints-release-')
      const dir = hostEndpointDir(root)!
      prepareEndpointDir(dir)
      const server = await listen(hostLauncherEndpoint(root))
      releaseEndpointDir(dir)
      expect(existsSync(dir)).toBe(true)
      await new Promise((r) => server.close(r))
      releaseEndpointDir(dir)
      expect(existsSync(dir)).toBe(false)
      releaseEndpointDir(dir) // already gone
    }
  )

  it.skipIf(!posix)(
    'the launcher endpoint is never the one that outgrows the socket path limit',
    () => {
      const root = tempRoot('endpoints-length-')
      const control = Buffer.byteLength(hostEndpoint(root))
      const launcher = Buffer.byteLength(hostLauncherEndpoint(root))
      // control.sock is released (running hosts are found there); it is the bound.
      // On macOS it already sits near 104 bytes: the launcher keeps a margin below it.
      expect(launcher).toBeLessThanOrEqual(control - 4)
      expect(control).toBeLessThanOrEqual(unixSocketPathMaxBytes())
    }
  )

  it('a Unix socket path over the platform limit fails loudly, naming path and limit', () => {
    expect(unixSocketPathMaxBytes('darwin')).toBe(104)
    expect(unixSocketPathMaxBytes('linux')).toBe(108)
    const at = (n: number): string => '/' + 'x'.repeat(n - 1)
    expect(assertUnixSocketPathFits(at(104), 'darwin')).toBe(at(104))
    expect(assertUnixSocketPathFits(at(108), 'linux')).toBe(at(108))
    expect(() => assertUnixSocketPathFits(at(105), 'darwin')).toThrow(
      `computer endpoint ${at(105)} is 105 bytes, over the 104-byte Unix socket path limit on darwin`
    )
    expect(() => assertUnixSocketPathFits(at(109), 'linux')).toThrow(/109 bytes.*108-byte.*linux/)
    // Named pipes have no such limit here.
    expect(assertUnixSocketPathFits(at(200), 'win32')).toBe(at(200))
  })

  it.skipIf(!posix)('naming an endpoint under an overlong temp dir fails loudly', () => {
    const root = tempRoot('endpoints-overlong-')
    const before = process.env.TMPDIR
    process.env.TMPDIR = join(tmpdir(), 'y'.repeat(90))
    try {
      expect(() => hostEndpoint(root)).toThrow(/byte Unix socket path limit/)
      expect(() => hostLauncherEndpoint(root)).toThrow(/byte Unix socket path limit/)
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })

  it.skipIf(!posix || process.getuid?.() === 0)(
    'probe surfaces an error that says nothing about liveness instead of guessing "live"',
    async () => {
      const root = tempRoot('endpoints-probe-error-')
      const path = hostEndpoint(root)
      prepareEndpointDir(hostEndpointDir(root)!)
      const server = await listen(path)
      cleanup.push(() => server.close())
      chmodSync(path, 0)
      await expect(probeEndpoint(path)).rejects.toMatchObject({ code: 'EACCES' })
      // A path the OS refuses outright (over sun_path): EINVAL, not "live".
      await expect(probeEndpoint('/' + 'z'.repeat(200))).rejects.toMatchObject({
        code: 'EINVAL'
      })
    }
  )

  it('probe tells a live endpoint from a stale or absent one', async () => {
    const root = tempRoot('endpoints-probe-')
    const path = hostEndpoint(root)
    const dir = hostEndpointDir(root)
    if (dir) prepareEndpointDir(dir)
    expect(await probeEndpoint(path)).toBe('absent')
    const server = await listen(path)
    expect(await probeEndpoint(path)).toBe('live')
    await new Promise((r) => server.close(r))
    if (posix) {
      // A socket file whose owner died (SIGKILL leaves it behind).
      writeStaleSocket(path)
      expect(await probeEndpoint(path)).toBe('stale')
    }
  })

  it.skipIf(!posix)('the sweep removes only old, empty, owned endpoint directories', async () => {
    const base = mkdtempSync(join(tmpdir(), 'endpoints-sweep-'))
    cleanup.push(() => rmSync(base, { recursive: true, force: true }))
    const uid = process.getuid!()
    const name = (n: number) => `slay-computer-${uid}-${String(n).padStart(24, '0')}`
    const old = Date.now() / 1000 - 2 * 3600
    const mk = (n: number, age = old): string => {
      const d = join(base, name(n))
      mkdirSync(d, { mode: 0o700 })
      utimesSync(d, age, age)
      return d
    }
    const emptyOld = mk(1)
    const emptyFresh = mk(2, Date.now() / 1000)
    const busy = mk(3)
    writeFileSync(join(busy, 'control.sock'), '')
    utimesSync(busy, old, old)
    const kept = mk(4)
    const unrelated = join(base, 'slay-computer-other')
    mkdirSync(unrelated)
    utimesSync(unrelated, old, old)

    const removed = sweepStaleEndpointDirs({ base, keep: kept })
    expect(removed).toEqual([emptyOld])
    expect(existsSync(emptyOld)).toBe(false)
    for (const d of [emptyFresh, busy, kept, unrelated]) expect(existsSync(d)).toBe(true)
  })
})

/** Leave a socket file with no listener behind, as a SIGKILLed owner does. */
function writeStaleSocket(path: string): void {
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`
      ],
      { stdio: 'ignore' }
    )
  } catch {
    /* Killed by design. */
  }
  if (!existsSync(path)) throw new Error('stale socket was not left behind')
}
