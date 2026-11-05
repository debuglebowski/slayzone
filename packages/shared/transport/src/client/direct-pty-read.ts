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

type DirectClient = Pick<TRPCClient<DirectRouter>, 'pty'>

async function readOn(
  client: DirectClient,
  sessionId: string,
  first: DirectBuffer
): Promise<DirectBuffer> {
  const chunks = [...first.chunks]
  let page = first
  let currentSeq = first.currentSeq
  for (let i = 0; page.more && i < MAX_PAGES; i++) {
    const last = chunks.at(-1)
    if (!last) break
    page = await client.pty.getBufferSince.query({
      sessionId,
      afterSeq: last.seq,
      maxChars: DIRECT_BUFFER_PAGE_CHARS
    })
    // Seq order is kept even if a page repeats a chunk it already gave.
    for (const c of page.chunks) if (c.seq > (chunks.at(-1)?.seq ?? -1)) chunks.push(c)
    currentSeq = Math.max(currentSeq, page.currentSeq)
  }
  return { chunks, currentSeq, prelude: first.prelude, more: false }
}

/** `pty.getBufferSince` over the direct link, every page joined. */
export async function readDirectPtyBuffer(
  client: DirectClient,
  sessionId: string,
  afterSeq: number
): Promise<DirectBuffer> {
  const first = await client.pty.getBufferSince.query({
    sessionId,
    afterSeq,
    maxChars: DIRECT_BUFFER_PAGE_CHARS
  })
  return readOn(client, sessionId, first)
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
  return { ...attached, buffer: await readOn(client, sessionId, attached.buffer) }
}
