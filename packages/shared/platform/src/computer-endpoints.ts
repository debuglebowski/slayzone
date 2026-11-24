/**
 * The local endpoints of one computer root.
 *
 * - `control`: the session host's control socket. Whoever is bound to it IS the
 *   computer's session host; a second host that finds it live is superseded.
 * - `launcher`: held by the session host's launcher (`launch.cjs --session-host`)
 *   for its whole life — the single-instance lock that keeps one launcher per root
 *   (2026-11-22: two ran, and one restarted an EADDRINUSE-failing child forever).
 *   It also answers a one-line status query for `ensureSessionHost`.
 *
 * POSIX: Unix sockets in one private (0700, owned, not a symlink) per-root directory
 * under the OS temp dir — a short path, as `sun_path` is ~104 bytes. Windows: named
 * pipes, which the OS makes exclusive and removes with their owner.
 *
 * `launch.cjs` (computer-launcher.ts) is dependency-free, so it derives the same
 * names itself; computer-endpoints.test.ts asserts the two agree.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, rmdirSync, type Stats } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Exit code of a session host that found another live host on its control
 * endpoint. Its launcher stops (exit 0) instead of restarting it, and does not
 * count it as a failed release (no quarantine, no rollback).
 */
export const HOST_SUPERSEDED_EXIT_CODE = 79

function endpointKey(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24)
}

/** The per-root endpoint directory; `null` on Windows (named pipes). Pure. */
export function hostEndpointDir(root: string): string | null {
  if (process.platform === 'win32') return null
  return join(tmpdir(), `slay-computer-${process.getuid?.() ?? 'user'}-${endpointKey(root)}`)
}

/** The session host's control endpoint. Pure: creates nothing. */
export function hostEndpoint(root: string): string {
  const dir = hostEndpointDir(root)
  return dir ? join(dir, 'control.sock') : `\\\\.\\pipe\\slay-computer-${endpointKey(root)}`
}

/** The session-host launcher's single-instance endpoint. Pure: creates nothing. */
export function hostLauncherEndpoint(root: string): string {
  const dir = hostEndpointDir(root)
  return dir
    ? join(dir, 'launcher.sock')
    : `\\\\.\\pipe\\slay-computer-launcher-${endpointKey(root)}`
}

function unsafe(st: Stats): boolean {
  return (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    (process.getuid !== undefined && st.uid !== process.getuid()) ||
    (st.mode & 0o077) !== 0
  )
}

/**
 * Create the endpoint directory (0700), or accept an existing one only if it is a
 * real directory owned by this user with no group/other access. The name is
 * predictable, so another local user could have created it first.
 */
export function prepareEndpointDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const st = lstatSync(dir)
  if (unsafe(st))
    throw new Error(
      `unsafe computer endpoint directory ${dir}: must be a directory owned by this user with mode 0700`
    )
}

/** Remove the endpoint directory once nothing is bound in it (rmdir never deletes contents). */
export function releaseEndpointDir(dir: string | null): void {
  if (!dir) return
  try {
    rmdirSync(dir)
  } catch {
    /* Not empty (the other endpoint is still bound), or already gone. */
  }
}

/**
 * Remove endpoint directories left behind by roots that are gone: owned by this
 * user, EMPTY (nothing bound there), and untouched for `minAgeMs`. `rmdir` cannot
 * delete a directory that gained an entry meanwhile. Returns the removed paths.
 */
export function sweepStaleEndpointDirs(
  opts: { base?: string; keep?: string | null; minAgeMs?: number; now?: number } = {}
): string[] {
  if (process.platform === 'win32') return []
  const base = opts.base ?? tmpdir()
  const minAgeMs = opts.minAgeMs ?? 60 * 60 * 1000
  const now = opts.now ?? Date.now()
  const pattern = new RegExp(`^slay-computer-${process.getuid?.() ?? 'user'}-[a-f0-9]{24}$`)
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return removed
  }
  for (const name of names) {
    try {
      if (!pattern.test(name)) continue
      const dir = join(base, name)
      if (dir === opts.keep) continue
      const st = lstatSync(dir)
      if (unsafe(st) || now - st.mtimeMs < minAgeMs) continue
      rmdirSync(dir)
      removed.push(dir)
    } catch {
      /* Not empty, raced, or not ours: leave it. */
    }
  }
  return removed
}

/**
 * Is something bound to this endpoint? `live`: a connection was accepted (or the
 * attempt neither succeeded nor was refused in time — assume an owner, never
 * delete what might be someone's). `stale`: a POSIX socket file with no listener.
 * `absent`: nothing there.
 */
export function probeEndpoint(
  path: string,
  timeoutMs = 2000
): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((done) => {
    const socket = connect(path)
    const finish = (result: 'live' | 'stale' | 'absent'): void => {
      clearTimeout(timer)
      socket.destroy()
      done(result)
    }
    const timer = setTimeout(() => finish('live'), timeoutMs)
    socket.once('connect', () => finish('live'))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish('absent')
      else if (err.code === 'ECONNREFUSED') finish('stale')
      else finish('live')
    })
  })
}

/** What the live session-host launcher reports (launch.cjs `status`). */
export interface HostLauncherStatus {
  /** `running`: a child is up. `backoff`: waiting `nextLaunchAt` to restart one. */
  state: 'starting' | 'running' | 'backoff' | 'stopping'
  childPid: number | null
  nextLaunchAt: number | null
  lastExit: {
    version: string
    code: number | null
    signal: string | null
    at: number
  } | null
}

/**
 * Ask this root's session-host launcher for its status (`launch-now` also ends a
 * restart backoff at once). `null`: no live launcher. Throws when one is bound but
 * does not answer in time — it is still the owner; callers must not start another.
 */
export function queryHostLauncher(
  root: string,
  command: 'status' | 'launch-now',
  timeoutMs = 2000
): Promise<HostLauncherStatus | null> {
  return new Promise((done, fail) => {
    const socket = connect(hostLauncherEndpoint(root))
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => fail(new Error('session host launcher did not answer its status query'))),
      timeoutMs
    )
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify({ command }) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      finish(() => {
        try {
          done(JSON.parse(buffer.slice(0, end)) as HostLauncherStatus)
        } catch (err) {
          fail(err as Error)
        }
      })
    })
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish(() => (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? done(null) : fail(err)))
    )
    socket.once('close', () =>
      finish(() => fail(new Error('session host launcher closed without answering')))
    )
  })
}
