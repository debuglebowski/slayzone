import { SuperJSON } from 'superjson'

/**
 * Compact bytes on the tRPC wire.
 *
 * WHY. Plain superjson sends a `Uint8Array` as a JSON array of numbers
 * (`[137,80,78,…]` + a `typed-array` annotation): ~3.6 bytes on the wire per
 * byte of file, so a 10 MiB PDF attachment is a ~36 MiB frame. Base64 is 4/3.
 *
 * WHAT. A superjson custom transformer, `bytes:base64`, that carries the bytes as
 * one base64 string and decodes back to a plain `Uint8Array`. It applies only to a
 * `CompactBytes` marker, never to a bare `Uint8Array`, so the SENDER decides per
 * operation: superjson cannot read a custom value it does not know (it throws
 * "unknown custom value"), so a client marks bytes only for a hub that says it
 * reads them (`hub.describe` → `wire.compactBytes`); an older hub keeps getting
 * the number array it always got. `wireSuperjson` serializes an unmarked value
 * byte-for-byte like plain superjson, and DEserializes both forms — the hub takes
 * any client's input, old or new.
 *
 * Isomorphic (hub on Node, renderer, React Native): `toBase64`/`fromBase64` where
 * the engine has them, else `Buffer`, else a portable codec.
 */

/** The custom transformer's name — on the wire as `meta.values: ['custom', <name>]`. */
export const COMPACT_BYTES_TRANSFORMER = 'bytes:base64'

/** Marks bytes to send compactly. Only a sender wraps; a receiver always gets `Uint8Array`. */
export class CompactBytes {
  constructor(readonly bytes: Uint8Array) {}
}

type NativeBase64 = {
  toBase64?: (this: Uint8Array) => string
}
type NativeFromBase64 = { fromBase64?: (s: string) => Uint8Array }
type NodeBuffer = {
  from(buf: ArrayBufferLike, offset: number, length: number): { toString(enc: 'base64'): string }
  from(s: string, enc: 'base64'): Uint8Array
}

const nodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DECODE = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i
  return t
})()

function portableEncode(b: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  let i = 0
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
    chunk +=
      ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = b.length - i
  if (rest === 1) {
    const n = b[i] << 16
    chunk += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8)
    chunk += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`
  }
  parts.push(chunk)
  return parts.join('')
}

function portableDecode(s: string): Uint8Array {
  let len = s.length
  while (len > 0 && s.charCodeAt(len - 1) === 61 /* = */) len--
  if (s.length % 4 !== 0 || s.length - len > 2) throw new Error('invalid base64')
  const out = new Uint8Array(Math.floor((len * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? DECODE[c] : -1
    if (v < 0) throw new Error('invalid base64')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

/** The engine-independent codec (React Native has neither `toBase64` nor `Buffer`). Exported for tests. */
export const portableBase64 = { encode: portableEncode, decode: portableDecode }

/** Standard base64 (RFC 4648 §4, padded) of exactly `bytes`' window. */
export function encodeBase64(bytes: Uint8Array): string {
  const native = (Uint8Array.prototype as NativeBase64).toBase64
  if (native) return native.call(bytes)
  if (nodeBuffer)
    return nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  return portableEncode(bytes)
}

/** The bytes of a padded standard base64 string, as a plain `Uint8Array`. */
export function decodeBase64(s: string): Uint8Array {
  const native = (Uint8Array as unknown as NativeFromBase64).fromBase64
  if (native) return native(s)
  // Buffer is lenient (skips bad characters); the portable codec is not, so a
  // malformed frame never decodes on one platform and fails on another — validate.
  if (nodeBuffer) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('invalid base64')
    const b = nodeBuffer.from(s, 'base64')
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  }
  return portableDecode(s)
}

/** superjson with the compact-bytes transformer: reads both forms, writes compact only for `CompactBytes`. */
export const wireSuperjson = new SuperJSON()
wireSuperjson.registerCustom<CompactBytes, string>(
  {
    isApplicable: (v): v is CompactBytes => v instanceof CompactBytes,
    serialize: (v) => encodeBase64(v.bytes),
    deserialize: (s) => {
      if (typeof s !== 'string') throw new Error(`${COMPACT_BYTES_TRANSFORMER}: not a string`)
      const b = decodeBase64(s)
      // Always a plain Uint8Array (never a Buffer), like superjson's own typed-array form.
      return (Object.getPrototypeOf(b) === Uint8Array.prototype
        ? b
        : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) as unknown as CompactBytes
    }
  },
  COMPACT_BYTES_TRANSFORMER
)

const isBytes = (v: unknown): v is Uint8Array =>
  v instanceof Uint8Array && Object.getPrototypeOf(v) === Uint8Array.prototype

const isWalkable = (v: unknown): v is Record<string, unknown> | unknown[] => {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return true
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Does `value` hold a `Uint8Array` anywhere in its plain objects / arrays? */
export function hasBytes(value: unknown, seen: Set<object> = new Set()): boolean {
  if (isBytes(value)) return true
  if (!isWalkable(value) || seen.has(value)) return false
  seen.add(value)
  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) if (hasBytes(child, seen)) return true
  return false
}

/**
 * A copy of `input` with every `Uint8Array` (in plain objects / arrays) wrapped in
 * `CompactBytes`. Everything else is kept by reference; the input is never mutated.
 * Only for a receiver that reads `bytes:base64` (see the module doc).
 */
export function compactBytesInInput(
  input: unknown,
  seen: Map<object, unknown> = new Map()
): unknown {
  if (isBytes(input)) return new CompactBytes(input)
  if (!isWalkable(input)) return input
  const done = seen.get(input)
  if (done !== undefined) return done
  if (Array.isArray(input)) {
    const out: unknown[] = new Array(input.length)
    seen.set(input, out)
    // Index keys only, so a hole stays a hole (superjson annotates the two differently).
    for (let i = 0; i < input.length; i++)
      if (i in input) out[i] = compactBytesInInput(input[i], seen)
    return out
  }
  const out: Record<string, unknown> =
    Object.getPrototypeOf(input) === null ? Object.create(null) : {}
  seen.set(input, out)
  for (const key of Object.keys(input)) {
    // defineProperty: a `__proto__` own key stays an own key (superjson then refuses it, as before).
    Object.defineProperty(out, key, {
      value: compactBytesInInput(input[key], seen),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return out
}
