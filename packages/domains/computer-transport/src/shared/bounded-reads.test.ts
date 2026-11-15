/**
 * The bounded-read budgets (`@slayzone/platform/bounded-reads`) must stay far under
 * the frame limit: a page or a range plus its JSON-RPC envelope, base64 growth and a
 * hub re-wrap always fits one frame.
 */
import { BYTE_RANGE_MAX_CHUNK, PAGE_MAX_BYTES } from '@slayzone/platform/bounded-reads'
import { describe, expect, it } from 'vitest'
import { COMPUTER_FRAME_MAX_BYTES } from './frame-limit'
import { FS_READ_BYTES_MAX_CHUNK } from './frames'

describe('bounded-read budgets vs the frame limit', () => {
  it('a page is at most 1/8 of a frame', () => {
    expect(PAGE_MAX_BYTES * 8).toBeLessThanOrEqual(COMPUTER_FRAME_MAX_BYTES)
  })

  it('a byte range (base64 ×4/3) is at most 1/8 of a frame, and equals fs.readBytes', () => {
    expect(Math.ceil(BYTE_RANGE_MAX_CHUNK / 3) * 4 * 8).toBeLessThanOrEqual(
      COMPUTER_FRAME_MAX_BYTES
    )
    expect(BYTE_RANGE_MAX_CHUNK).toBe(FS_READ_BYTES_MAX_CHUNK)
  })
})
