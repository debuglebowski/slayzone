/**
 * Tests for pruneBlobs — the bound on payload blobs written to
 * `<storage>/diagnostics/`.
 *
 * Offloading screenshots to disk is what made them usable (the redactor's
 * 4096-char trim destroyed ~99% of every one), but the event-row retention in
 * `retention.ts` only prunes DB rows. Without this the blobs accumulated forever:
 * ~10 MB/week measured, unbounded.
 */
import { describe, expect, test } from 'vitest'
import { pruneBlobs, type BlobFileInfo, type BlobFileSystem } from './blob-retention'

/** In-memory blob dir. `failOn` names files whose delete throws. */
function fakeFs(
  files: BlobFileInfo[],
  failOn: Set<string> = new Set()
): BlobFileSystem & { remaining: () => string[] } {
  const present = new Map(files.map((f) => [f.name, f]))
  return {
    list: () => Array.from(present.values()),
    remove(name) {
      if (failOn.has(name)) throw new Error('EBUSY')
      present.delete(name)
    },
    remaining: () => Array.from(present.keys())
  }
}

const MB = 1024 * 1024
const HUGE = 1000 * MB

describe('pruneBlobs', () => {
  test('removes blobs older than the cutoff', () => {
    const fs = fakeFs([
      { name: 'old.png', sizeBytes: MB, mtimeMs: 1_000 },
      { name: 'new.png', sizeBytes: MB, mtimeMs: 9_000 }
    ])
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: HUGE })
    expect(r.deleted).toBe(1)
    expect(r.freedBytes).toBe(MB)
    expect(fs.remaining().join(','), 'only the recent blob survives').toBe('new.png')
  })

  test('keeps everything when nothing is past the cutoff and size is under budget', () => {
    const fs = fakeFs([
      { name: 'a.png', sizeBytes: MB, mtimeMs: 8_000 },
      { name: 'b.png', sizeBytes: MB, mtimeMs: 9_000 }
    ])
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: HUGE })
    expect(r.deleted).toBe(0)
    expect(fs.remaining().length).toBe(2)
  })

  test('enforces the size ceiling oldest-first even when all blobs are recent', () => {
    // The burst case age alone cannot bound: a driver fault fires the canary
    // hundreds of times in an hour and every blob is "recent".
    const fs = fakeFs([
      { name: 'r1.png', sizeBytes: 10 * MB, mtimeMs: 1_000 },
      { name: 'r2.png', sizeBytes: 10 * MB, mtimeMs: 2_000 },
      { name: 'r3.png', sizeBytes: 10 * MB, mtimeMs: 3_000 }
    ])
    const r = pruneBlobs(fs, { cutoffMs: 0, maxTotalBytes: 25 * MB })
    expect(r.deleted, 'exactly enough deleted to fit').toBe(1)
    expect(fs.remaining().join(','), 'oldest went first').toBe('r2.png,r3.png')
  })

  test('deletes as many as needed to get under budget', () => {
    const fs = fakeFs([
      { name: 'r1.png', sizeBytes: 10 * MB, mtimeMs: 1_000 },
      { name: 'r2.png', sizeBytes: 10 * MB, mtimeMs: 2_000 },
      { name: 'r3.png', sizeBytes: 10 * MB, mtimeMs: 3_000 },
      { name: 'r4.png', sizeBytes: 10 * MB, mtimeMs: 4_000 }
    ])
    pruneBlobs(fs, { cutoffMs: 0, maxTotalBytes: 15 * MB })
    expect(fs.remaining().join(','), 'pruned down to fit 15MB').toBe('r4.png')
  })

  test('age and size bounds compose', () => {
    const fs = fakeFs([
      { name: 'old.png', sizeBytes: 5 * MB, mtimeMs: 1_000 },
      { name: 'r1.png', sizeBytes: 10 * MB, mtimeMs: 7_000 },
      { name: 'r2.png', sizeBytes: 10 * MB, mtimeMs: 8_000 }
    ])
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: 12 * MB })
    // old.png by age, then r1.png to fit the ceiling.
    expect(r.deleted).toBe(2)
    expect(fs.remaining().join(',')).toBe('r2.png')
  })

  test('an undeletable file is reported, not thrown, and others still prune', () => {
    const fs = fakeFs(
      [
        { name: 'locked.png', sizeBytes: MB, mtimeMs: 1_000 },
        { name: 'old.png', sizeBytes: MB, mtimeMs: 1_500 }
      ],
      new Set(['locked.png'])
    )
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: HUGE })
    expect(r.failed, 'failure counted').toBe(1)
    expect(r.deleted, 'the other file still went').toBe(1)
    expect(fs.remaining(), 'locked file remains on disk').toContain('locked.png')
  })

  test('a file that failed the age delete still counts against the size budget', () => {
    // It is still occupying disk, so pretending it is gone would let the total
    // silently exceed the ceiling.
    const fs = fakeFs(
      [
        { name: 'locked.png', sizeBytes: 20 * MB, mtimeMs: 1_000 },
        { name: 'r1.png', sizeBytes: 10 * MB, mtimeMs: 9_000 }
      ],
      new Set(['locked.png'])
    )
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: 25 * MB })
    expect(r.failed).toBe(1)
    // 20MB (stuck) + 10MB = 30MB > 25MB, so r1 is dropped to get under budget.
    expect(fs.remaining().join(',')).toBe('locked.png')
    expect(r.deleted).toBe(1)
  })

  test('an empty or missing directory is a no-op', () => {
    expect(pruneBlobs(fakeFs([]), { cutoffMs: 5_000, maxTotalBytes: HUGE }).deleted).toBe(0)
    const throwing: BlobFileSystem = {
      list() {
        throw new Error('ENOENT')
      },
      remove() {}
    }
    const r = pruneBlobs(throwing, { cutoffMs: 5_000, maxTotalBytes: HUGE })
    expect(r.deleted, 'unreadable dir does not throw').toBe(0)
    expect(r.failed).toBe(0)
  })

  test('freedBytes reports what was actually reclaimed', () => {
    const fs = fakeFs([
      { name: 'a.png', sizeBytes: 3 * MB, mtimeMs: 1_000 },
      { name: 'b.png', sizeBytes: 7 * MB, mtimeMs: 2_000 }
    ])
    const r = pruneBlobs(fs, { cutoffMs: 5_000, maxTotalBytes: HUGE })
    expect(r.freedBytes).toBe(10 * MB)
  })
})
