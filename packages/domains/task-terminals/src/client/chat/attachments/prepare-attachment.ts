/**
 * A picked / pasted / dropped file, made ready to attach: what it is comes from
 * its content (`sniffAttachment`), images Claude can't take are converted, and
 * images over the limits are shrunk — as Claude Code's TUI does with pasted
 * images — before they are uploaded. Anything that can't be sent is refused
 * with a reason the composer shows.
 *
 * @module task-terminals/client/chat/attachments/prepare-attachment
 */
import {
  CHAT_ATTACHMENT_LIMITS,
  attachmentEncodedBytes,
  attachmentSizeError,
  sniffAttachment,
  type ChatAttachmentKind,
  type ChatAttachmentMediaType
} from '@slayzone/terminal-contracts'

/** Image decode + re-encode. The browser one uses `createImageBitmap` + `OffscreenCanvas`. */
export interface ImageCodec {
  /** Natural size, or null when this platform can't decode the image. */
  size(image: Blob): Promise<{ width: number; height: number } | null>
  /** Re-encode, scaled down (never up) to fit `maxDimension` on its long side. */
  encode(
    image: Blob,
    opts: { maxDimension: number; type: 'image/png' | 'image/jpeg'; quality?: number }
  ): Promise<Blob>
}

export type PreparedAttachment =
  | { ok: true; file: File; kind: ChatAttachmentKind; mediaType: ChatAttachmentMediaType }
  | { ok: false; reason: string }

/** Read no further than this into a file that is too big for any kind anyway. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024
/** JPEG qualities tried, in order, when an image is still too big. */
const JPEG_QUALITIES = [0.85, 0.7, 0.55] as const
/** Then the long side shrinks by this factor per round. */
const SHRINK = 0.75
const MAX_SHRINK_ROUNDS = 4

function renamed(name: string, type: 'image/png' | 'image/jpeg'): string {
  const ext = type === 'image/png' ? '.png' : '.jpg'
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name || 'image') + ext
}

function fitsImageLimit(bytes: number): boolean {
  return (
    attachmentEncodedBytes({ kind: 'image', size: bytes }) <=
    CHAT_ATTACHMENT_LIMITS.imageMaxBase64Bytes
  )
}

async function shrinkImage(
  file: File,
  dims: { width: number; height: number },
  codec: ImageCodec,
  keepPng: boolean
): Promise<PreparedAttachment> {
  let maxDimension = Math.min(
    CHAT_ATTACHMENT_LIMITS.imageMaxDimension,
    Math.max(dims.width, dims.height)
  )
  const first = keepPng ? ('image/png' as const) : ('image/jpeg' as const)
  const firstBlob = await codec.encode(file, {
    maxDimension,
    type: first,
    ...(first === 'image/jpeg' ? { quality: 0.9 } : {})
  })
  if (fitsImageLimit(firstBlob.size)) {
    return {
      ok: true,
      file: new File([firstBlob], renamed(file.name, first), { type: first }),
      kind: 'image',
      mediaType: first
    }
  }
  for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
    for (const quality of JPEG_QUALITIES) {
      const blob = await codec.encode(file, { maxDimension, type: 'image/jpeg', quality })
      if (fitsImageLimit(blob.size)) {
        return {
          ok: true,
          file: new File([blob], renamed(file.name, 'image/jpeg'), { type: 'image/jpeg' }),
          kind: 'image',
          mediaType: 'image/jpeg'
        }
      }
    }
    maxDimension = Math.floor(maxDimension * SHRINK)
  }
  return {
    ok: false,
    reason: attachmentSizeError('image', file.name, Number.MAX_SAFE_INTEGER) ?? ''
  }
}

export async function prepareAttachmentFile(
  file: File,
  codec: ImageCodec
): Promise<PreparedAttachment> {
  if (file.size > MAX_INPUT_BYTES) {
    return { ok: false, reason: `${file.name} is too large to attach.` }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sniff = sniffAttachment(bytes, file.name)

  if (sniff.kind === 'unsupported') {
    if (!sniff.convertibleImage) return { ok: false, reason: sniff.reason }
    const dims = await codec.size(file)
    if (!dims) return { ok: false, reason: `${file.name} can't be read as an image.` }
    return shrinkImage(file, dims, codec, true)
  }

  if (sniff.kind === 'image') {
    const dims = await codec.size(file)
    if (!dims) return { ok: false, reason: `${file.name} can't be read as an image.` }
    const tooLarge = Math.max(dims.width, dims.height) > CHAT_ATTACHMENT_LIMITS.imageMaxDimension
    if (!tooLarge && fitsImageLimit(file.size)) {
      return { ok: true, file, kind: 'image', mediaType: sniff.mediaType }
    }
    // Photos stay JPEG; screenshots, GIFs and WebP become PNG (lossless) first.
    return shrinkImage(file, dims, codec, sniff.mediaType !== 'image/jpeg')
  }

  const tooBig = attachmentSizeError(sniff.kind, file.name, file.size)
  if (tooBig) return { ok: false, reason: tooBig }
  return { ok: true, file, kind: sniff.kind, mediaType: sniff.mediaType }
}

/** The renderer's codec (Electron and browsers). */
export const browserImageCodec: ImageCodec = {
  async size(image) {
    try {
      const bitmap = await createImageBitmap(image)
      const dims = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dims
    } catch {
      return null
    }
  },
  async encode(image, { maxDimension, type, quality }) {
    const bitmap = await createImageBitmap(image)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      throw new Error('no 2d canvas')
    }
    if (type === 'image/jpeg') {
      // JPEG has no alpha: transparent pixels would turn black.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return canvas.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) })
  }
}
