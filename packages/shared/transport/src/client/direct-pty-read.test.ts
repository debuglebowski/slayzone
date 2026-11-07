/**
 * Paged direct backfill (docs/direct-link.md), L1: the scrollback can evict chunks
 * between two page reads. The read must notice the hole and read again from the
 * oldest chunk still kept, never hand back a scrollback with a hole in the middle.
 */
import { describe, expect, it, vi } from 'vitest'
import { pageChunks } from '../direct/router'
import { DIRECT_CALL_DEADLINE_MS, DirectDeadlineError } from './direct-call'
import { attachDirectPty, readDirectPtyBuffer } from './direct-pty-read'

/** A computer buffer: chunks seq 0..n-1; `evict` drops the oldest, as the ring does. */
function fakeBuffer(n: number, size = 100_000) {
  let chunks = Array.from({ length: n }, (_, seq) => ({ seq, data: 'x'.repeat(size) }))
  let next = n
  let onPage: ((page: number) => void) | null = null
  let pages = 0
  const read = (afterSeq: number, maxChars?: number) => {
    const all = chunks.filter((c) => c.seq > afterSeq)
    const page = pageChunks(all, maxChars)
    pages++
    onPage?.(pages)
    return {
      chunks: page.chunks,
      more: page.more,
      prelude: afterSeq === -1 && chunks[0]!.seq > 0 ? 'PRELUDE' : '',
      currentSeq: chunks.at(-1)!.seq
    }
  }
  return {
    client: {
      pty: {
        getBufferSince: {
          query: async (i: { afterSeq: number; maxChars?: number }) => read(i.afterSeq, i.maxChars)
        }
      }
    } as never,
    /** Output arrives: `k` new chunks, the same number of oldest ones evicted. */
    churn(k: number) {
      for (let i = 0; i < k; i++) chunks.push({ seq: next++, data: 'y'.repeat(size) })
      chunks = chunks.slice(k)
    },
    whenPage(cb: (page: number) => void) {
      onPage = cb
    },
    seqs: () => chunks.map((c) => c.seq)
  }
}

const contiguous = (seqs: number[]) => seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)

describe('readDirectPtyBuffer', () => {
  it('reads every page of a large buffer, in order', async () => {
    const b = fakeBuffer(10)
    const out = await readDirectPtyBuffer(b.client, 's', -1)
    expect(out.chunks.map((c) => c.seq)).toEqual(b.seqs())
  })

  it('evictions between pages never leave a hole: it reads again from the oldest kept', async () => {
    const b = fakeBuffer(10)
    // After the first page, a burst of output evicts past what that page ended on.
    b.whenPage((page) => {
      if (page === 1) b.churn(6)
    })
    const out = await readDirectPtyBuffer(b.client, 's', -1)
    const seqs = out.chunks.map((c) => c.seq)
    expect(contiguous(seqs)).toBe(true)
    expect(seqs).toEqual(b.seqs())
    // A cold read starts after an eviction: the replay prelude comes with it.
    expect(out.prelude).toBe('PRELUDE')
  })

  it('output faster than the read: what it returns is still contiguous', async () => {
    const b = fakeBuffer(10)
    b.whenPage(() => b.churn(6))
    const out = await readDirectPtyBuffer(b.client, 's', -1)
    expect(contiguous(out.chunks.map((c) => c.seq))).toBe(true)
  })
})

describe('direct reads have a deadline per call, not per read', () => {
  it('a page that never answers fails the read once its own deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const b = fakeBuffer(10)
      const real = (b.client as { pty: { getBufferSince: { query: (i: never) => unknown } } }).pty
        .getBufferSince.query
      let n = 0
      ;(b.client as { pty: { getBufferSince: { query: unknown } } }).pty.getBufferSince.query = (
        i: never
      ) => (++n === 2 ? new Promise(() => undefined) : real(i))
      const read = readDirectPtyBuffer(b.client, 's', -1)
      const outcome = read.then(
        () => 'resolved',
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(DIRECT_CALL_DEADLINE_MS + 1)
      expect(await outcome).toBeInstanceOf(DirectDeadlineError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a slow multi-page read still completes when each page answers in time', async () => {
    vi.useFakeTimers()
    try {
      const b = fakeBuffer(10)
      const pty = (b.client as { pty: { getBufferSince: { query: (i: never) => unknown } } }).pty
      const real = pty.getBufferSince.query
      pty.getBufferSince.query = (i: never) =>
        new Promise((r) => setTimeout(() => r(real(i)), DIRECT_CALL_DEADLINE_MS - 500))
      const read = readDirectPtyBuffer(b.client, 's', -1)
      await vi.advanceTimersByTimeAsync(DIRECT_CALL_DEADLINE_MS * 20)
      expect((await read).chunks.map((c) => c.seq)).toEqual(b.seqs())
    } finally {
      vi.useRealTimers()
    }
  })

  it('an attach that never answers fails once its deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const client = {
        pty: { attach: { query: () => new Promise(() => undefined) } }
      } as never
      const outcome = attachDirectPty(client, 's', -1).then(
        () => 'resolved',
        (err: unknown) => err
      )
      await vi.advanceTimersByTimeAsync(DIRECT_CALL_DEADLINE_MS + 1)
      expect(await outcome).toBeInstanceOf(DirectDeadlineError)
    } finally {
      vi.useRealTimers()
    }
  })
})
