import { describe, expect, it } from 'vitest'
import { PersistentIndex } from './persistent-index'
import { beginReducerCall, endReducerCall } from './replay-batch'

describe('PersistentIndex', () => {
  it('maps keys to values like a Map', () => {
    let idx = PersistentIndex.empty<number>()
    expect(idx.size).toBe(0)
    expect(idx.get('a')).toBeUndefined()
    idx = idx.with('a', 1).with('b', 2)
    expect(idx.get('a')).toBe(1)
    expect(idx.get('b')).toBe(2)
    expect(idx.has('a')).toBe(true)
    expect(idx.has('c')).toBe(false)
    expect(idx.size).toBe(2)
    idx = idx.with('a', 3)
    expect(idx.get('a')).toBe(3)
    expect(idx.size).toBe(2)
  })

  it('never changes a version it was derived from', () => {
    const v1 = PersistentIndex.empty<number>().with('x', 1)
    const v2 = v1.with('y', 2)
    const v3 = v2.with('x', 9)
    expect(v1.get('y')).toBeUndefined()
    expect(v1.get('x')).toBe(1)
    expect(v2.get('x')).toBe(1)
    expect(v3.get('x')).toBe(9)
    expect([v1.size, v2.size, v3.size]).toEqual([1, 2, 2])
  })

  it('a version past the small size leaves the small one it came from as it was', () => {
    let small = PersistentIndex.empty<number>()
    for (let i = 0; i < 64; i++) small = small.with(`k${i}`, i)
    const big = small.with('k64', 64).with('k0', -1)
    expect(small.size).toBe(64)
    expect(small.get('k64')).toBeUndefined()
    expect(small.get('k0')).toBe(0)
    expect(big.size).toBe(65)
    expect(big.get('k64')).toBe(64)
    expect(big.get('k0')).toBe(-1)
    for (let i = 1; i < 64; i++) expect(big.get(`k${i}`)).toBe(i)
  })

  it('holds many keys (colliding buckets included) exactly like a Map', () => {
    const ref = new Map<string, number>()
    let idx = PersistentIndex.empty<number>()
    for (let i = 0; i < 20_000; i++) {
      const key = `toolu_${(i * 7919) % 15_000}`
      ref.set(key, i)
      idx = idx.with(key, i)
    }
    expect(idx.size).toBe(ref.size)
    for (const [k, v] of ref) expect(idx.get(k)).toBe(v)
    expect(idx.get('toolu_missing')).toBeUndefined()
  })

  it('an insert into a big index is not a copy of it (vs copying a Map of the same size)', () => {
    const N = 50_000
    let idx = PersistentIndex.empty<number>()
    const map = new Map<string, number>()
    for (let i = 0; i < N; i++) {
      idx = idx.with(`k${i}`, i)
      map.set(`k${i}`, i)
    }
    const per = (fn: () => void, times: number) => {
      const t0 = performance.now()
      for (let i = 0; i < times; i++) fn()
      return (performance.now() - t0) / times
    }
    const copy = per(() => new Map(map).set('new', 1), 20)
    const insert = per(() => idx.with('new', 1), 2_000)
    // A Map copy of 50k keys is ~1,000x an insert here; noise cannot close 20x.
    expect(insert * 20).toBeLessThan(copy)
  })

  it('inside one reducer call: nodes change in place, sizes stay exact, older versions untouched', () => {
    let before = PersistentIndex.empty<number>()
    for (let i = 0; i < 200; i++) before = before.with(`k${i}`, i)
    beginReducerCall()
    let idx = before
    try {
      for (let i = 0; i < 5_000; i++) idx = idx.with(`k${i}`, -i)
      // Re-setting keys it has (in place) keeps the count.
      for (let i = 0; i < 5_000; i += 7) idx = idx.with(`k${i}`, i)
    } finally {
      endReducerCall()
    }
    expect(idx.size).toBe(5_000)
    expect(idx.get('k7')).toBe(7)
    expect(idx.get('k8')).toBe(-8)
    // The version made before the call is as it was.
    expect(before.size).toBe(200)
    expect(before.get('k8')).toBe(8)
    expect(before.get('k4999')).toBeUndefined()
  })
})
