/**
 * The computer's own log file: `<stateDir>/logs/computer.log`, rotated by size.
 *
 * Its stdout goes to whoever launched it — on the desktop, the app's supervisor,
 * which drops it unless `SLAYZONE_DEBUG_BOOT=1`; a standalone session host's goes to
 * `computer-runtime/host.log` or the service journal. So until now nothing the
 * computer said reached anywhere durable: on 2026-11-11 an agent restore took ~3 min
 * and there was no record of how long each start waited for its slot. Every line the
 * computer logs is now also appended here (the hub has its `sidecar.log`) — by the
 * desktop's computer and by the standalone session host alike (`createComputerLog`).
 *
 * Rotated when it grows past its size WHILE running (a computer runs for weeks), one
 * generation kept: `computer.log` → `computer.log.1`.
 *
 * Never throws: a full disk or unwritable dir must not fail the computer.
 *
 * @module computer/file-log
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRotatingFileLog,
  DEFAULT_LOG_MAX_BYTES,
  rotateLogFile
} from '@slayzone/platform/rotating-log'

export { rotateLogFile }

export const COMPUTER_LOG_DIR_NAME = 'logs'
export const COMPUTER_LOG_FILE_NAME = 'computer.log'

/** An appender for `<stateDir>/logs/computer.log`; a no-op when it cannot be opened. */
export function createComputerFileLog(
  stateDir: string,
  opts: { maxBytes?: number } = {}
): (line: string) => void {
  return createRotatingFileLog(join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME), {
    maxBytes: opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES
  })
}

/**
 * A computer process's log: each line `[tag] message {meta}` to stdout (its
 * launcher's log), and `[tag pid] message {meta}`, timestamped, to
 * `<stateDir>/logs/computer.log`. The file is shared by every process that runs the
 * computer (launcher, supervisor, worker, session host), so each line names its writer:
 * without it a restart loop cannot be told apart from two processes running at once.
 */
export function createComputerLog(opts: {
  stateDir: string
  tag: string
  /** Default: this process's stdout. */
  stdout?: (text: string) => void
  maxBytes?: number
}): (message: string, meta?: Record<string, unknown>) => void {
  const fileLog = createComputerFileLog(opts.stateDir, { maxBytes: opts.maxBytes })
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text))
  return (message, meta) => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
    stdout(`[${opts.tag}] ${message}${suffix}\n`)
    fileLog(`[${opts.tag} ${process.pid}] ${message}${suffix}`)
  }
}

/**
 * One line appended to `<stateDir>/logs/computer.log` SYNCHRONOUSLY — for a process's
 * last words (a fatal error, its exit), which an async stream would lose: the process
 * is gone before the stream flushes. Never throws.
 */
export function appendComputerLogSync(stateDir: string, line: string): void {
  try {
    const dir = join(stateDir, COMPUTER_LOG_DIR_NAME)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, COMPUTER_LOG_FILE_NAME), `${new Date().toISOString()} ${line}\n`, {
      mode: 0o600
    })
  } catch {
    /* a log that cannot be written must not change how the process ends */
  }
}

/** The subset of `process` {@link installProcessFateLog} listens on (a fake in tests). */
export interface FateLoggedProcess {
  pid: number
  on(event: 'uncaughtExceptionMonitor', fn: (err: Error, origin: string) => void): unknown
  on(event: 'exit', fn: (code: number) => void): unknown
}

/**
 * Records how a computer process ends, in `computer.log`: every fatal error (an
 * uncaught exception, or an unhandled rejection Node turns into one) with its stack,
 * and the exit code. Before, both reached only stderr — an untimestamped `host.log`
 * or the journal — so a crash loop showed in `computer.log` only as boot lines
 * repeating every 2 s, with no reason (2026-11-23: ~1,560 restarts an hour for 10
 * hours, cause `EADDRINUSE` visible only in a 32 MB `host.log`).
 *
 * Observes only: `uncaughtExceptionMonitor` does not change what Node does with the
 * error (the process still prints it and exits), and `exit` cannot delay the exit.
 * A SIGKILL (the OOM killer) leaves no line here — the process that started this one
 * logs that exit (the launcher, the upgrade supervisor; systemd's `ExecStopPost`).
 */
export function installProcessFateLog(opts: {
  stateDir: string
  tag: string
  proc?: FateLoggedProcess
  now?: () => number
}): void {
  const proc = opts.proc ?? (process as unknown as FateLoggedProcess)
  const now = opts.now ?? Date.now
  const startedAt = now()
  const write = (message: string, meta: Record<string, unknown>): void =>
    appendComputerLogSync(
      opts.stateDir,
      `[${opts.tag} ${proc.pid}] ${message} ${JSON.stringify(meta)}`
    )
  proc.on('uncaughtExceptionMonitor', (err, origin) => {
    write('fatal error', {
      origin,
      error: err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err),
      ...(err && typeof err === 'object' && 'code' in err ? { code: String(err.code) } : {})
    })
  })
  proc.on('exit', (code) => {
    write('process exit', { code, uptimeMs: now() - startedAt })
  })
}
