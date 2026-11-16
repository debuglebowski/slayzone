// The web shell's zip worker: runs the streaming zip encoder (zip-stream.ts) off the
// page's thread. One request at a time from WorkerZipSink (client-save.ts); each reply
// carries the archive bytes that request produced, transferred, not copied.
import { createZipEncoder, fflateDeflater, type ZipEncoder } from './zip-stream'
import type { ZipWorkerReply, ZipWorkerRequest } from './client-save'

let encoder: ZipEncoder | null = null
let produced: Uint8Array[] = []

self.onmessage = (event: MessageEvent<ZipWorkerRequest>) => {
  const req = event.data
  try {
    encoder ??= createZipEncoder((chunk) => produced.push(chunk), { deflater: fflateDeflater })
    if (req.op === 'write') encoder.write(req.path, req.data, req.size)
    else if (req.op === 'mkdir') encoder.mkdir(req.path)
    else encoder.finish()
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
