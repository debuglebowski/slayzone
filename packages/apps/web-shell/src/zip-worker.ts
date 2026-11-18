// The web shell's zip worker: runs the shared streaming zip encoder
// (@slayzone/task-artifacts/zip-stream, deflating with fflate) off the page's thread.
// One request at a time from WorkerZipSink (client-save.ts); each reply carries the
// archive bytes that request produced, transferred, not copied.
import { createZipEncoder, type ZipEncoder } from '@slayzone/task-artifacts/zip-stream'
import type { ZipWorkerReply, ZipWorkerRequest } from './client-save'
import { fflateDeflater } from './fflate-deflater'

let encoder: ZipEncoder | null = null
let produced: Uint8Array[] = []
/** Requests are handled in arrival order, each after the one before it has replied. */
let queue: Promise<void> = Promise.resolve()

async function handle(req: ZipWorkerRequest): Promise<void> {
  try {
    encoder ??= createZipEncoder((chunk) => produced.push(chunk), { deflater: fflateDeflater })
    if (req.op === 'write') await encoder.write(req.path, req.data, req.size)
    else if (req.op === 'mkdir') await encoder.mkdir(req.path)
    else await encoder.finish()
    // Each chunk on its own buffer, so each can be transferred exactly once.
    const out = produced.map((c) =>
      c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()
    )
    produced = []
    const reply: ZipWorkerReply = { seq: req.seq, out }
    ;(self as unknown as Worker).postMessage(
      reply,
      out.map((c) => c.buffer as ArrayBuffer)
    )
  } catch (err) {
    const reply: ZipWorkerReply = {
      seq: req.seq,
      out: [],
      error: err instanceof Error ? err.message : String(err)
    }
    ;(self as unknown as Worker).postMessage(reply)
  }
}

self.onmessage = (event: MessageEvent<ZipWorkerRequest>) => {
  const req = event.data
  queue = queue.then(() => handle(req))
}
