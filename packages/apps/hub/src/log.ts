import path from 'node:path'
import { createRotatingFileLog } from '@slayzone/platform/rotating-log'

/**
 * Creates a file logger writing to `<dataRoot>/logs/sidecar.log`.
 *
 * Verbose side-car logging goes here, NOT stdout — so the supervisor's stdout
 * pipe never fills + deadlocks (back-pressure risk). stdout/stderr carry only
 * the startup banner + fatal errors. The returned fn never throws.
 *
 * Rotated at 5 MB WHILE running (`sidecar.log` → `sidecar.log.1`): a hub runs for
 * weeks, and rotating only at boot let the file grow without bound in between.
 */
export function createLogger(dataRoot: string): (line: string) => void {
  // 0o644: the mode it always had (a default-mode stream under the usual umask).
  return createRotatingFileLog(path.join(dataRoot, 'logs', 'sidecar.log'), {
    mode: 0o644
  })
}
