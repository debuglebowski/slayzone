/**
 * Files attached to a chat message (plan item 3.5): what can be sent, how big,
 * and how much a conversation may carry. Shared by the composer (which checks
 * before uploading) and the server (which checks again before writing to the
 * CLI and never trusts what the client says a file is).
 *
 * A message stores REFERENCES (task artifacts), never file bytes: the agent
 * process gets content blocks built from the artifact at write time.
 *
 * @module shared/chat-attachments
 */

export type ChatAttachmentKind = 'image' | 'pdf' | 'text'

/** Image formats the Messages API accepts. */
export const CHAT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
] as const
export type ChatImageMediaType = (typeof CHAT_IMAGE_MEDIA_TYPES)[number]
export type ChatAttachmentMediaType = ChatImageMediaType | 'application/pdf' | 'text/plain'

/** A file attached to a user message: a task artifact plus what it is. */
export interface ChatAttachment {
  artifactId: string
  /**
   * Content hash of the artifact version the message was sent with (set by the
   * server when it takes the message). Blobs are content-addressed, so a
   * queued, retried or resent message reads exactly the file that was
   * attached, even if the artifact changes later.
   */
  contentHash?: string
  /** File name: shown in the chat, and the document `title` the model sees. */
  name: string
  kind: ChatAttachmentKind
  mediaType: ChatAttachmentMediaType
  /** Bytes as stored. */
  size: number
}

const MiB = 1024 * 1024

/**
 * Limits. Sources: the Messages API vision + PDF docs, and Claude Code's own
 * client-side limits (the TUI resizes pasted images to 2000 px).
 */
export const CHAT_ATTACHMENT_LIMITS = {
  /** Long side. Claude Code's TUI cap; also keeps requests valid once a conversation passes 20 images (the API then refuses larger ones). */
  imageMaxDimension: 2000,
  /** Base64 size per image: the strictest provider (Bedrock); the first-party API allows 10 MB. */
  imageMaxBase64Bytes: 5 * MiB,
  /** Raw PDF size: leaves room in the CLI's 32 MB request for the rest of the conversation. */
  pdfMaxBytes: 10 * MiB,
  /** Raw text size (≈64k tokens; Claude Code's Read tool limit). A text the model can't fit breaks every later turn. */
  textMaxBytes: 256 * 1024,
  /** Images + PDFs per message (the API's per-request maximum). */
  maxPerMessage: 100,
  /**
   * Attachments one conversation may carry since its last compaction (encoded
   * bytes). Every turn resends the whole history, and a request the API refuses
   * keeps being refused — the conversation can't continue.
   */
  conversationMaxEncodedBytes: 24 * MiB
} as const

export type ChatAttachmentSniff =
  | { kind: 'image'; mediaType: ChatImageMediaType }
  | { kind: 'pdf'; mediaType: 'application/pdf' }
  | { kind: 'text'; mediaType: 'text/plain' }
  | {
      kind: 'unsupported'
      reason: string
      /** An image a browser can decode (BMP, AVIF, …): the composer converts it to PNG. */
      convertibleImage?: true
    }

/** Bytes the content sniff reads. */
const SNIFF_BYTES = 64 * 1024

function startsWith(b: Uint8Array, sig: ReadonlyArray<number>, at = 0): boolean {
  if (b.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false
  return true
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

/**
 * A C0 control byte no text file contains (NUL, …): tab, newlines, form feed
 * and ESC (terminal colours in logs) don't count.
 */
function isBinaryControl(b: number): boolean {
  return (
    b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0b && b !== 0x0c && b !== 0x0d && b !== 0x1b
  )
}

/** ISO-BMFF brand (`ftyp<brand>` at offset 4): HEIC/AVIF containers. */
function isoBrand(b: Uint8Array): string | null {
  if (!startsWith(b, ascii('ftyp'), 4) || b.length < 12) return null
  return String.fromCharCode(b[8], b[9], b[10], b[11])
}

function indexOfSig(b: Uint8Array, sig: ReadonlyArray<number>, within: number): number {
  const end = Math.min(b.length - sig.length, within)
  for (let i = 0; i <= end; i++) if (startsWith(b, sig, i)) return i
  return -1
}

/**
 * What a file is, from its content (never its name or claimed MIME type).
 * Text = valid UTF-8 without binary control bytes in the first 64 KiB (and not
 * a ZIP container: .docx, .xlsx, …).
 */
export function sniffAttachment(bytes: Uint8Array, name: string): ChatAttachmentSniff {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mediaType: 'image/png' }
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return { kind: 'image', mediaType: 'image/gif' }
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return { kind: 'image', mediaType: 'image/webp' }
  }
  // The PDF header may follow a few junk bytes (spec: within the first 1024).
  if (indexOfSig(bytes, ascii('%PDF-'), 1024) >= 0)
    return { kind: 'pdf', mediaType: 'application/pdf' }

  const brand = isoBrand(bytes)
  if (brand === 'avif' || brand === 'avis') {
    return {
      kind: 'unsupported',
      reason: `${name}: AVIF images are converted to PNG first.`,
      convertibleImage: true
    }
  }
  if (brand && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) {
    return {
      kind: 'unsupported',
      reason: `${name}: HEIC images can't be read here. Export it as PNG or JPEG and attach that.`
    }
  }
  if (startsWith(bytes, ascii('II*\0')) || startsWith(bytes, ascii('MM\0*'))) {
    return {
      kind: 'unsupported',
      reason: `${name}: TIFF images can't be read here. Export it as PNG or JPEG and attach that.`
    }
  }
  // BITMAPFILEHEADER: 'BM', file size, 4 reserved zero bytes, pixel offset.
  if (startsWith(bytes, ascii('BM')) && bytes.length >= 14 && startsWith(bytes, [0, 0, 0, 0], 6)) {
    return {
      kind: 'unsupported',
      reason: `${name}: BMP images are converted to PNG first.`,
      convertibleImage: true
    }
  }

  const head = bytes.subarray(0, SNIFF_BYTES)
  if (!startsWith(bytes, ascii('PK')) && !head.some(isBinaryControl)) {
    try {
      // `stream`: a multi-byte character cut by the sniff window is not an error.
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: bytes.length > SNIFF_BYTES })
      return { kind: 'text', mediaType: 'text/plain' }
    } catch {
      /* not UTF-8 → unsupported below */
    }
  }
  return {
    kind: 'unsupported',
    reason: `${name} can't be attached. Claude reads images (PNG, JPEG, GIF, WebP), PDFs and text files.`
  }
}

/** Size on the wire: base64 for images and PDFs, the text itself for text documents. */
export function attachmentEncodedBytes(a: Pick<ChatAttachment, 'kind' | 'size'>): number {
  return a.kind === 'text' ? a.size : Math.ceil(a.size / 3) * 4
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MiB) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / MiB).toFixed(bytes < 10 * MiB ? 1 : 0)} MB`
}

/** Why a file of this kind and size can't be sent, or null. Images over the cap are downscaled first by the composer. */
export function attachmentSizeError(
  kind: ChatAttachmentKind,
  name: string,
  size: number
): string | null {
  const L = CHAT_ATTACHMENT_LIMITS
  if (kind === 'image' && attachmentEncodedBytes({ kind, size }) > L.imageMaxBase64Bytes) {
    return `${name} is too large (${formatAttachmentSize(size)}) even after resizing. Images can be at most ${formatAttachmentSize((L.imageMaxBase64Bytes * 3) / 4)}.`
  }
  if (kind === 'pdf' && size > L.pdfMaxBytes) {
    return `${name} is ${formatAttachmentSize(size)}. PDFs can be at most ${formatAttachmentSize(L.pdfMaxBytes)}.`
  }
  if (kind === 'text' && size > L.textMaxBytes) {
    return `${name} is too large to attach as text (${formatAttachmentSize(size)}, max ${formatAttachmentSize(L.textMaxBytes)}). Mention it with @path instead, so Claude reads the parts it needs.`
  }
  return null
}

/** One step of a conversation, as the budget counts it. */
export type BudgetEntry =
  | { type: 'message'; id?: string; attachments: ReadonlyArray<ChatAttachment> }
  /** A compaction or a fresh conversation: earlier attachments are no longer sent. */
  | { type: 'boundary' }

/** Encoded attachment bytes the conversation carries since its last boundary (each message once). */
export function conversationAttachmentBytes(entries: Iterable<BudgetEntry>): number {
  let total = 0
  let seen = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'boundary') {
      total = 0
      seen = new Set()
      continue
    }
    if (entry.id !== undefined) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
    }
    for (const a of entry.attachments) total += attachmentEncodedBytes(a)
  }
  return total
}

/** Why a message with these attachments can't join a conversation already carrying `usedBytes`, or null. */
export function conversationBudgetError(
  usedBytes: number,
  attachments: ReadonlyArray<ChatAttachment>
): string | null {
  const L = CHAT_ATTACHMENT_LIMITS
  if (attachments.length > L.maxPerMessage) {
    return `At most ${L.maxPerMessage} files per message.`
  }
  let adding = 0
  for (const a of attachments) adding += attachmentEncodedBytes(a)
  if (adding === 0 || usedBytes + adding <= L.conversationMaxEncodedBytes) return null
  return `This conversation already carries ${formatAttachmentSize(usedBytes)} of attachments; this message would take it past ${formatAttachmentSize(L.conversationMaxEncodedBytes)}, which Claude can't take in one request. Run /compact or start a new chat to attach more.`
}
