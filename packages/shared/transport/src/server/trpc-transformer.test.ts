import { describe, expect, it } from 'vitest'
import superjson from 'superjson'
import { serializeOutput, trpcTransformer } from './trpc-transformer'

/** What the client actually receives: the JSON text of the serialized result. */
const wire = (v: unknown): string => JSON.stringify(serializeOutput(v))
const reference = (v: unknown): string => JSON.stringify(superjson.serialize(v))

const tookFastPath = (v: unknown): boolean => serializeOutput(v).json === v

class Klass {
  a = 1
}

describe('serializeOutput', () => {
  it('returns plain JSON data as-is (fast path) with superjson-identical bytes', () => {
    const plain = [
      null,
      'str',
      '',
      0,
      42,
      -1.5,
      true,
      false,
      [],
      {},
      [1, 'a', null, { b: [true, { c: 'd' }] }],
      { tasks: [{ id: 't1', provider_config: { 'claude-code': { flags: '' } } }], n: 3 },
      Object.assign(Object.create(null), { x: 1 })
    ]
    for (const v of plain) {
      expect(wire(v)).toBe(reference(v))
      if (v !== null && typeof v === 'object') expect(tookFastPath(v)).toBe(true)
    }
  })

  it('falls back to superjson for everything it would annotate — identical bytes', () => {
    const shared = { s: 1 }
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    const holey = [1, , 3] // eslint-disable-line no-sparse-arrays
    const extraKey = Object.assign([1, 2], { when: new Date(0) })
    const special = [
      undefined,
      { a: undefined },
      [undefined],
      NaN,
      { n: Infinity },
      { n: -Infinity },
      { n: -0 },
      { big: 10n },
      { d: new Date(1792940151242) },
      { m: new Map([['k', 1]]) },
      { s: new Set([1, 2]) },
      { r: /x/g },
      { u: new URL('https://example.com/a') },
      { e: new Error('boom') },
      { ta: new Uint8Array([1, 2]) },
      { k: new Klass() },
      { f: () => 1 },
      { sym: Symbol('x') },
      { one: shared, two: shared },
      [shared, shared],
      cyclic,
      holey,
      extraKey
    ]
    for (const v of special) {
      expect(tookFastPath(v)).toBe(false)
      expect(wire(v)).toBe(reference(v))
    }
  })

  it('keeps superjson’s prototype-pollution refusal', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const v = JSON.parse(`{"ok":1,"nested":{"${key}":{"x":1}}}`)
      expect(() => superjson.serialize(v)).toThrow()
      expect(() => serializeOutput(v)).toThrow()
    }
  })

  it('round-trips through the client deserializer exactly like superjson', () => {
    const v = { a: [1, { b: 'c' }], d: new Date(5), e: null }
    expect(superjson.deserialize(serializeOutput(v))).toEqual(
      superjson.deserialize(superjson.serialize(v))
    )
    const plain = { a: [1, { b: 'c' }], e: null }
    expect(trpcTransformer.output.deserialize(JSON.parse(wire(plain)))).toEqual(plain)
  })

  it('matches superjson byte-for-byte on randomized nested values', () => {
    let seed = 12345
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const leaf = (): unknown => {
      const r = rand()
      if (r < 0.15) return null
      if (r < 0.3) return 'x' + Math.floor(rand() * 1000)
      if (r < 0.45) return Math.floor(rand() * 2000) - 1000
      if (r < 0.55) return rand() < 0.5
      if (r < 0.6) return undefined
      if (r < 0.63) return new Date(Math.floor(rand() * 1e12))
      if (r < 0.65) return NaN
      if (r < 0.67) return -0
      return rand() * 10
    }
    const gen = (depth: number): unknown => {
      if (depth === 0 || rand() < 0.3) return leaf()
      const n = Math.floor(rand() * 5)
      if (rand() < 0.5) return Array.from({ length: n }, () => gen(depth - 1))
      const o: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) o['k' + i] = gen(depth - 1)
      return o
    }
    let fast = 0
    for (let i = 0; i < 2000; i++) {
      const v = gen(4)
      expect(wire(v)).toBe(reference(v))
      if (v !== null && typeof v === 'object' && tookFastPath(v)) fast++
    }
    // Both paths are exercised by the corpus.
    expect(fast).toBeGreaterThan(100)
  })
})
