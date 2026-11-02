import { describe, expect, it } from 'vitest'
import superjson from 'superjson'
import {
  COMPACT_BYTES_TRANSFORMER,
  CompactBytes,
  compactBytesInInput,
  decodeBase64,
  encodeBase64,
  hasBytes,
  portableBase64,
  wireSuperjson
} from './wire-bytes'
import { trpcTransformer } from './trpc-transformer'

const MiB = 1024 * 1024

/** Deterministic bytes covering every value 0..255 (worst case for the number-array form). */
function sampleBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  let seed = 0x2545f491
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = seed >>> 16
  }
  return out
}

/** The text of the frame payload wsLink sends for an input (`transformer.serialize` → JSON). */
const frameBytes = (serialized: unknown): number =>
  new TextEncoder().encode(JSON.stringify(serialized)).length

describe('compact bytes on the wire', () => {
  const bytes = sampleBytes(MiB)
  const input = { taskId: 't1', title: 'x.pdf', bytes, folderId: null }

  it('legacy superjson sends 1 MiB as a ~3.6 MiB number array (the baseline)', () => {
    const legacy = frameBytes(superjson.serialize(input))
    expect(legacy).toBeGreaterThan(3.4 * MiB)
  })

  it('a compact input frame is ~4/3 of the payload and round-trips exactly through the hub', () => {
    const frame = wireSuperjson.serialize(compactBytesInInput(input))
    const size = frameBytes(frame)
    expect(size).toBeLessThan(Math.ceil((MiB * 4) / 3) + 512)
    const back = trpcTransformer.input.deserialize(JSON.parse(JSON.stringify(frame))) as {
      bytes: Uint8Array
    }
    expect({ ...back, bytes: null }).toEqual({ ...input, bytes: null })
    expect(Object.getPrototypeOf(back.bytes)).toBe(Uint8Array.prototype)
    expect(Buffer.from(back.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('the hub still accepts the legacy frame of an older client', () => {
    const legacy = JSON.parse(JSON.stringify(superjson.serialize(input)))
    const back = trpcTransformer.input.deserialize(legacy) as { bytes: Uint8Array }
    expect(Buffer.from(back.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('an unmarked Uint8Array is serialized exactly as plain superjson (older hubs)', () => {
    expect(JSON.stringify(wireSuperjson.serialize(input))).toBe(
      JSON.stringify(superjson.serialize(input))
    )
  })

  it('an older peer cannot read the compact form — why the client gates on the hub', () => {
    const frame = JSON.parse(JSON.stringify(wireSuperjson.serialize(compactBytesInInput(input))))
    expect(() => superjson.deserialize(frame)).toThrow(/unknown custom/)
    expect(frame.meta.values.bytes).toEqual([['custom', COMPACT_BYTES_TRANSFORMER]])
  })

  it('marks every Uint8Array at any depth, copying (never mutating) the input', () => {
    const a = sampleBytes(3)
    const b = sampleBytes(5)
    const nested = { list: [a, { b }], n: 1, s: 's', d: new Date(5) }
    const marked = compactBytesInInput(nested) as { list: [CompactBytes, { b: CompactBytes }] }
    expect(marked.list[0]).toBeInstanceOf(CompactBytes)
    expect(marked.list[1].b).toBeInstanceOf(CompactBytes)
    expect(nested.list[0]).toBe(a)
    const back = trpcTransformer.input.deserialize(
      JSON.parse(JSON.stringify(wireSuperjson.serialize(marked)))
    )
    expect(back).toEqual(nested)
  })

  it('hasBytes finds a Uint8Array anywhere and nothing else', () => {
    expect(hasBytes({ a: [{ b: new Uint8Array(1) }] })).toBe(true)
    expect(hasBytes(new Uint8Array(0))).toBe(true)
    expect(hasBytes({ a: [1, 'x', null, { b: new Date(0) }] })).toBe(false)
    expect(hasBytes(undefined)).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(hasBytes(cyclic)).toBe(false)
  })

  it('base64 codec round-trips every length and byte value, and matches Buffer', () => {
    for (const n of [0, 1, 2, 3, 4, 255, 256, 65_537]) {
      const b = sampleBytes(n)
      const s = encodeBase64(b)
      expect(s).toBe(Buffer.from(b).toString('base64'))
      expect(Buffer.from(decodeBase64(s)).equals(Buffer.from(b))).toBe(true)
      expect(portableBase64.encode(b)).toBe(s)
      expect(Buffer.from(portableBase64.decode(s)).equals(Buffer.from(b))).toBe(true)
    }
    for (const bad of ['a', 'ab=c', 'a$cd', '=abc', 'abc===']) {
      expect(() => decodeBase64(bad)).toThrow()
      expect(() => portableBase64.decode(bad)).toThrow()
    }
    // a subarray view encodes only its own window
    const whole = sampleBytes(10)
    expect(encodeBase64(whole.subarray(2, 5))).toBe(
      Buffer.from(whole.subarray(2, 5)).toString('base64')
    )
  })
})
