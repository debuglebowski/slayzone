// The web shell's deflater for the shared zip encoder (@slayzone/task-artifacts/zip-stream):
// fflate, synchronous — the encoder runs in a worker (zip-worker.ts), off the page's thread.
import type { Deflater } from '@slayzone/task-artifacts/zip-stream'
import { Deflate } from 'fflate'

export function fflateDeflater(): Deflater {
  let out: Uint8Array[] = []
  const d = new Deflate({ level: 6 }, (chunk) => {
    out.push(chunk)
  })
  return {
    push(data, final) {
      d.push(data, final)
      const produced = out
      out = []
      return produced
    }
  }
}
