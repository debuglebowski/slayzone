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
 * under the OS temp dir. Their paths must fit `sun_path` (macOS 104 bytes, Linux 108):
 * Node refuses a longer one with EINVAL. macOS's temp dir is long — `control.sock`
 * (released; running hosts are found there, so its path never changes) already sits
 * at 104 bytes with a 3-digit uid — so the launcher's name is kept far shorter, and a
 * path over the limit throws a clear error when named. Windows: named pipes, which the
 * OS makes exclusive and removes with their owner.
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
 * Longest Unix socket path Node's `listen`/`connect` accept on each platform:
 * `sizeof(sockaddr_un.sun_path)`. Node (libuv `UV_PIPE_NO_TRUNCATE`) refuses, never
 * truncates, a longer one, with an EINVAL that names nothing. BSDs share macOS's 104.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES: Readonly<Record<string, number>> = {
  darwin: 104,
  linux: 108
}
const DEFAULT_UNIX_SOCKET_PATH_MAX_BYTES = 104

/** `UNIX_SOCKET_PATH_MAX_BYTES` for `platform`; `Infinity` on Windows (named pipes). */
export function unixSocketPathMaxBytes(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return Infinity
  return UNIX_SOCKET_PATH_MAX_BYTES[platform] ?? DEFAULT_UNIX_SOCKET_PATH_MAX_BYTES
}

/**
 * `path`, or a thrown `ENAMETOOLONG` naming the path and the limit when it cannot be
 * bound or connected on `platform`. launch.cjs (computer-launcher.ts) applies the
 * same check, with the same message, before it binds.
 */
export function assertUnixSocketPathFits(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  const max = unixSocketPathMaxBytes(platform)
  const bytes = Buffer.byteLength(path)
  if (bytes <= max) return path
  throw Object.assign(
    new Error(
      `computer endpoint ${path} is ${bytes} bytes, over the ${max}-byte Unix socket path limit on ${platform}; point TMPDIR at a shorter directory`
    ),
    { code: 'ENAMETOOLONG' }
  )
}

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

/**
 * The session host's control endpoint. Pure: creates nothing. Throws when the path
 * cannot be a Unix socket here (`assertUnixSocketPathFits`).
 */
export function hostEndpoint(root: string): string {
  const dir = hostEndpointDir(root)
  return dir
    ? assertUnixSocketPathFits(join(dir, 'control.sock'))
    : `\\\\.\\pipe\\slay-computer-${endpointKey(root)}`
}

/**
 * The session-host launcher's single-instance endpoint. Pure: creates nothing. Throws
 * like `hostEndpoint`. One letter: it must never be the path that outgrows `sun_path`
 * first (`control.sock`, the fixed one, is 6 bytes longer).
 */
export function hostLauncherEndpoint(root: string): string {
  const dir = hostEndpointDir(root)
  return dir
    ? assertUnixSocketPathFits(join(dir, 'l.sock'))
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
 * Connect errors that prove a listener exists but cannot take this connection now:
 * Linux answers a Unix socket whose accept backlog is full with EAGAIN. Every other
 * error besides ENOENT/ECONNREFUSED (EINVAL, ENAMETOOLONG, EACCES, ...) says nothing
 * about an owner: it is the caller's to surface, never a reason to wait. launch.cjs
 * classifies the same way (its `probe`).
 */
const BUSY_CONNECT_ERRORS: ReadonlySet<string> = new Set(['EAGAIN'])

/**
 * Is something bound to this endpoint? `live`: a connection was accepted, or the
 * attempt timed out or met a full backlog (assume an owner, never delete what might
 * be someone's). `stale`: a POSIX socket file with no listener. `absent`: nothing
 * there. Rejects with the connect error for anything else.
 */
export function probeEndpoint(
  path: string,
  timeoutMs = 2000
): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((done, fail) => {
    const socket = connect(path)
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      socket.destroy()
      settle()
    }
    const timer = setTimeout(() => finish(() => done('live')), timeoutMs)
    socket.once('connect', () => finish(() => done('live')))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish(() => done('absent'))
      else if (err.code === 'ECONNREFUSED') finish(() => done('stale'))
      else if (err.code && BUSY_CONNECT_ERRORS.has(err.code)) finish(() => done('live'))
      else finish(() => fail(err))
    })
  })
}

/**
 * A live session-host launcher that did not answer in time (or hung up without an
 * answer). It is still the root's owner: callers wait on it, never start another.
 * Any other `queryHostLauncher` failure is a real error.
 */
export class HostLauncherBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostLauncherBusyError'
  }
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
 * restart backoff at once). `null`: no live launcher. Throws `HostLauncherBusyError`
 * when one is bound but does not answer in time — it is still the owner; callers must
 * not start another. Throws anything else (unusable endpoint path, EACCES, a garbled
 * answer) as it is: no evidence of an owner, so never to be waited on.
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
      () =>
        finish(() =>
          fail(new HostLauncherBusyError('session host launcher did not answer its status query'))
        ),
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
      finish(() => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') done(null)
        else if (err.code && BUSY_CONNECT_ERRORS.has(err.code))
          fail(new HostLauncherBusyError(`session host launcher is busy (${err.code})`))
        else fail(err)
      })
    )
    socket.once('close', () =>
      finish(() =>
        fail(new HostLauncherBusyError('session host launcher closed without answering'))
      )
    )
  })
}
