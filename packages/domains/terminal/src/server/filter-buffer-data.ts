import { stripDeviceStatusQueries } from '@slayzone/platform'
import { stripUnderlineCodes } from '@slayzone/terminal/shared'

/**
 * Filter out terminal escape sequences that must not enter the replayable
 * buffer. Strips OSC title/clipboard sequences, SGR 4 (underline) codes, and
 * device-status QUERIES.
 *
 * Queries are stripped because the buffer is replayed into a live xterm.js on
 * every mount/reattach, and xterm answers every query it sees — those answers
 * are then forwarded to the running process as if the user had typed them. The
 * server is the sole authority for answering queries (synchronously, see
 * `computeSyncQueryResponse`), so a query in stored history is pure liability.
 * See `stripDeviceStatusQueries` for the `/clear`-loop this caused.
 */
export function filterBufferData(data: string): string {
  return stripDeviceStatusQueries(
    stripUnderlineCodes(
      data
        // Strip title-setting (0,1,2) and clipboard (52) OSC sequences
        .replace(/\x1b\](?:[012]|52)[;][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    )
  )
}
