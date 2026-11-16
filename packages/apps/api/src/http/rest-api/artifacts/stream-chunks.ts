import { once } from 'node:events'
import type { Response } from 'express'

/** Stream with backpressure; disconnect cancels drain and unwinds the reader. */
export async function streamChunks(
  res: Response,
  chunks: AsyncIterable<Uint8Array>
): Promise<void> {
  const controller = new AbortController()
  const closed = () => controller.abort()
  res.once('close', closed)
  if (res.destroyed) closed()
  try {
    for await (const chunk of chunks) {
      if (controller.signal.aborted) return
      if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal })
    }
    if (!res.destroyed) res.end()
  } catch (err) {
    // A normal client disconnect cannot drain and has no response to report to.
    if (controller.signal.aborted || res.destroyed) return
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)))
      return
    }
    throw err
  } finally {
    res.off('close', closed)
    controller.abort()
  }
}
