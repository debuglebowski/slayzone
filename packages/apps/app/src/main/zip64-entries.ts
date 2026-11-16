/**
 * Zip64 for one large entry streamed into archiver (8.x, compress-commons 7.x).
 *
 * An entry streamed in has no known size when its local header is written, so
 * compress-commons writes a classic header and, if the entry turns out ≥ 4 GiB, a
 * 24-byte zip64 data descriptor after it. Readers that walk the local headers (macOS
 * `ditto` / Archive Utility, streaming readers) then misread the descriptor and lose
 * every later entry. The client knows each entry's size before its first byte; an entry
 * that may need zip64 (a "wide" entry) gets the layout the web shell's encoder writes,
 * measured green with ditto, unzip, bsdtar on a pipe, Python zipfile and Java 11:
 *
 *   local header: version needed 45, data-descriptor flag, crc 0, both 32-bit sizes
 *     0xFFFFFFFF, and a zip64 extra (id 0x0001, 16 bytes: original then compressed
 *     size, both 0 — the descriptor carries them);
 *   data descriptor: signature, crc, compressed and original size as 64-bit (24 bytes);
 *   central directory: compress-commons' own (zip64 extra when a value overflows),
 *     with version needed 45.
 *
 * A narrow entry (known to stay below 4 GiB) keeps the classic layout; one that grows
 * past 4 GiB anyway fails the archive instead of writing the layout readers lose.
 * Entries of unknown size keep compress-commons' behaviour.
 *
 * This reaches into archiver's private engine: `assertZipEngine` fails loudly (at the
 * first zip) if a version bump moves it, and the tests read the bytes back.
 */

const ZIP64_MAGIC = 0xffffffff
const VERSION_ZIP64 = 45
const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const ZIP64_EXTRA_ID = 0x0001

/** How an entry's sizes are written. */
export type EntryWidth = 'wide' | 'narrow' | 'unknown'

/** Whether an entry of `size` bytes may need zip64 (deflate can outgrow its input). */
export function entryWidth(size: number | undefined, stored: boolean): EntryWidth {
  if (size === undefined) return 'unknown'
  const bound = stored ? size : size + Math.ceil(size / 16384) * 5 + 1024
  return bound >= ZIP64_MAGIC ? 'wide' : 'narrow'
}

interface GeneralPurposeBit {
  useDataDescriptor(b: boolean): void
  encode(): Buffer
}
interface ZipEntry {
  getName(): string
  getMethod(): number
  getTimeDos(): number
  getGeneralPurposeBit(): GeneralPurposeBit
  setVersionNeededToExtract(v: number): void
  getCrc(): number
  getSize(): number
  getCompressedSize(): number
  isZip64(): boolean
  _offsets: { file: number; data: number; contents: number }
}
interface ZipEngine {
  offset: number
  write(chunk: Buffer): boolean
  emit(event: 'error', err: Error): boolean
  _writeLocalFileHeader(ae: ZipEntry): void
  _writeDataDescriptor(ae: ZipEntry): void
}

function assertZipEngine(archive: unknown): ZipEngine {
  const engine = (archive as { _module?: { engine?: Partial<ZipEngine> } })._module?.engine
  if (
    !engine ||
    typeof engine._writeLocalFileHeader !== 'function' ||
    typeof engine._writeDataDescriptor !== 'function' ||
    typeof engine.write !== 'function'
  ) {
    throw new Error('archiver internals changed: large zip entries cannot be written safely')
  }
  return engine as ZipEngine
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

/**
 * Make `archive` (an archiver `ZipArchive`) write wide entries as above. `widthOf`
 * answers by entry name (the name passed to `append`).
 */
export function writeZip64Entries(archive: unknown, widthOf: (name: string) => EntryWidth): void {
  const engine = assertZipEngine(archive)
  const classicHeader = engine._writeLocalFileHeader.bind(engine)
  const classicDescriptor = engine._writeDataDescriptor.bind(engine)

  engine._writeLocalFileHeader = (ae) => {
    if (widthOf(ae.getName()) !== 'wide') {
      classicHeader(ae)
      return
    }
    const gpb = ae.getGeneralPurposeBit()
    // biome-ignore lint/correctness/useHookAtTopLevel: compress-commons' setter, not a React hook
    gpb.useDataDescriptor(true)
    ae.setVersionNeededToExtract(VERSION_ZIP64)
    const name = Buffer.from(ae.getName())
    const extra = Buffer.concat([u16(ZIP64_EXTRA_ID), u16(16), u64(0), u64(0)])
    ae._offsets.file = engine.offset
    engine.write(u32(SIG_LOCAL))
    engine.write(u16(VERSION_ZIP64))
    engine.write(gpb.encode())
    engine.write(u16(ae.getMethod()))
    engine.write(u32(ae.getTimeDos()))
    ae._offsets.data = engine.offset
    engine.write(u32(0))
    engine.write(u32(ZIP64_MAGIC))
    engine.write(u32(ZIP64_MAGIC))
    engine.write(u16(name.length))
    engine.write(u16(extra.length))
    engine.write(name)
    engine.write(extra)
    ae._offsets.contents = engine.offset
  }

  engine._writeDataDescriptor = (ae) => {
    const width = widthOf(ae.getName())
    if (width === 'wide') {
      engine.write(u32(SIG_DESCRIPTOR))
      engine.write(u32(ae.getCrc()))
      engine.write(u64(ae.getCompressedSize()))
      engine.write(u64(ae.getSize()))
      return
    }
    if (width === 'narrow' && ae.isZip64()) {
      engine.emit('error', new Error(`${ae.getName()} is larger than the size given for it`))
      return
    }
    classicDescriptor(ae)
  }
}
