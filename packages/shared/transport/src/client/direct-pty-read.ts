/**
 * Reading a terminal's backfill over the direct link in pages (docs/direct-link.md).
 *
 * Every direct-protocol message must fit a WebRTC data channel's message cap, and a
 * full scrollback serialises past it (JSON writes each ESC as `\u001b`). So a read
 * asks for at most {@link DIRECT_BUFFER_PAGE_CHARS} per answer and reads on from the
 * last chunk's seq until the computer says there is no more. The first page keeps
 * the cold-replay prelude; later pages are verbatim, so the joined result is what
 * one whole read would have returned. A chunk evicted between pages is simply not
 * there, as it would not be for a later whole read.
 *
 * @module transport/client/direct-pty-read
 */
import type { TRPCClient } from '@trpc/client'
import type { DirectBuffer, DirectRouter } from '../direct/router'

/**
 * Page bound, in estimated serialised characters: a quarter of the channel's 1 MiB
 * message cap, leaving room for the envelope and superjson.
 */
export const DIRECT_BUFFER_PAGE_CHARS = 256 * 1024

/** Upper bound on pages per read (a 750 KiB buffer, fully escaped, is ~20). */
const MAX_PAGES = 1_000

/** Times a read starts over after the scrollback evicted under it (see `readOn`). */
const MAX_RESYNCS = 3

type DirectClient = Pick<TRPCClient<DirectRouter>, 'pty'>

type PageRead = (afterSeq: number) => Promise<DirectBuffer>

/**
 * Pages after `first` until the computer says there is no more. Gap-aware: each page
 * must start right after the last chunk read. One that starts later means the
 * scrollback evicted those chunks between the two reads; the read then starts over
 * from `restartAfter` (the oldest chunk kept onward), up to {@link MAX_RESYNCS}
 * times. Never returns a hole: if output keeps outrunning the read, it returns the
 * contiguous part it has (the caller's live stream and gap backfill go on from there).
 */
async function readOn(
  readPage: PageRead,
  first: DirectBuffer,
  restartAfter: number
): Promise<DirectBuffer> {
  let start = first
  for (let attempt = 0; ; attempt++) {
    const chunks = [...start.chunks]
    let page = start
    let currentSeq = start.currentSeq
    let dropped = false
    for (let i = 0; page.more && i < MAX_PAGES; i++) {
      const last = chunks.at(-1)
      if (!last) break
      page = await readPage(last.seq)
      const head = page.chunks[0]
      if (head && head.seq > last.seq + 1) {
        dropped = true
        break
      }
      // Seq order is kept even if a page repeats a chunk it already gave.
      for (const c of page.chunks) if (c.seq > (chunks.at(-1)?.seq ?? -1)) chunks.push(c)
      currentSeq = Math.max(currentSeq, page.currentSeq)
    }
    if (!dropped) return { chunks, currentSeq, prelude: start.prelude, more: false }
    if (attempt >= MAX_RESYNCS) {
      // Contiguous up to the hole, and it says where it stops.
      const end = chunks.at(-1)?.seq ?? currentSeq
      return { chunks, currentSeq: end, prelude: start.prelude, more: false }
    }
    start = await readPage(restartAfter)
  }
}

/** `pty.getBufferSince` over the direct link, every page joined. */
export async function readDirectPtyBuffer(
  client: DirectClient,
  sessionId: string,
  afterSeq: number
): Promise<DirectBuffer> {
  const readPage: PageRead = (after) =>
    client.pty.getBufferSince.query({
      sessionId,
      afterSeq: after,
      maxChars: DIRECT_BUFFER_PAGE_CHARS
    })
  return readOn(readPage, await readPage(afterSeq), afterSeq)
}

/** `pty.attach` over the direct link, its buffer read in full (paged). */
export async function attachDirectPty(
  client: DirectClient,
  sessionId: string,
  afterSeq: number
): Promise<{
  exists: boolean
  size: { cols: number; rows: number } | null
  buffer: DirectBuffer
}> {
  const attached = await client.pty.attach.query({
    sessionId,
    afterSeq,
    maxChars: DIRECT_BUFFER_PAGE_CHARS
  })
  const readPage: PageRead = (after) =>
    client.pty.getBufferSince.query({
      sessionId,
      afterSeq: after,
      maxChars: DIRECT_BUFFER_PAGE_CHARS
    })
  return { ...attached, buffer: await readOn(readPage, attached.buffer, afterSeq) }
}
