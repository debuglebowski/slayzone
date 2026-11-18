// A streaming zip writer for artifact folder and "all as ZIP" downloads — the one
// encoder behind every host that saves a zip: the web shell (in a worker, zip-worker.ts,
// deflating with fflate) and the desktop app (in main, client-save.ts, deflating with
// Node's zlib on its thread pool). Pieces go in as they arrive from the hub and archive
// bytes come out at once: nothing waits for a whole file, and no size has a ceiling — an
// entry or archive past 4 GB gets zip64 records. It imports no compressor: the host
// passes its own `Deflater`, so each host bundles only what it runs.
//
// Each file entry is written with a data descriptor (its CRC and sizes follow its data),
// the layout every streaming zip writer uses; readers take the sizes from the central
// directory. Names are UTF-8 (flag bit 11). Already-compressed types are stored.
//
// An entry that may reach 4 GiB is zip64 from its LOCAL header on: a zip64 extra there
// tells a reader that walks the local headers (macOS ditto / Archive Utility, libarchive
// on a pipe) that the descriptor after the data is the 24-byte one. Without it ditto
// loses its place after the entry and drops every later one. The writer knows the size
// of each file up front (the caller passes it), so only such an entry gets it: Java's
// ZipInputStream before 21 sizes a descriptor by the bytes it inflated, and misreads a
// small entry's 24-byte descriptor. An entry of unknown size gets it always, as
// Info-ZIP does when it streams.

/**
 * Raw DEFLATE, fed in pieces; returns (or resolves to) whatever output each piece
 * produced. `final` ends the stream: its result is the rest of the output. An async
 * deflater (Node's zlib) keeps compression off the calling thread.
 */
export interface Deflater {
  push(data: Uint8Array, final: boolean): Uint8Array[] | Promise<Uint8Array[]>
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 of `data`, continuing from `crc` (the running value of earlier pieces). */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

const STORED = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'heic',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'mp3',
  'mp4',
  'm4a',
  'mov',
  'webm',
  'mkv',
  'woff2'
])
const isStored = (path: string): boolean => {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') && STORED.has(path.slice(dot + 1).toLowerCase())
}

const U32 = 0xffffffff
const U16 = 0xffff
const textEncoder = new TextEncoder()

interface Entry {
  name: Uint8Array
  dir: boolean
  method: 0 | 8
  /** zip64 from the local header on: a zip64 extra there, a 24-byte descriptor. */
  wide: boolean
  offset: number
  crc: number
  compressed: number
  size: number
}

/**
 * Whether an entry of `size` bytes may need 8-byte sizes: its size, or its compressed
 * size (deflate adds 5 bytes per stored block of at most 16 KiB when data does not
 * compress), may reach 0xFFFFFFFF. Unknown size: it may.
 */
export function mayNeedZip64(size: number | undefined, method: 0 | 8): boolean {
  if (size === undefined) return true
  const worst = method === 8 ? size + Math.ceil(size / 16_384) * 5 + 1024 : size
  return worst >= U32
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

class Bytes {
  readonly buf: Uint8Array
  readonly view: DataView
  at = 0
  constructor(n: number) {
    this.buf = new Uint8Array(n)
    this.view = new DataView(this.buf.buffer)
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true)
    this.at += 2
    return this
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true)
    this.at += 4
    return this
  }
  u64(v: number): this {
    this.view.setBigUint64(this.at, BigInt(v), true)
    this.at += 8
    return this
  }
  bytes(b: Uint8Array): this {
    this.buf.set(b, this.at)
    this.at += b.byteLength
    return this
  }
}

/**
 * Calls run in the order they are made, each after the one before it has settled, so a
 * caller may make several without awaiting each; the bytes of a call are emitted before
 * its promise resolves. A refused call (a repeated path) rejects and leaves the archive
 * as it was. Any other failure (the deflater, the output, an entry larger than its
 * declared size) breaks the archive: that call and every later one reject with it.
 * Bytes passed to `write` must not change until its promise settles.
 */
export interface ZipEncoder {
  /**
   * Append `data` to the entry at `path`; a new path finishes the previous entry.
   * `size`: the entry's total byte length, read when the entry starts (undefined =
   * unknown: the entry is laid out for any size).
   */
  write(path: string, data: Uint8Array, size?: number): Promise<void>
  /** A folder entry (an empty folder survives the archive). */
  mkdir(path: string): Promise<void>
  /** Finish the last entry and write the central directory. */
  finish(): Promise<void>
}

export function createZipEncoder(
  emit: (chunk: Uint8Array) => void,
  opts: { deflater: () => Deflater; forceZip64?: boolean; now?: Date }
): ZipEncoder {
  const { time, date } = dosDateTime(opts.now ?? new Date())
  const force64 = opts.forceZip64 === true
  const entries: Entry[] = []
  let written = 0
  let current: (Entry & { path: string; deflater: Deflater | null }) | null = null
  /** Case-folded paths already started: a repeat is refused, never continued. */
  const started = new Set<string>()

  const out = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return
    written += chunk.byteLength
    emit(chunk)
  }

  const localHeader = (e: Entry, descriptor: boolean): void => {
    // A zip64 entry: both 4-byte sizes say "see the zip64 extra", which holds both
    // (zero: the descriptor after the data carries them, bit 3).
    const extra = e.wide ? 20 : 0
    const b = new Bytes(30 + e.name.byteLength + extra)
      .u32(0x04034b50)
      .u16(e.wide || force64 ? 45 : 20)
      .u16(descriptor ? 0x0808 : 0x0800)
      .u16(e.method)
      .u16(time)
      .u16(date)
      .u32(0)
      .u32(e.wide ? U32 : 0)
      .u32(e.wide ? U32 : 0)
      .u16(e.name.byteLength)
      .u16(extra)
      .bytes(e.name)
    if (e.wide) b.u16(0x0001).u16(16).u64(0).u64(0)
    out(b.buf)
  }

  /** The call in flight: each call runs after the one before it has settled. */
  let chain: Promise<void> = Promise.resolve()
  /** What broke the archive: every later call rejects with it. */
  let broken: { error: unknown } | null = null
  /** The path of the last write CALL: a call naming another path starts an entry. */
  let lastPath: string | null = null

  const run = (op: () => Promise<void>): Promise<void> => {
    const result = chain.then(async () => {
      if (broken) throw broken.error
      await op().catch((error: unknown) => {
        broken ??= { error }
        throw error
      })
    })
    chain = result.catch(() => undefined)
    return result
  }

  const endCurrent = async (): Promise<void> => {
    const c = current
    if (!c) return
    current = null
    if (c.deflater)
      for (const piece of await c.deflater.push(new Uint8Array(0), true)) {
        c.compressed += piece.byteLength
        out(piece)
      }
    // The descriptor is as wide as the local header said. An entry that outgrew a
    // classic header (a size passed wrong) cannot be described: refuse it.
    if (!c.wide && (c.compressed >= U32 || c.size >= U32))
      throw new Error(`${c.path} is larger than the size given for it`)
    const d = new Bytes(c.wide ? 24 : 16).u32(0x08074b50).u32(c.crc)
    if (c.wide) d.u64(c.compressed).u64(c.size)
    else d.u32(c.compressed).u32(c.size)
    out(d.buf)
    entries.push(c)
  }

  return {
    write(path, data, size) {
      if (lastPath !== path) {
        // Checked when called, so a refusal never reaches the archive.
        const key = path.normalize('NFC').toLowerCase()
        if (started.has(key))
          return Promise.reject(new Error(`${path} was already written in this download`))
        started.add(key)
        lastPath = path
      }
      return run(async () => {
        if (current?.path !== path) {
          await endCurrent()
          const stored = isStored(path)
          current = {
            path,
            name: textEncoder.encode(path),
            dir: false,
            method: stored ? 0 : 8,
            wide: force64 || mayNeedZip64(size, stored ? 0 : 8),
            offset: written,
            crc: 0,
            compressed: 0,
            size: 0,
            deflater: stored ? null : opts.deflater()
          }
          localHeader(current, true)
        }
        const c = current
        if (data.byteLength === 0) return
        c.crc = crc32(data, c.crc)
        c.size += data.byteLength
        if (c.deflater)
          for (const piece of await c.deflater.push(data, false)) {
            c.compressed += piece.byteLength
            out(piece)
          }
        else {
          c.compressed += data.byteLength
          out(data)
        }
      })
    },
    mkdir(path) {
      lastPath = null
      return run(async () => {
        await endCurrent()
        const e: Entry = {
          name: textEncoder.encode(`${path.replace(/\/+$/, '')}/`),
          dir: true,
          method: 0,
          wide: false,
          offset: written,
          crc: 0,
          compressed: 0,
          size: 0
        }
        localHeader(e, false)
        entries.push(e)
      })
    },
    finish() {
      lastPath = null
      return run(async () => {
        await endCurrent()
        const cdStart = written
        for (const e of entries) {
          const bigSize = force64 || e.size >= U32
          const bigComp = force64 || e.compressed >= U32
          const bigOff = force64 || e.offset >= U32
          const extraLen = (bigSize ? 8 : 0) + (bigComp ? 8 : 0) + (bigOff ? 8 : 0)
          const b = new Bytes(46 + e.name.byteLength + (extraLen ? 4 + extraLen : 0))
            .u32(0x02014b50)
            .u16((3 << 8) | 45)
            .u16(extraLen || e.wide ? 45 : 20)
            .u16(e.dir ? 0x0800 : 0x0808)
            .u16(e.method)
            .u16(time)
            .u16(date)
            .u32(e.crc)
            .u32(bigComp ? U32 : e.compressed)
            .u32(bigSize ? U32 : e.size)
            .u16(e.name.byteLength)
            .u16(extraLen ? 4 + extraLen : 0)
            .u16(0)
            .u16(0)
            .u16(0)
            .u32(e.dir ? (0o40755 << 16) | 0x10 : 0o100644 << 16)
            .u32(bigOff ? U32 : e.offset)
            .bytes(e.name)
          if (extraLen) {
            b.u16(0x0001).u16(extraLen)
            if (bigSize) b.u64(e.size)
            if (bigComp) b.u64(e.compressed)
            if (bigOff) b.u64(e.offset)
          }
          out(b.buf)
        }
        const cdSize = written - cdStart
        const zip64 = force64 || entries.length >= U16 || cdSize >= U32 || cdStart >= U32
        if (zip64) {
          const eocd64 = written
          out(
            new Bytes(56)
              .u32(0x06064b50)
              .u64(44)
              .u16((3 << 8) | 45)
              .u16(45)
              .u32(0)
              .u32(0)
              .u64(entries.length)
              .u64(entries.length)
              .u64(cdSize)
              .u64(cdStart).buf
          )
          out(new Bytes(20).u32(0x07064b50).u32(0).u64(eocd64).u32(1).buf)
        }
        out(
          new Bytes(22)
            .u32(0x06054b50)
            .u16(0)
            .u16(0)
            .u16(zip64 ? U16 : entries.length)
            .u16(zip64 ? U16 : entries.length)
            .u32(zip64 ? U32 : cdSize)
            .u32(zip64 ? U32 : cdStart)
            .u16(0).buf
        )
      })
    }
  }
}
