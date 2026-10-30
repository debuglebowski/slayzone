import { describe, expect, test } from 'vitest'
import {
  CHAT_ATTACHMENT_LIMITS,
  attachmentEncodedBytes,
  attachmentSizeError,
  conversationAttachmentBytes,
  conversationBudgetError,
  sniffAttachment,
  type ChatAttachment
} from './chat-attachments'
import { userMessageAttachments, userMessageText, type UserContentBlock } from './agent-events'

const bytes = (...xs: Array<number | string>): Uint8Array => {
  const out: number[] = []
  for (const x of xs) {
    if (typeof x === 'number') out.push(x)
    else for (const c of x) out.push(c.charCodeAt(0))
  }
  return new Uint8Array(out)
}
const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR')
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF')
const GIF = bytes('GIF89a', 1, 0, 1, 0)
const WEBP = bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')
const PDF = bytes('%PDF-1.7\n%')
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const att = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  artifactId: 'a1',
  name: 'photo.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 3,
  ...over
})

describe('sniffAttachment: by content, never by name', () => {
  test('images by magic bytes', () => {
    expect(sniffAttachment(PNG, 'x.bin')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(sniffAttachment(JPEG, 'x')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(sniffAttachment(GIF, 'x')).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(sniffAttachment(WEBP, 'x')).toEqual({ kind: 'image', mediaType: 'image/webp' })
  })

  test('PDF, also after leading bytes', () => {
    expect(sniffAttachment(PDF, 'a.pdf')).toEqual({ kind: 'pdf', mediaType: 'application/pdf' })
    expect(sniffAttachment(bytes(0xef, 0xbb, 0xbf, '%PDF-1.4'), 'a.pdf').kind).toBe('pdf')
  })

  test('UTF-8 text without NUL is a text document (code, markdown, json, svg…)', () => {
    expect(sniffAttachment(utf8('# Title\nhéllo ✓\n'), 'notes.md')).toEqual({
      kind: 'text',
      mediaType: 'text/plain'
    })
    expect(sniffAttachment(utf8('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg').kind).toBe(
      'text'
    )
    expect(sniffAttachment(new Uint8Array(0), 'empty.txt').kind).toBe('text')
    expect(sniffAttachment(utf8('BMW service notes, 2026'), 'car.txt').kind).toBe('text')
  })

  test('a multi-byte character cut by the sniff window is still text', () => {
    const s = 'a'.repeat(64 * 1024 - 1) + 'é' + 'b'.repeat(10)
    expect(sniffAttachment(utf8(s), 'long.txt').kind).toBe('text')
  })

  test('binary and invalid UTF-8 are unsupported, with the format named when known', () => {
    const zip = sniffAttachment(bytes('PK', 3, 4, 20, 0), 'report.docx')
    expect(zip.kind).toBe('unsupported')
    const nul = sniffAttachment(bytes('abc', 0, 'def'), 'data.bin')
    expect(nul.kind).toBe('unsupported')
    const bad = sniffAttachment(bytes(0xc3, 0x28), 'bad.txt')
    expect(bad.kind).toBe('unsupported')
    expect(sniffAttachment(bytes('PK', 3, 4, 1, 2), 'tiny.xlsx').kind).toBe('unsupported')
    expect(sniffAttachment(bytes('ab', 2, 'cd'), 'ctl.bin').kind).toBe('unsupported')
    // Tabs, CRLF, form feed and ANSI colours are text.
    expect(sniffAttachment(bytes('a\tb\r\n', 0x0c, 0x1b, '[31mred'), 'log.txt').kind).toBe('text')
    if (zip.kind === 'unsupported') expect(zip.reason).toMatch(/report\.docx/)
  })

  test('decodable-but-unsent image formats are flagged convertible; HEIC/TIFF are not', () => {
    const bmp = sniffAttachment(bytes('BM', 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0), 'a.bmp')
    expect(bmp).toMatchObject({ kind: 'unsupported', convertibleImage: true })
    const avif = sniffAttachment(bytes(0, 0, 0, 28, 'ftypavif'), 'a.avif')
    expect(avif).toMatchObject({ kind: 'unsupported', convertibleImage: true })
    const heic = sniffAttachment(bytes(0, 0, 0, 24, 'ftypheic'), 'IMG_1.heic')
    expect(heic).toMatchObject({ kind: 'unsupported' })
    expect(heic).not.toMatchObject({ convertibleImage: true })
    if (heic.kind === 'unsupported') expect(heic.reason).toMatch(/HEIC/)
    const tiff = sniffAttachment(bytes('II*', 0, 8, 0), 'a.tif')
    expect(tiff).not.toMatchObject({ convertibleImage: true })
  })
})

describe('limits', () => {
  test('encoded size: base64 for images and PDFs, raw for text', () => {
    expect(attachmentEncodedBytes(att({ size: 3 }))).toBe(4)
    expect(attachmentEncodedBytes(att({ size: 4 }))).toBe(8)
    expect(
      attachmentEncodedBytes(att({ kind: 'pdf', mediaType: 'application/pdf', size: 6 }))
    ).toBe(8)
    expect(attachmentEncodedBytes(att({ kind: 'text', mediaType: 'text/plain', size: 7 }))).toBe(7)
  })

  test('per-kind caps, worded for the user', () => {
    const L = CHAT_ATTACHMENT_LIMITS
    expect(attachmentSizeError('image', 'a.png', 3 * 1024 * 1024)).toBeNull()
    expect(attachmentSizeError('image', 'a.png', 4 * 1024 * 1024)).toMatch(/a\.png/)
    expect(attachmentSizeError('pdf', 'a.pdf', L.pdfMaxBytes)).toBeNull()
    expect(attachmentSizeError('pdf', 'a.pdf', L.pdfMaxBytes + 1)).toMatch(/10 MB/)
    expect(attachmentSizeError('text', 'a.log', L.textMaxBytes)).toBeNull()
    expect(attachmentSizeError('text', 'a.log', L.textMaxBytes + 1)).toMatch(/@/)
  })

  test('limits are the agreed numbers', () => {
    expect(CHAT_ATTACHMENT_LIMITS).toMatchObject({
      imageMaxDimension: 2000,
      imageMaxBase64Bytes: 5 * 1024 * 1024,
      pdfMaxBytes: 10 * 1024 * 1024,
      textMaxBytes: 256 * 1024,
      conversationMaxEncodedBytes: 24 * 1024 * 1024
    })
  })
})

describe('conversation budget', () => {
  const MiB = 1024 * 1024
  const pdf = (id: string, size: number): ChatAttachment =>
    att({ artifactId: id, kind: 'pdf', mediaType: 'application/pdf', size })

  test('sums every message once (by id) since the last boundary', () => {
    const used = conversationAttachmentBytes([
      { type: 'message', id: 'm1', attachments: [pdf('a', 9 * MiB)] },
      { type: 'boundary' },
      { type: 'message', id: 'm2', attachments: [pdf('b', 3 * MiB)] },
      { type: 'message', id: 'm2', attachments: [pdf('b', 3 * MiB)] },
      { type: 'message', id: 'm3', attachments: [att({ size: 3 })] }
    ])
    expect(used).toBe(4 * MiB + 4)
  })

  test('error only when the new message would cross the budget', () => {
    expect(conversationBudgetError(20 * MiB, [pdf('a', 3 * MiB)])).toBeNull()
    expect(conversationBudgetError(20 * MiB, [pdf('a', 4 * MiB)])).toMatch(/\/compact/)
  })
})

describe('content helpers', () => {
  test('text ignores attachments; attachments ignore text', () => {
    const content: UserContentBlock[] = [
      { type: 'attachment', attachment: att() },
      { type: 'text', text: '/x MANGO' }
    ]
    expect(userMessageText(content)).toBe('/x MANGO')
    expect(userMessageAttachments(content)).toEqual([att()])
  })
})
