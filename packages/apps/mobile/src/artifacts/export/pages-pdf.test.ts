// Follow-up N3: an html artifact's PDF is written page by page as the pictures come,
// never held whole (expo-print takes one HTML string with every picture in it). Each page
// picture (a PNG) becomes a PDF image; the file is read back here as a PDF reader would:
// the cross-reference table, each page's placement, and every image's pixels.
import { unzlibSync, zlibSync } from 'fflate'
import { base64ToBytes, PagesPdf, pngToPdfImage } from './pages-pdf'

const A4 = { width: 595, height: 842, margin: 28 }

// ---------------------------------------------------------------------------------------
// A PNG encoder for the tests: any colour type and bit depth, each row with its filter.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** `rows`: each row's packed samples (no filter byte). `filters`: each row's filter type. */
function png(opts: {
  width: number
  height: number
  colorType: number
  bitDepth?: number
  rows: Uint8Array[]
  filters?: number[]
  palette?: number[][]
  trns?: Uint8Array
  /** Split the image data over this many IDAT chunks. */
  idats?: number
}): Uint8Array {
  const bitDepth = opts.bitDepth ?? 8
  const bpp = Math.max(1, (CHANNELS[opts.colorType] * bitDepth) >> 3)
  const filtered: Uint8Array[] = []
  let prev: Uint8Array = new Uint8Array(opts.rows[0].length)
  opts.rows.forEach((row, y) => {
    const type = opts.filters?.[y % opts.filters.length] ?? 0
    const out = new Uint8Array(row.length + 1)
    out[0] = type
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const predicted =
        type === 1
          ? a
          : type === 2
            ? b
            : type === 3
              ? (a + b) >> 1
              : type === 4
                ? paeth(a, b, c)
                : 0
      out[1 + i] = (row[i] - predicted) & 0xff
    }
    filtered.push(out)
    prev = row
  })
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, opts.width)
  view.setUint32(4, opts.height)
  ihdr[8] = bitDepth
  ihdr[9] = opts.colorType
  const z = zlibSync(concat(filtered))
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)
  ]
  if (opts.palette) parts.push(chunk('PLTE', new Uint8Array(opts.palette.flat())))
  if (opts.trns) parts.push(chunk('tRNS', opts.trns))
  const pieces = opts.idats ?? 1
  const size = Math.ceil(z.length / pieces)
  for (let i = 0; i < pieces; i++) parts.push(chunk('IDAT', z.subarray(i * size, (i + 1) * size)))
  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}

const rgbRows = (w: number, h: number, at: (x: number, y: number) => number[]) =>
  Array.from(
    { length: h },
    (_, y) => new Uint8Array(Array.from({ length: w }, (_, x) => at(x, y)).flat())
  )

// ---------------------------------------------------------------------------------------
// A PDF reader for the tests.

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')

interface ReadPdf {
  text: string
  objects: Map<number, { dict: string; stream: Uint8Array | null }>
  pages: { mediaBox: number[]; content: string; image: { dict: string; stream: Uint8Array } }[]
}

function readPdf(bytes: Uint8Array): ReadPdf {
  const text = latin1(bytes)
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.endsWith('%%EOF\n')).toBe(true)
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1])
  expect(text.slice(startxref, startxref + 5)).toBe('xref\n')
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(startxref))
  if (!head) throw new Error('no xref')
  const count = Number(head[1])
  const table = startxref + head[0].length
  expect(text.slice(table, table + 20)).toBe('0000000000 65535 f\r\n')
  const objects: ReadPdf['objects'] = new Map()
  for (let n = 1; n < count; n++) {
    const entry = text.slice(table + n * 20, table + (n + 1) * 20)
    expect(entry).toMatch(/^\d{10} 00000 n\r\n$/)
    const at = Number(entry.slice(0, 10))
    expect(text.slice(at, at + `${n} 0 obj\n`.length)).toBe(`${n} 0 obj\n`)
    const body = text.slice(at + `${n} 0 obj\n`.length)
    const streamAt = body.indexOf('\nstream\n')
    const endAt = body.indexOf('\nendobj\n')
    if (streamAt >= 0 && streamAt < endAt) {
      const dict = body.slice(0, streamAt)
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1])
      const start = at + `${n} 0 obj\n`.length + streamAt + '\nstream\n'.length
      expect(text.slice(start + length, start + length + '\nendstream\nendobj\n'.length)).toBe(
        '\nendstream\nendobj\n'
      )
      objects.set(n, { dict, stream: bytes.subarray(start, start + length) })
    } else {
      objects.set(n, { dict: body.slice(0, endAt), stream: null })
    }
  }
  expect(/trailer\n<< \/Size (\d+) \/Root 1 0 R >>/.exec(text)?.[1]).toBe(String(count))
  expect(objects.get(1)?.dict).toBe('<< /Type /Catalog /Pages 2 0 R >>')
  const tree = objects.get(2)?.dict ?? ''
  const kids = [...(/\/Kids \[([^\]]*)\]/.exec(tree)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) =>
    Number(m[1])
  )
  expect(tree).toContain(`/Count ${kids.length}`)
  const pages = kids.map((kid) => {
    const page = objects.get(kid)?.dict ?? ''
    expect(page).toContain('/Type /Page /Parent 2 0 R')
    const mediaBox = (/\/MediaBox \[([^\]]*)\]/.exec(page)?.[1] ?? '').split(' ').map(Number)
    const content = objects.get(Number(/\/Contents (\d+) 0 R/.exec(page)?.[1]))
    const image = objects.get(Number(/\/Im0 (\d+) 0 R/.exec(page)?.[1]))
    if (!content?.stream || !image?.stream) throw new Error('page without content or image')
    return {
      mediaBox,
      content: latin1(content.stream),
      image: { dict: image.dict, stream: image.stream }
    }
  })
  return { text, objects, pages }
}

/** An image XObject's samples as a reader decodes them (Flate, then its PNG predictor). */
function samplesOf(image: { dict: string; stream: Uint8Array }): {
  width: number
  height: number
  colors: number
  data: Uint8Array
} {
  const num = (key: string) => Number(new RegExp(`/${key} (\\d+)`).exec(image.dict)?.[1])
  expect(image.dict).toContain('/Type /XObject /Subtype /Image')
  expect(image.dict).toContain('/BitsPerComponent 8')
  expect(image.dict).toContain('/Filter /FlateDecode')
  const width = num('Width')
  const height = num('Height')
  const colors = image.dict.includes('/ColorSpace /DeviceRGB') ? 3 : 1
  if (colors === 1) expect(image.dict).toContain('/ColorSpace /DeviceGray')
  const raw = unzlibSync(image.stream)
  if (!image.dict.includes('/Predictor 15')) {
    expect(raw.length).toBe(width * height * colors)
    return { width, height, colors, data: raw }
  }
  expect(num('Colors')).toBe(colors)
  expect(num('Columns')).toBe(width)
  const stride = width * colors
  const out = new Uint8Array(width * height * colors)
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= colors ? out[y * stride + i - colors] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= colors ? out[(y - 1) * stride + i - colors] : 0
      const p =
        type === 1
          ? a
          : type === 2
            ? b
            : type === 3
              ? (a + b) >> 1
              : type === 4
                ? paeth(a, b, c)
                : 0
      out[y * stride + i] = (x + p) & 0xff
    }
  }
  return { width, height, colors, data: out }
}

/** A writer into memory, recording how much had been written after each page. */
function memoryPdf() {
  const chunks: Uint8Array[] = []
  let written = 0
  const out = {
    write: (bytes: Uint8Array) => {
      chunks.push(bytes.slice())
      written += bytes.length
    }
  }
  const pdf = new PagesPdf(out, A4)
  return { pdf, bytes: () => concat(chunks), written: () => written }
}

// ---------------------------------------------------------------------------------------

describe('pngToPdfImage: a page picture as a PDF image', () => {
  it('an 8-bit RGB PNG goes in as it is: its compressed rows, with the PNG predictor', () => {
    const rows = rgbRows(5, 4, (x, y) => [x * 40, y * 50, (x + y) * 10])
    const file = png({
      width: 5,
      height: 4,
      colorType: 2,
      rows,
      filters: [0, 1, 2, 3, 4],
      idats: 3
    })
    const image = pngToPdfImage(file)
    expect(image).toMatchObject({ width: 5, height: 4, colors: 3, predictor: true })
    const { pdf, bytes } = memoryPdf()
    pdf.addPage(file)
    pdf.finish()
    expect(samplesOf(readPdf(bytes()).pages[0].image).data).toEqual(concat(rows))
  })

  it('RGBA (what a canvas gives) is put on white paper: every filter type undone', () => {
    // Opaque, half and fully transparent pixels.
    const rows = Array.from(
      { length: 6 },
      (_, y) =>
        new Uint8Array(
          Array.from({ length: 7 }, (_, x) => [
            x * 30,
            y * 40,
            200,
            [255, 128, 0][(x + y) % 3]
          ]).flat()
        )
    )
    const file = png({ width: 7, height: 6, colorType: 6, rows, filters: [0, 1, 2, 3, 4, 4] })
    const { pdf, bytes } = memoryPdf()
    pdf.addPage(file)
    pdf.finish()
    const got = samplesOf(readPdf(bytes()).pages[0].image)
    expect(got).toMatchObject({ width: 7, height: 6, colors: 3 })
    const expected: number[] = []
    for (const row of rows)
      for (let i = 0; i < row.length; i += 4) {
        const a = row[i + 3]
        for (let c = 0; c < 3; c++)
          expected.push(Math.round((row[i + c] * a + 255 * (255 - a)) / 255))
      }
    expect(Array.from(got.data)).toEqual(expected)
  })

  it('grey, grey with alpha, a palette and 16-bit samples read right too', () => {
    const gray = png({
      width: 3,
      height: 2,
      colorType: 0,
      rows: [new Uint8Array([0, 128, 255]), new Uint8Array([10, 20, 30])],
      filters: [1, 4]
    })
    const grayAlpha = png({
      width: 2,
      height: 1,
      colorType: 4,
      rows: [new Uint8Array([100, 255, 100, 0])]
    })
    const palette = png({
      width: 4,
      height: 1,
      colorType: 3,
      bitDepth: 2,
      palette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [9, 9, 9]
      ],
      trns: new Uint8Array([255, 255, 0]),
      rows: [new Uint8Array([0b00011011])]
    })
    const deep = png({
      width: 1,
      height: 1,
      colorType: 2,
      bitDepth: 16,
      rows: [new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc])]
    })
    const { pdf, bytes } = memoryPdf()
    for (const file of [gray, grayAlpha, palette, deep]) pdf.addPage(file)
    pdf.finish()
    const [g, ga, p, d] = readPdf(bytes()).pages.map((page) => samplesOf(page.image))
    expect(g).toMatchObject({ colors: 1, data: new Uint8Array([0, 128, 255, 10, 20, 30]) })
    expect(ga).toMatchObject({ colors: 1, data: new Uint8Array([100, 255]) })
    expect(p).toMatchObject({
      colors: 3,
      data: new Uint8Array([255, 0, 0, 0, 255, 0, 255, 255, 255, 9, 9, 9])
    })
    expect(d).toMatchObject({ colors: 3, data: new Uint8Array([0x12, 0x56, 0x9a]) })
  })

  it('refuses what is not a PNG it can read, saying so', () => {
    expect(() => pngToPdfImage(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/)
    const ok = png({ width: 1, height: 1, colorType: 2, rows: [new Uint8Array([1, 2, 3])] })
    const interlaced = ok.slice()
    interlaced[8 + 8 + 12] = 1 // IHDR's interlace byte
    expect(() => pngToPdfImage(interlaced)).toThrow(/interlaced/)
    expect(() => pngToPdfImage(ok.subarray(0, ok.length - 20))).toThrow(/not a PNG/)
  })
})

describe('PagesPdf: the pages, streamed', () => {
  it("lays each picture out as the printed page did: A4, 1cm margins, the page's width, from the top", () => {
    const { pdf, bytes } = memoryPdf()
    const page = (h: number) =>
      png({
        width: 1078,
        height: h,
        colorType: 2,
        rows: Array.from({ length: h }, () => new Uint8Array(1078 * 3))
      })
    pdf.addPage(page(1560))
    pdf.addPage(page(300))
    expect(pdf.finish()).toBe(2)
    const read = readPdf(bytes())
    expect(read.pages).toHaveLength(2)
    for (const p of read.pages) expect(p.mediaBox).toEqual([0, 0, 595, 842])
    // 539 pt wide (the sheet less its margins); as tall as the picture's proportions say.
    expect(read.pages[0].content).toBe('q 539 0 0 780 28 34 cm /Im0 Do Q')
    expect(read.pages[1].content).toBe('q 539 0 0 150 28 664 cm /Im0 Do Q')
  })

  it('a picture taller than the sheet is fitted to its height, centred', () => {
    const { pdf, bytes } = memoryPdf()
    pdf.addPage(
      png({
        width: 10,
        height: 30,
        colorType: 0,
        rows: Array.from({ length: 30 }, () => new Uint8Array(10))
      })
    )
    pdf.finish()
    expect(readPdf(bytes()).pages[0].content).toBe('q 262 0 0 786 166.5 28 cm /Im0 Do Q')
  })

  it('writes each page out as it comes, keeping none of it: thousands of pages, no cap', () => {
    const { pdf, bytes, written } = memoryPdf()
    const file = png({
      width: 2,
      height: 2,
      colorType: 2,
      rows: [new Uint8Array(6), new Uint8Array(6)]
    })
    let last = written()
    for (let i = 0; i < 3000; i++) {
      pdf.addPage(file)
      // The page (its image, its contents, the page itself) is in the file already.
      expect(written()).toBeGreaterThan(last)
      last = written()
    }
    expect(pdf.finish()).toBe(3000)
    expect(readPdf(bytes()).pages).toHaveLength(3000)
  })

  it('a PDF with no page is refused; a finished one takes no more', () => {
    expect(() => memoryPdf().pdf.finish()).toThrow(/no pages/)
    const { pdf } = memoryPdf()
    const file = png({ width: 1, height: 1, colorType: 0, rows: [new Uint8Array(1)] })
    pdf.addPage(file)
    pdf.finish()
    expect(() => pdf.addPage(file)).toThrow(/finished/)
  })
})

describe('base64ToBytes', () => {
  it('decodes what a canvas data URL holds', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'any carnal pleasÿ']) {
      const b64 = Buffer.from(text, 'latin1').toString('base64')
      expect(Buffer.from(base64ToBytes(b64)).toString('latin1')).toBe(text)
    }
    expect(() => base64ToBytes('ab$d')).toThrow(/base64/)
  })
})
