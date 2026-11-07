/**
 * Gap-aware, seq-ordered delivery of a session's output — what makes switching a
 * terminal between the hub relay and the direct link gap-free (docs/direct-link.md).
 */
import { describe, expect, it } from 'vitest'
import { createPtyDelivery } from './pty-delivery'

function setup() {
  const out: Array<[number, string]> = []
  const fetched: number[] = []
  let answer: Array<{ seq: number; data: string }> = []
  let release: (() => void) | null = null
  const d = createPtyDelivery({ emit: (_id, data, seq) => out.push([seq, data]) })
  const backfill = (afterSeq: number) => {
    fetched.push(afterSeq)
    return new Promise<Array<{ seq: number; data: string }>>((resolve) => {
      release = () => resolve(answer)
    })
  }
  return {
    d,
    out,
    fetched,
    backfill,
    answer: (a: typeof answer) => {
      answer = a
    },
    release: async () => {
      release?.()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

describe('pty delivery', () => {
  it('delivers in order and drops what was already delivered (two streams may overlap)', () => {
    const { d, out, backfill } = setup()
    d.open('s')
    d.deliver('s', 'a', 0, backfill)
    d.deliver('s', 'b', 1, backfill)
    d.deliver('s', 'b', 1, backfill)
    d.deliver('s', 'a', 0, backfill)
    expect(out).toEqual([
      [0, 'a'],
      [1, 'b']
    ])
  })

  it('ignores a session nobody opened', () => {
    const { d, out, backfill } = setup()
    d.deliver('nope', 'x', 0, backfill)
    expect(out).toEqual([])
  })

  it('takes the first chunk as the start, whatever its seq (attach wrote what came before)', () => {
    const { d, out, backfill, fetched } = setup()
    d.open('s')
    d.deliver('s', 'x', 40, backfill)
    expect(out).toEqual([[40, 'x']])
    expect(fetched).toEqual([])
  })

  it('holds chunks past a gap, backfills the gap once, then continues in order', async () => {
    const { d, out, backfill, fetched, answer, release } = setup()
    d.open('s')
    d.deliver('s', 'a', 0, backfill)
    d.deliver('s', 'd', 3, backfill)
    d.deliver('s', 'e', 4, backfill)
    expect(out).toEqual([[0, 'a']])
    expect(fetched).toEqual([0])
    answer([
      { seq: 1, data: 'b' },
      { seq: 2, data: 'c' },
      { seq: 3, data: 'd' }
    ])
    await release()
    expect(out.map(([s]) => s)).toEqual([0, 1, 2, 3, 4])
  })

  it('moves on when the gap cannot be filled (evicted), rather than stalling', async () => {
    const { d, out, backfill, release } = setup()
    d.open('s')
    d.deliver('s', 'a', 0, backfill)
    d.deliver('s', 'z', 9, backfill)
    await release()
    expect(out).toEqual([
      [0, 'a'],
      [9, 'z']
    ])
  })

  it('reset forgets the session’s position (mode switch, respawn)', () => {
    const { d, out, backfill } = setup()
    d.open('s')
    d.deliver('s', 'a', 5, backfill)
    d.reset('s')
    d.open('s')
    d.deliver('s', 'b', 0, backfill)
    expect(out.map(([s]) => s)).toEqual([5, 0])
    expect(d.lastSeq('s')).toBe(0)
  })
})

describe('the terminal’s own attach position', () => {
  it('a chunk past what attach wrote backfills the gap instead of being taken as the start', async () => {
    const { d, out, backfill, fetched, answer, release } = setup()
    d.open('s')
    d.advance('s', 10) // attach wrote up to seq 10
    d.deliver('s', 'x', 13, backfill)
    expect(fetched).toEqual([10])
    answer([
      { seq: 11, data: 'k' },
      { seq: 12, data: 'l' }
    ])
    await release()
    expect(out.map(([s]) => s)).toEqual([11, 12, 13])
  })

  it('never moves backwards, and drops what attach already wrote', () => {
    const { d, out, backfill } = setup()
    d.open('s')
    d.deliver('s', 'a', 5, backfill)
    d.advance('s', 3)
    expect(d.lastSeq('s')).toBe(5)
    d.advance('s', 8)
    d.deliver('s', 'old', 7, backfill)
    d.deliver('s', 'next', 9, backfill)
    expect(out.map(([s]) => s)).toEqual([5, 9])
  })
})
