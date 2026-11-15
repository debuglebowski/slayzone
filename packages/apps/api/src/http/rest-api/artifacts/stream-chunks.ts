import { once } from 'node:events'
import type { Response } from 'express'

/**
 * Write `chunks` to `res` as they arrive, honouring back-pressure, then end it —
 * a computer-held artifact streamed range by range, never assembled on the hub.
 * The caller set the status and headers (incl. content-length). A failure after
 * bytes went out can only cut the response: the socket is destroyed so the client
 * sees a short body, never a silently truncated "complete" one.
 */
export async function streamChunks(
  res: Response,
  chunks: AsyncIterable<Uint8Array>
): Promise<void> {
  try {
    for await (const chunk of chunks) {
      if (!res.write(chunk)) await once(res, 'drain')
    }
    res.end()
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)))
      return
    }
    throw err
  }
}
