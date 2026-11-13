/**
 * The computer's own log file: `<stateDir>/logs/computer.log`, rotated by size.
 *
 * Its stdout goes to whoever launched it — on the desktop, the app's supervisor,
 * which drops it unless `SLAYZONE_DEBUG_BOOT=1`. So until now nothing the computer
 * said reached anywhere durable: on 2026-11-11 an agent restore took ~3 min and
 * there was no record of how long each start waited for its slot. Every line the
 * computer logs is now also appended here (the hub has its `sidecar.log`).
 *
 * Never throws: a full disk or unwritable dir must not fail the computer.
 *
 * @module computer/file-log
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const COMPUTER_LOG_DIR_NAME = 'logs'
export const COMPUTER_LOG_FILE_NAME = 'computer.log'
const MAX_BYTES = 5 * 1024 * 1024

/** An appender for `<stateDir>/logs/computer.log`; a no-op when it cannot be opened. */
export function createComputerFileLog(stateDir: string): (line: string) => void {
  try {
    const dir = join(stateDir, COMPUTER_LOG_DIR_NAME)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, COMPUTER_LOG_FILE_NAME)
    // One generation kept: computer.log → computer.log.1 when over the size.
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    const stream = createWriteStream(file, { flags: 'a', mode: 0o600 })
    stream.on('error', () => undefined)
    return (line) => {
      try {
        stream.write(`${new Date().toISOString()} ${line}\n`)
      } catch {
        /* never throw into a caller */
      }
    }
  } catch {
    return () => undefined
  }
}
