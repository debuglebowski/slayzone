/**
 * Keystrokes in the order they were typed, across the direct link and the hub
 * (docs/direct-link.md).
 *
 * A direct write that does not land (no answer in time, refused, not taken) is sent
 * again through the hub, seconds later. A key typed meanwhile must not overtake it on
 * the direct socket. So:
 *  - a direct write goes out only when nothing else is in flight for the session;
 *    keys typed while it is in flight wait, and go next as ONE write (no throughput
 *    is lost to the wait);
 *  - hub writes pipeline as they always did (one ordered socket, no fallback), but a
 *    write on the other path waits until the in-flight ones settled.
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
  let inflight = 0
  let inflightPath: PtyWritePath | null = null

  function pump(): void {
    if (queue.length === 0) return
    const path: PtyWritePath = opts.isDirect() ? 'direct' : 'hub'
    if (inflight > 0 && (path === 'direct' || inflightPath !== path)) return
    const batch = queue.splice(0)
    inflight++
    inflightPath = path
    opts
      .send(path, batch.map((w) => w.data).join(''))
      .then(
        (written) => {
          for (const w of batch) w.resolve(written)
        },
        (err: unknown) => {
          for (const w of batch) w.reject(err)
        }
      )
      .finally(() => {
        inflight--
        if (inflight === 0) inflightPath = null
        pump()
      })
  }

  return {
    write(data) {
      return new Promise<boolean>((resolve, reject) => {
        queue.push({ data, resolve, reject })
        pump()
      })
    },
    idle: () => queue.length === 0 && inflight === 0
  }
}
