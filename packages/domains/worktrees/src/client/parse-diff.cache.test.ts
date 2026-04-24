/**
 * Cache-behavior tests for parse-diff.ts LRU (separate from the
 * parser-correctness tests in parse-diff.test.ts).
 *
 * MAX_ENTRIES = 64, MAX_BYTES = 8 MiB, estimatePatchBytes = len * 4.
 *
 * Run: pnpm --filter @slayzone/worktrees exec vitest run src/client/parse-diff.cache.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseUnifiedDiff,
  _clearParseDiffCache,
} from './parse-diff'

// Build a syntactically-valid unified diff whose patch-text length is
// approximately `targetLen`. Cache key is the raw patch string, so unique
// file path = unique entry.
function makePatch(id: string, padLen = 0): string {
  const pad = padLen > 0 ? '\n' + 'x'.repeat(padLen) : ''
  return `diff --git a/${id}.txt b/${id}.txt
--- a/${id}.txt
+++ b/${id}.txt
@@ -1 +1 @@
-old
+new${pad}`
}

describe('parse-diff LRU cache', () => {
  beforeEach(() => {
    _clearParseDiffCache()
  })

  it('returns the same array reference on cache hit', () => {
    const p = makePatch('a')
    const first = parseUnifiedDiff(p)
    const second = parseUnifiedDiff(p)
    // Identity check — cache hit returns the stored value, not a re-parse.
    expect(second).toBe(first)
  })

  it('count cap: exceeding MAX_ENTRIES with small patches evicts oldest', () => {
    const MAX_ENTRIES = 64
    // Insert MAX_ENTRIES + 1 distinct small patches.
    const first = makePatch('first')
    parseUnifiedDiff(first)
    const firstRef = parseUnifiedDiff(first) // warm / verify identity
    expect(parseUnifiedDiff(first)).toBe(firstRef)

    for (let i = 0; i < MAX_ENTRIES; i++) {
      parseUnifiedDiff(makePatch(`filler-${i}`))
    }

    // `first` was the oldest — now evicted. Re-parsing returns a fresh array.
    const afterEviction = parseUnifiedDiff(first)
    expect(afterEviction).not.toBe(firstRef)
    // But still parses to equivalent content.
    expect(afterEviction).toHaveLength(1)
    expect(afterEviction[0].path).toBe('first.txt')
  })

  it('count cap: accessed entry is promoted to MRU and survives eviction wave', () => {
    // Two parallel timelines prove the promote:
    //   victim:    inserted, NOT touched → evicted by the wave
    //   survivor:  inserted earlier, touched just before the wave → kept
    // Both were inserted before the wave; only the promote differentiates them.
    const victim = makePatch('victim')
    const survivor = makePatch('survivor')
    const victimRef = parseUnifiedDiff(victim)
    const survivorRef = parseUnifiedDiff(survivor)

    // Touch survivor — promotes to tail (MRU). Cache order is now roughly:
    //   [victim, ..., survivor]
    expect(parseUnifiedDiff(survivor)).toBe(survivorRef)

    // After the touch the LRU order is [victim, survivor]. MAX_ENTRIES=64.
    // Insert exactly enough new entries to evict the single head (victim)
    // without reaching far enough to evict survivor. Starting size 2, we can
    // insert 62 lates (size 64), then one more to trip eviction of victim.
    for (let i = 0; i < 63; i++) parseUnifiedDiff(makePatch(`late-${i}`))

    // Check survivor FIRST — re-parsing victim below will re-cache it and
    // trip another eviction, which would evict survivor and muddy the check.
    // Survivor was promoted → still cached: same reference.
    expect(parseUnifiedDiff(survivor)).toBe(survivorRef)
    // Victim was at the head → evicted: returns a fresh array.
    expect(parseUnifiedDiff(victim)).not.toBe(victimRef)
  })

  it('byte cap: exceeding MAX_BYTES evicts even when count cap not hit', () => {
    // MAX_BYTES = 8 MiB. estimatePatchBytes = len * 4. So one patch with len
    // ~= 3 MiB = 12 MiB of accounted bytes — alone triggers eviction on any
    // subsequent insert. Use two big patches well under count cap.
    const bigLen = 3 * 1024 * 1024 // 3 MiB string → 12 MiB accounted
    const big1 = makePatch('big1', bigLen)
    const big2 = makePatch('big2', bigLen)

    const big1Ref = parseUnifiedDiff(big1)
    // big1 alone: 12 MiB > 8 MiB cap → evicted immediately after insert.
    // Re-parse confirms it is not cached.
    const big1Again = parseUnifiedDiff(big1)
    expect(big1Again).not.toBe(big1Ref)

    // Inserting big2 also exceeds cap; big1 (if re-cached) gets evicted.
    parseUnifiedDiff(big2)
    // Only 2 distinct entries inserted total — well under MAX_ENTRIES=64 —
    // so eviction was strictly byte-driven, not count-driven.
    const big1Third = parseUnifiedDiff(big1)
    expect(big1Third).not.toBe(big1Again)
  })

  it('_clearParseDiffCache empties the cache and resets byte total', () => {
    const p = makePatch('z')
    const ref1 = parseUnifiedDiff(p)
    expect(parseUnifiedDiff(p)).toBe(ref1)
    _clearParseDiffCache()
    const ref2 = parseUnifiedDiff(p)
    expect(ref2).not.toBe(ref1)
  })
})
