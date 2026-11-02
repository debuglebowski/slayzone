import type { IncomingMessage } from 'node:http'
/** Computer chat files cross the hub in bounded memory, never a staging file. */
export async function readRelayBytes(req: IncomingMessage, max = 10_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > max) throw new Error('Computer chat file exceeds the 10 MB transfer limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}
