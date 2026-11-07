/**
 * After a computer reconnect the desktop terminal catches up from the scrollback
 * (`getBufferSince`) while live output keeps arriving. Live chunks that landed
 * during the await were written, then written again from the catch-up — duplicated
 * and out of order, with the rendered seq moving backwards. The two streams are
 * merged by seq: each chunk once, in order, nothing at or below what is rendered.
 */
import { describe, expect, it } from 'vitest'
import { mergeCatchUp } from './catch-up-merge'

const c = (seq: number) => ({ seq, data: `<${seq}>` })

describe('mergeCatchUp', () => {
  it('live chunks held during the catch-up are written once, in seq order', () => {
    expect(mergeCatchUp(100, [c(101), c(102), c(103)], [c(103), c(104)], null)).toEqual([
      c(101),
      c(102),
      c(103),
      c(104)
    ])
  })

  it('nothing at or below the rendered seq, nothing at or below a clear', () => {
    expect(mergeCatchUp(102, [c(101), c(102), c(103)], [], null)).toEqual([c(103)])
    expect(mergeCatchUp(-1, [c(1), c(2), c(3)], [c(4)], 2)).toEqual([c(3), c(4)])
  })

  it('no missed chunks: the held live ones still come through', () => {
    expect(mergeCatchUp(5, [], [c(6), c(7)], null)).toEqual([c(6), c(7)])
  })
})
