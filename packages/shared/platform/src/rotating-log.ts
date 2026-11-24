/**
 * A long-running process's log file, rotated by size WHILE it runs (one older
 * generation kept: `x.log` → `x.log.1`). Shared by the computer (`computer.log`) and
 * the hub (`sidecar.log`): both run for weeks, and a log rotated only when it is
 * opened grows without bound in between.
 *
 * Several processes may append to the same file (the computer's supervisor, worker and
 * session host all write `computer.log`). So each writer judges the file by what is AT
 * the path, not by its own byte count: it stats the path before every line, follows a
 * rotation another writer made (reopens instead of renaming again, which would push
 * that writer's fresh file over the older generation), and rotates only the file it
 * actually has open.
 *
 * Never throws: a full disk or an unwritable dir must not fail the process logging.
 *
 * @module platform/rotating-log
 */
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * `path` → `path.1` when it is larger than `maxBytes` (the older `.1` goes). For a
 * log a process appends to from its start (`host.log`): call before opening it.
 * Never throws.
 */
export function rotateLogFile(path: string, maxBytes = DEFAULT_LOG_MAX_BYTES): void {
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`)
  } catch {
    /* a log that cannot be rotated is appended to as it is */
  }
}

interface OpenLog {
  stream: WriteStream
  ino: number
}

/**
 * An appender for `file`: each line timestamped, rotated past `maxBytes` while
 * running. A no-op when the file cannot be opened.
 */
export function createRotatingFileLog(
  file: string,
  opts: { maxBytes?: number; mode?: number } = {}
): (line: string) => void {
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES
  const mode = opts.mode ?? 0o600
  // Opened synchronously so the inode is known before the first write, and a rename
  // can never race a still-pending open onto the new file's name.
  const open = (): OpenLog => {
    const fd = openSync(file, 'a', mode)
    try {
      const ino = fstatSync(fd).ino
      const stream = createWriteStream('', { fd, flags: 'a' })
      stream.on('error', () => undefined)
      return { stream, ino }
    } catch (err) {
      closeSync(fd)
      throw err
    }
  }
  const sizeAtPath = (): { size: number; ino: number } | null => {
    try {
      const st = statSync(file)
      return { size: st.size, ino: st.ino }
    } catch {
      return null
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    rotateLogFile(file, maxBytes)
    let current = open()
    let ownSize = sizeAtPath()?.size ?? 0
    let ownIno = current.ino
    const reopen = () => {
      current.stream.end()
      current = open()
    }
    return (line) => {
      try {
        const text = `${new Date().toISOString()} ${line}\n`
        const bytes = Buffer.byteLength(text)
        let atPath = sizeAtPath()
        if (!atPath || atPath.ino !== current.ino) {
          // Another writer rotated (or removed) it: follow, don't rotate again.
          reopen()
          atPath = sizeAtPath()
        }
        // `ownSize` counts this writer's own queued bytes too (written by descriptor,
        // not yet on disk); the path's size counts every other writer's.
        const size = Math.max(atPath?.size ?? 0, ownSize)
        if (size > 0 && size + bytes > maxBytes) {
          try {
            renameSync(file, `${file}.1`)
          } catch {
            /* not rotated: the new stream appends to the same file */
          }
          reopen()
        }
        current.stream.write(text)
        ownSize = (ownIno === current.ino ? ownSize : 0) + bytes
        ownIno = current.ino
      } catch {
        /* never throw into a caller */
      }
    }
  } catch {
    return () => undefined
  }
}
