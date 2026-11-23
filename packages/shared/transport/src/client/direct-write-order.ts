/**
 * Keystrokes in the order they were typed, across the direct link and the hub
 * (docs/direct-link.md).
 *
 * Each write waits for the previous one to settle. A direct write can fall back
 * through the hub, and async hub checks can reorder requests from an ordered
 * socket. Input typed during the wait goes next as one write.
 *
 * Each caller's promise settles with the write that carried its data.
 *
 * @module transport/client/direct-write-order
 */

export type PtyWritePath = 'direct' | 'hub'

export interface OrderedPtyWriterOptions {
  /** Whether the session is on the direct link now. */
  isDirect(): boolean
  /**
   * Deliver `data` starting on `path` (a direct write falls back to the hub inside
   * this call). Resolves with whether it was written.
   */
  send(path: PtyWritePath, data: string): Promise<boolean>
}

export interface OrderedPtyWriter {
  write(data: string): Promise<boolean>
  /** Nothing queued or in flight (the holder may drop it). */
  idle(): boolean
}

interface Waiting {
  data: string
  resolve: (written: boolean) => void
  reject: (err: unknown) => void
}

export function createOrderedPtyWriter(opts: OrderedPtyWriterOptions): OrderedPtyWriter {
  const queue: Waiting[] = []
  let inFlight = false

  async function pump(): Promise<void> {
    if (inFlight || queue.length === 0) return
    const path: PtyWritePath = opts.isDirect() ? 'direct' : 'hub'
    const batch = queue.splice(0)
    inFlight = true
    try {
      const written = await opts.send(path, batch.map((w) => w.data).join(''))
      for (const write of batch) write.resolve(written)
    } catch (error) {
      for (const write of batch) write.reject(error)
    } finally {
      inFlight = false
      void pump()
    }
  }

  return {
    write(data) {
      return new Promise<boolean>((resolve, reject) => {
        queue.push({ data, resolve, reject })
        void pump()
      })
    },
    idle: () => queue.length === 0 && !inFlight
  }
}
