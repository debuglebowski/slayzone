/**
 * An html artifact's PDF, written page by page as its page pictures come from the hidden
 * web view (`render-pages.ts`), each one written out and dropped before the next: no page
 * count makes the export hold more than one picture. (expo-print takes one HTML string
 * with every picture in it, and its web view decodes them all: memory grows with the
 * page count, which nothing caps.)
 *
 * The PDF is what the print of those pictures was: one A4 sheet a picture, inside 1cm
 * margins, at the sheet's printable width, from its top — pictures only, nothing of the
 * artifact's (no text, no link, no script). Each picture (a PNG) becomes an image:
 * an 8-bit RGB or grey one goes in as it is (its compressed rows, read with the PNG
 * predictor); any other is decoded, put on white paper (its alpha), and compressed again.
 */
import { unzlibSync, zlibSync } from 'fflate'

/** Where the PDF's bytes go, in order (a file handle: `FileHandle.writeBytesSync`). */
export interface PdfByteSink {
  write: (bytes: Uint8Array) => void
}

/** The sheet, in points, and its margin on every side. */
export interface PdfSheet {
  width: number
  height: number
  margin: number
}

/** A page picture as a PDF image: its samples, compressed (`/FlateDecode`). */
export interface PdfImage {
  width: number
  height: number
  /** 1: grey, 3: RGB; 8 bits a sample. */
  colors: 1 | 3
  /** The samples' rows each open with a PNG filter byte (`/Predictor 15`). */
  predictor: boolean
  data: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Samples a pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
}

const notPng = (why: string) =>
  new Error(`A page picture is not a PNG the export can read (${why}).`)

/** A page picture (PNG bytes) as a PDF image. */
export function pngToPdfImage(png: Uint8Array): PdfImage {
  if (png.length < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw notPng('no signature')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let ended = false
  for (let at = 8; at < png.length && !ended; ) {
    if (at + 12 > png.length) throw notPng('a cut chunk')
    const length = view.getUint32(at)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const start = at + 8
    if (start + length + 4 > png.length) throw notPng('a cut chunk')
    const data = png.subarray(start, start + length)
    if (type === 'IHDR') {
      if (length !== 13) throw notPng('a bad header')
      width = view.getUint32(start)
      height = view.getUint32(start + 4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[10] !== 0 || data[11] !== 0) throw notPng('an unknown compression')
      if (data[12] !== 0) throw notPng('it is interlaced')
      if (!BIT_DEPTHS[colorType]?.includes(bitDepth)) throw notPng('an unknown pixel format')
      if (width === 0 || height === 0) throw notPng('no pixels')
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      ended = true
    }
    at = start + length + 4
  }
  if (colorType < 0) throw notPng('no header')
  if (!ended) throw notPng('no end')
  if (idat.length === 0) throw notPng('no pixels')
  if (colorType === 3 && !palette) throw notPng('no palette')
  const compressed = idat.length === 1 ? idat[0] : joinBytes(idat)

  // As it is: 8-bit RGB or grey with no transparent colour (what an opaque canvas gives).
  if (bitDepth === 8 && (colorType === 2 || colorType === 0) && !transparency) {
    return {
      width,
      height,
      colors: colorType === 2 ? 3 : 1,
      predictor: true,
      data: compressed.slice()
    }
  }
  const colors: 1 | 3 = colorType === 0 || colorType === 4 ? 1 : 3
  const samples = decodeOnPaper(unzlibSync(compressed), {
    width,
    height,
    bitDepth,
    colorType,
    colors,
    palette,
    transparency
  })
  return { width, height, colors, predictor: false, data: zlibSync(samples, { level: 6 }) }
}

/** The picture's pixels, unfiltered, each put on white paper: 8-bit grey or RGB. */
function decodeOnPaper(
  raw: Uint8Array,
  png: {
    width: number
    height: number
    bitDepth: number
    colorType: number
    colors: 1 | 3
    palette: Uint8Array | null
    transparency: Uint8Array | null
  }
): Uint8Array {
  const { width, height, bitDepth, colorType, colors, palette, transparency } = png
  const channels = CHANNELS[colorType]
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  if (raw.length < height * (stride + 1)) throw notPng('too few pixels')
  const out = new Uint8Array(width * height * colors)
  let prev = new Uint8Array(stride)
  let row = new Uint8Array(stride)
  const maxSample = (1 << Math.min(bitDepth, 8)) - 1
  // A transparent colour (tRNS of a grey or RGB picture), in the picture's own samples.
  const key =
    transparency && colorType !== 3
      ? Array.from(
          { length: channels },
          (_, c) => (transparency[c * 2] << 8) | transparency[c * 2 + 1]
        )
      : null
  const sample = (x: number, c: number): number => {
    if (bitDepth === 8) return row[x * channels + c]
    if (bitDepth === 16) return (row[(x * channels + c) * 2] << 8) | row[(x * channels + c) * 2 + 1]
    const bit = x * bitDepth
    return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxSample
  }
  /** A sample as 8 bits. */
  const eight = (v: number): number =>
    bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / maxSample)
  const onPaper = (v: number, alpha: number): number =>
    alpha === 255 ? v : ((v * alpha + 255 * (255 - alpha)) / 255 + 0.5) | 0

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    unfilter(raw[base], raw.subarray(base + 1, base + 1 + stride), prev, row, bpp)
    if (colorType === 6 && bitDepth === 8) {
      // What a canvas gives: one tight loop (Hermes runs no JIT).
      for (let x = 0, i = 0, o = y * width * 3; x < width; x++, i += 4, o += 3) {
        const alpha = row[i + 3]
        if (alpha === 255) {
          out[o] = row[i]
          out[o + 1] = row[i + 1]
          out[o + 2] = row[i + 2]
        } else {
          out[o] = onPaper(row[i], alpha)
          out[o + 1] = onPaper(row[i + 1], alpha)
          out[o + 2] = onPaper(row[i + 2], alpha)
        }
      }
      const done = prev
      prev = row
      row = done
      continue
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * colors
      if (colorType === 3) {
        const index = sample(x, 0)
        if (!palette || index * 3 + 2 >= palette.length) throw notPng('a colour not in its palette')
        const alpha = transparency && index < transparency.length ? transparency[index] : 255
        for (let c = 0; c < 3; c++) out[o + c] = onPaper(palette[index * 3 + c], alpha)
        continue
      }
      let alpha = 255
      if (colorType === 4 || colorType === 6) alpha = eight(sample(x, channels - 1))
      else if (key && key.every((k, c) => sample(x, c) === k)) alpha = 0
      for (let c = 0; c < colors; c++) out[o + c] = onPaper(eight(sample(x, c)), alpha)
    }
    const done = prev
    prev = row
    row = done
  }
  return out
}

/** One row's PNG filter undone into `out`, from its filtered bytes and the row above. */
function unfilter(
  type: number,
  line: Uint8Array,
  above: Uint8Array,
  out: Uint8Array,
  bpp: number
): void {
  const n = line.length
  switch (type) {
    case 0:
      out.set(line)
      return
    case 1:
      for (let i = 0; i < n; i++) out[i] = (line[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff
      return
    case 2:
      for (let i = 0; i < n; i++) out[i] = (line[i] + above[i]) & 0xff
      return
    case 3:
      for (let i = 0; i < n; i++)
        out[i] = (line[i] + (((i >= bpp ? out[i - bpp] : 0) + above[i]) >> 1)) & 0xff
      return
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0
        const b = above[i]
        const c = i >= bpp ? above[i - bpp] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        out[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      return
    default:
      throw notPng('an unknown row filter')
  }
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0
  for (const p of parts) size += p.length
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = (() => {
  const values = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64_ALPHABET.length; i++) values[BASE64_ALPHABET.charCodeAt(i)] = i
  return values
})()

/** Standard base64 (a canvas data URL's) as bytes, without a binary string between. */
export function base64ToBytes(text: string): Uint8Array {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end--
  const padding = text.length - end
  if (padding > 2 || (padding > 0 && text.length % 4 !== 0) || end % 4 === 1) {
    throw new Error('Not base64: bad padding.')
  }
  const out = new Uint8Array(Math.floor((end * 3) / 4))
  let bits = 0
  let held = 0
  let at = 0
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i)
    const value = code < 128 ? BASE64_VALUES[code] : -1
    if (value < 0) throw new Error('Not base64: an unknown character.')
    // Only the bits not yet written are kept (at most 14).
    bits = ((bits << 6) | value) & 0x3fff
    held += 6
    if (held >= 8) {
      held -= 8
      out[at++] = (bits >> held) & 0xff
    }
  }
  return at === out.length ? out : out.subarray(0, at)
}

/** A number as a PDF writes it: no exponent, at most 3 decimals. */
function num(value: number): string {
  const fixed = value.toFixed(3)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/**
 * A PDF of page pictures, streamed to `out`: `addPage` writes its page whole (image,
 * contents, page) before it returns; `finish` writes the page tree, the cross-reference
 * table and the trailer. All it keeps between pages is each object's offset.
 *
 * Objects: 1 the catalog, 2 the page tree (written last), then three a page.
 */
export class PagesPdf {
  private offset = 0
  /** Each object's byte offset, by number (0: the free list head). */
  private readonly offsets: number[] = [0, 0, 0]
  private readonly pages: number[] = []
  private finished = false

  constructor(
    private readonly out: PdfByteSink,
    private readonly sheet: PdfSheet
  ) {
    // A binary comment second, so the file is read as binary.
    this.write(ascii('%PDF-1.4\n'))
    this.write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  }

  get pageCount(): number {
    return this.pages.length
  }

  /** A page of the picture `png` (PNG bytes), written out before this returns. */
  addPage(png: Uint8Array): void {
    if (this.finished) throw new Error('The PDF is finished: no page can be added.')
    const image = pngToPdfImage(png)
    const imageRef = this.object(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode${image.predictor ? ` /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent 8 /Columns ${image.width} >>` : ''}`,
      image.data
    )
    const { width, height, margin } = this.sheet
    const room = { width: width - 2 * margin, height: height - 2 * margin }
    // The printable width, as tall as the picture's proportions say; fitted to the
    // height (centred) if that is taller than the sheet. From the top of the sheet.
    const scale = Math.min(room.width / image.width, room.height / image.height)
    const w = image.width * scale
    const h = image.height * scale
    const x = margin + (room.width - w) / 2
    const y = height - margin - h
    const contentRef = this.object(
      '<<',
      ascii(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`)
    )
    this.pages.push(
      this.object(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources << /XObject << /Im0 ${imageRef} 0 R >> >> /Contents ${contentRef} 0 R >>`
      )
    )
  }

  /** The page tree, catalog, cross-reference table and trailer; the page count. */
  finish(): number {
    if (this.finished) throw new Error('The PDF is finished already.')
    if (this.pages.length === 0) throw new Error('The PDF has no pages.')
    this.finished = true
    this.offsets[2] = this.offset
    this.write(
      ascii(
        `2 0 obj\n<< /Type /Pages /Kids [${this.pages.map((n) => `${n} 0 R`).join(' ')}] /Count ${this.pages.length} >>\nendobj\n`
      )
    )
    this.offsets[1] = this.offset
    this.write(ascii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'))
    const xref = this.offset
    const size = this.offsets.length
    const entries = ['xref\n', `0 ${size}\n`, '0000000000 65535 f\r\n']
    for (let n = 1; n < size; n++)
      entries.push(`${String(this.offsets[n]).padStart(10, '0')} 00000 n\r\n`)
    entries.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    this.write(ascii(entries.join('')))
    return this.pages.length
  }

  /** An object: `dict` alone, or (`stream`) a stream whose dictionary opens with `dict`. */
  private object(dict: string, stream?: Uint8Array): number {
    const n = this.offsets.length
    this.offsets.push(this.offset)
    if (!stream) {
      this.write(ascii(`${n} 0 obj\n${dict}\nendobj\n`))
      return n
    }
    const open = dict === '<<' ? '<<' : dict
    this.write(ascii(`${n} 0 obj\n${open} /Length ${stream.length} >>\nstream\n`))
    this.write(stream)
    this.write(ascii('\nendstream\nendobj\n'))
    return n
  }

  private write(bytes: Uint8Array): void {
    this.out.write(bytes)
    this.offset += bytes.length
  }
}
