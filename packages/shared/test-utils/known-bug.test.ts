import { afterEach, describe, expect, it } from 'vitest'
import { expectKnownBug } from './known-bug'

const BUG = { audit: '#9', fixedBy: '9.9', what: 'something is still broken' }
const saved = process.env.REVEAL_KNOWN_BUGS

afterEach(() => {
  if (saved === undefined) delete process.env.REVEAL_KNOWN_BUGS
  else process.env.REVEAL_KNOWN_BUGS = saved
})

describe('expectKnownBug', () => {
  it('stays green while the assertion still fails (sync and async)', async () => {
    delete process.env.REVEAL_KNOWN_BUGS
    await expectKnownBug(BUG, () => expect(1).toBe(2))
    await expectKnownBug(BUG, async () => expect(await Promise.resolve(1)).toBe(2))
  })

  it('fails once the bug is fixed, naming the plan item', async () => {
    delete process.env.REVEAL_KNOWN_BUGS
    await expect(expectKnownBug(BUG, () => expect(1).toBe(1))).rejects.toThrow(
      /KNOWN BUG FIXED \(audit #9: something is still broken\) — plan item 9\.9/
    )
  })

  it('REVEAL_KNOWN_BUGS=1 lets the real failure through', async () => {
    process.env.REVEAL_KNOWN_BUGS = '1'
    await expect(expectKnownBug(BUG, () => expect(1).toBe(2))).rejects.toThrow(/expected 1 to be 2/)
  })
})
