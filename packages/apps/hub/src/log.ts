import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024 // rotate at 5 MB

/**
 * Creates a file logger writing to `<dataRoot>/logs/sidecar.log`.
 *
 * Verbose side-car logging goes here, NOT stdout — so the supervisor's stdout
 * pipe never fills + deadlocks (back-pressure risk). stdout/stderr carry only
 * the startup banner + fatal errors. The returned fn never throws.
 */
export function createLogger(dataRoot: string): (line: string) => void {
  const dir = path.join(dataRoot, 'logs')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sidecar.log')
  // Size-based rotation: sidecar.log → sidecar.log.1 on overflow.
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    /* rotation is best-effort */
  }
  const stream = createWriteStream(file, { flags: 'a' })
  return (line: string) => {
    try {
      stream.write(`${new Date().toISOString()} ${line}\n`)
    } catch {
      /* never throw into a caller */
    }
  }
}
