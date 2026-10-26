/**
 * Parent-death detection for the computer the desktop app supervises.
 *
 * The app spawns its local computer (local-computer-supervisor.ts) and reaps it on
 * quit. Nothing reaps it when the app dies some other way — a crash, a SIGKILL, a
 * force-quit, or a quit whose process exits before its SIGTERM→SIGKILL escalation
 * lands. The computer is then reparented and lives on: it keeps every agent pty
 * alive with no app to show them, and holds the computer id the next app's
 * computer needs.
 *
 * Three signals, because no single one is reliable on every OS:
 *
 *  - stdin closes. The supervisor spawns with stdin as a pipe and never writes or
 *    closes its end, so that end lives exactly as long as the app process: the OS
 *    closes it on ANY exit, SIGKILL included. Instant, and the main signal on
 *    Windows, which never reparents. Misses only when something else holds a copy
 *    of the write end.
 *  - stdout/stderr report EPIPE. The app holds the only read end of both, so a
 *    write failing with a broken pipe means it is gone. Without a listener that
 *    EPIPE is an uncaught exception — the computer would crash mid-teardown,
 *    before disposing its ptys — so it is swallowed for good once seen.
 *  - a poll of the parent. On POSIX an orphan is reparented (to pid 1 or a
 *    subreaper), so `process.ppid` changes; on every OS the original parent pid
 *    stops existing. A reused pid can only delay this, never fake a death.
 *
 * Nothing here holds the event loop open: a computer whose dialer gives up must
 * still exit on its own (the supervisor reads that exit code), not idle on a pipe.
 *
 * Only for a computer the app supervises (`SLAYZONE_SUPERVISED=1`, see bin.ts). A
 * standalone computer — `slay computer`, a launchd/systemd unit, a shell — has no
 * parent whose death means anything, and its stdin may be /dev/null or a terminal.
 *
 * @module computer/parent-watch
 */

export type ParentDeathReason =
  /** stdin hit EOF or errored: the app's end of the pipe is gone. */
  | 'parent-pipe-closed'
  /** A write to stdout/stderr failed with EPIPE: the app's read end is gone. */
  | 'parent-output-closed'
  /** `process.ppid` changed (or is init's): the computer was reparented. */
  | 'parent-reparented'
  /** The original parent pid no longer exists (Windows never reparents). */
  | 'parent-exited'

/** The slice of a readable stdin this needs. `unref` exists on pipes and TTYs. */
type WatchedStdin = NodeJS.ReadableStream & { unref?: () => unknown }

export interface ParentWatchOptions {
  /** Called at most once, with whichever signal landed first. */
  onParentDeath: (reason: ParentDeathReason) => void
  /** Default `process.stdin`. */
  stdin?: WatchedStdin
  /** Pipes whose EPIPE means the parent is gone. Default `[process.stdout, process.stderr]`. */
  outputs?: NodeJS.EventEmitter[]
  /** Default: `process.ppid`, which re-reads the parent on every access. */
  getPpid?: () => number
  /** Default: a signal-0 probe. */
  isAlive?: (pid: number) => boolean
  /** Default {@link PARENT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** Default `process.platform`. */
  platform?: NodeJS.Platform
}

export interface ParentWatch {
  /** Disarm every signal. A broken output pipe stays swallowed: its reader is gone either way. */
  stop(): void
}

/** How often the parent is polled. Cheap (two syscalls); bounds the slowest detection. */
export const PARENT_POLL_INTERVAL_MS = 1_000

/** Does `pid` exist? EPERM = it exists but is not ours. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isBrokenPipe(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EPIPE'
}

export function watchParent(opts: ParentWatchOptions): ParentWatch {
  const stdin = opts.stdin ?? process.stdin
  const outputs = opts.outputs ?? [process.stdout, process.stderr]
  const getPpid = opts.getPpid ?? (() => process.ppid)
  const isAlive = opts.isAlive ?? pidExists
  const platform = opts.platform ?? process.platform
  const parentPid = getPpid()

  let armed = true
  let poll: NodeJS.Timeout | null = null

  const stop = (): void => {
    armed = false
    if (poll) clearInterval(poll)
    poll = null
  }

  const fire = (reason: ParentDeathReason): void => {
    if (!armed) return
    stop()
    opts.onParentDeath(reason)
  }

  // Listeners stay attached after stop()/fire(): a later stdin error or EPIPE must
  // not become an uncaught exception either. They are inert once disarmed.
  const onPipeClosed = (): void => fire('parent-pipe-closed')
  stdin.on('end', onPipeClosed)
  stdin.on('close', onPipeClosed)
  stdin.on('error', onPipeClosed)
  // Flowing, so EOF is observed; nothing ever reads the bytes (the app sends none).
  stdin.resume()
  stdin.unref?.()

  for (const output of outputs) {
    output.on('error', (err: unknown) => {
      // Anything but a closed pipe keeps its old meaning: an uncaught exception.
      if (!isBrokenPipe(err)) throw err
      fire('parent-output-closed')
    })
  }

  const check = (): void => {
    const ppid = getPpid()
    // init/launchd adopted us — at boot, the app died before this watch was armed.
    // Windows has no pid 1 and never reparents.
    if (ppid !== parentPid || (platform !== 'win32' && ppid === 1)) {
      fire('parent-reparented')
      return
    }
    if (!isAlive(parentPid)) fire('parent-exited')
  }
  check()
  if (armed) {
    poll = setInterval(check, opts.pollIntervalMs ?? PARENT_POLL_INTERVAL_MS)
    poll.unref()
  }

  return { stop }
}
