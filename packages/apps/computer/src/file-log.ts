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
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'

export const COMPUTER_LOG_DIR_NAME = 'logs'
export const COMPUTER_LOG_FILE_NAME = 'computer.log'
const MAX_BYTES = 5 * 1024 * 1024

/**
 * `path` → `path.1` when it is larger than `maxBytes` (the older `.1` goes). For a
 * log a process appends to from its start (`host.log`): call before opening it.
 * Never throws.
 */
export function rotateLogFile(path: string, maxBytes = MAX_BYTES): void {
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`)
  } catch {
    /* a log that cannot be rotated is appended to as it is */
  }
}

/** An appender for `<stateDir>/logs/computer.log`; a no-op when it cannot be opened. */
export function createComputerFileLog(
  stateDir: string,
  opts: { maxBytes?: number } = {}
): (line: string) => void {
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  try {
    const dir = join(stateDir, COMPUTER_LOG_DIR_NAME)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, COMPUTER_LOG_FILE_NAME)
    rotateLogFile(file, maxBytes)
    let size = existsSync(file) ? statSync(file).size : 0
    const open = (): WriteStream => {
      const stream = createWriteStream(file, { flags: 'a', mode: 0o600 })
      stream.on('error', () => undefined)
      return stream
    }
    let stream = open()
    return (line) => {
      try {
        const text = `${new Date().toISOString()} ${line}\n`
        // Past its size: the open stream keeps writing what it holds into the renamed
        // file (it writes by descriptor), the next line starts the new one. Only once
        // the stream has its file open (`pending`: not yet — a rename then would send
        // its queued lines to the new file's name).
        if (size > 0 && size + Buffer.byteLength(text) > maxBytes && !stream.pending) {
          try {
            renameSync(file, `${file}.1`)
          } catch {
            /* not rotated: the new stream appends to the same file */
          }
          stream.end()
          stream = open()
          size = 0
        }
        stream.write(text)
        size += Buffer.byteLength(text)
      } catch {
        /* never throw into a caller */
      }
    }
  } catch {
    return () => undefined
  }
}

/**
 * A computer process's log: each line `[tag] message {meta}` to stdout (its
 * launcher's log), and `message {meta}`, timestamped, to `<stateDir>/logs/computer.log`.
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
    fileLog(`${message}${suffix}`)
  }
}
