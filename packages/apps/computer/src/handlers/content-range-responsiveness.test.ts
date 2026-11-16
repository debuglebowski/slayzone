/** Same first-range/control assertions, now observing the actual compiled owner FD. */
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import {
  PUBLICATION_PROOF_TEST_TIMEOUT_MS,
  runPublicationProof
} from '../artifact-publication-proof.fixture'

test(
  'actual first fallback-content range keeps native reads and full verification off the main control turn',
  async () => {
    const result = await runPublicationProof('public-range')
    expect(result?.entered).toBe(true)
    expect(result?.controls).toEqual({ sessions: [], exited: [] })
    expect(result?.repliedBeforeRelease).toBe(false)
    expect(result?.firstPageHash).toBe(
      createHash('sha256').update(Buffer.alloc(BYTE_RANGE_MAX_CHUNK, 0xa7)).digest('hex')
    )
    expect(result?.size).toBe(4 * 1024 * 1024)
    expect(result?.reads).toBeGreaterThan(16)
    expect(result?.maxRead).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
    expect(result?.syncBytes).toBe(0)
    expect(result?.mainBodyIo).toBe(0)
  },
  PUBLICATION_PROOF_TEST_TIMEOUT_MS
)
