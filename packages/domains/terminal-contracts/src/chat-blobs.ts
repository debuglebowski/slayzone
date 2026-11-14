/**
 * Binary payloads of saved chat events, stored OUT-OF-LINE (crash fix 4).
 *
 * Tool results carry screenshots and files as base64 strings (Anthropic
 * `source.data`, MCP `data` / resource `blob`, Claude Read's
 * `structured.file.base64`). The computer stores those bytes once, in its
 * content-addressed blob store, and the saved event keeps a {@link ChatBlobRef}
 * IN PLACE of the string. Readers get the reference and load the bytes lazily
 * (`readBlob`), so history reads, replays and relays stay small.
 *
 * The transform is LOSSLESS: `resolveChatBlobs(extractChatBlobs(x).value)` deep-equals
 * `x`. It only ever replaces a base64 string inside an object whose SHAPE names
 * it as a binary slot — those objects only occur under the `unknown`-typed
 * payload fields (`rawContent`, `structured`, `raw`, `input`), so typed fields
 * (text, ids) are never touched and the event stays a valid AgentEvent.
 *
 * RAW content (what an agent produced) may itself hold an object shaped like a
 * reference: extraction wraps such objects in a {@link CHAT_BLOB_LITERAL_KEY}
 * escape, which resolution unwraps — a tool output can never forge a reference.
 * So extraction runs ONCE, on raw content; stored content is never re-extracted
 * (the store marks which rows hold the extracted form).
 *
 * Pure: no hashing or bytes here — the caller's `put` decodes, hashes and
 * stores (and may decline, e.g. non-canonical base64, leaving the slot inline).
 *
 * @module chat-blobs
 */

/** Key of a reference object. */
export const CHAT_BLOB_KEY = '$chatBlob'
/** Key of an escaped raw object that happened to look like a reference (or an escape). */
export const CHAT_BLOB_LITERAL_KEY = '$chatBlobLiteral'

/**
 * Base64 strings shorter than this stay inline: a reference, its pin and a file
 * cost more than a tiny icon, and short strings that merely look like base64 are
 * never turned into blobs.
 */
export const CHAT_BLOB_MIN_BASE64 = 1024

export interface ChatBlobRefBody {
  v: 1
  /** sha256 (hex) of the decoded bytes: the blob's name in the store. */
  sha256: string
  /** As the slot declared it (`media_type` / `mimeType` / `type`). */
  mediaType: string
  /** Decoded byte size. */
  size: number
}

/** What a saved event holds instead of a base64 string. */
export interface ChatBlobRef {
  $chatBlob: ChatBlobRefBody
}

/** One bounded chunk of a stored blob, as `chat.readBlob` returns it. */
export interface ChatBlobChunk {
  mediaType: string
  /** Size of the whole blob (bytes). */
  size: number
  /** Where this chunk starts. */
  offset: number
  /** The chunk's bytes, base64. Empty at the end. */
  data: string
}

/** Stores the bytes of `base64`; null declines (the slot stays inline). */
export type ChatBlobPut = (base64: string, mediaType: string) => ChatBlobRefBody | null
/** The base64 string a reference stands for (throws when unavailable). */
export type ChatBlobGet = (ref: ChatBlobRefBody) => string

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** An object whose only key is `key`. */
function soleKey(v: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === key
}

/** Raw objects extraction must escape: anything a reader would take for a reference or an escape. */
function needsEscape(v: Record<string, unknown>): boolean {
  return soleKey(v, CHAT_BLOB_KEY) || soleKey(v, CHAT_BLOB_LITERAL_KEY)
}

/** An escape made by {@link extractChatBlobs} (not a type guard: escapes are plain records too). */
function isLiteral(v: unknown): boolean {
  return isRecord(v) && soleKey(v, CHAT_BLOB_LITERAL_KEY)
}

export function isChatBlobRef(v: unknown): v is ChatBlobRef {
  if (!isRecord(v) || !soleKey(v, CHAT_BLOB_KEY)) return false
  const b = v[CHAT_BLOB_KEY]
  return (
    isRecord(b) &&
    b.v === 1 &&
    typeof b.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(b.sha256) &&
    typeof b.mediaType === 'string' &&
    typeof b.size === 'number' &&
    Number.isSafeInteger(b.size) &&
    b.size >= 0
  )
}

/** A binary slot of `o`: which key holds the base64 and its declared media type. */
function binarySlot(o: Record<string, unknown>): { key: string; mediaType: string } | null {
  // Anthropic `source` of an image / document block.
  if (o.type === 'base64' && typeof o.data === 'string' && typeof o.media_type === 'string')
    return { key: 'data', mediaType: o.media_type }
  // MCP image / audio content block.
  if (
    (o.type === 'image' || o.type === 'audio') &&
    typeof o.data === 'string' &&
    typeof o.mimeType === 'string'
  )
    return { key: 'data', mediaType: o.mimeType }
  // MCP embedded resource (`resource: {uri, blob, mimeType?}`).
  if (typeof o.uri === 'string' && typeof o.blob === 'string')
    return {
      key: 'blob',
      mediaType: typeof o.mimeType === 'string' ? o.mimeType : 'application/octet-stream'
    }
  // Claude Read of an image: `toolUseResult.file.{base64,type}`.
  if (typeof o.base64 === 'string' && typeof o.type === 'string' && o.type.includes('/'))
    return { key: 'base64', mediaType: o.type }
  return null
}

/**
 * RAW `value` with every binary slot ≥ {@link CHAT_BLOB_MIN_BASE64} replaced by a
 * reference from `put` (and reference-shaped objects escaped), plus the
 * references made, in document order, one per slot. Never mutates `value`; when
 * nothing changes it returns `value` itself. Apply once: the result is STORED
 * form, not raw content.
 */
export function extractChatBlobs<T>(
  value: T,
  put: ChatBlobPut
): { value: T; refs: ChatBlobRefBody[] } {
  const refs: ChatBlobRefBody[] = []
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let out: unknown[] | null = null
      for (let i = 0; i < v.length; i++) {
        const next = walk(v[i])
        if (next !== v[i]) {
          out ??= v.slice()
          out[i] = next
        }
      }
      return out ?? v
    }
    if (!isRecord(v)) return v
    // Escaped verbatim: its contents are raw data, not slots.
    if (needsEscape(v)) return { [CHAT_BLOB_LITERAL_KEY]: v }
    let out: Record<string, unknown> | null = null
    const slot = binarySlot(v)
    if (slot) {
      const base64 = v[slot.key] as string
      if (base64.length >= CHAT_BLOB_MIN_BASE64) {
        const body = put(base64, slot.mediaType)
        if (body) {
          out = { ...v, [slot.key]: { [CHAT_BLOB_KEY]: body } satisfies ChatBlobRef }
          refs.push(body)
        }
      }
    }
    for (const key of Object.keys(v)) {
      if (slot && key === slot.key) continue
      const next = walk(v[key])
      if (next !== v[key]) {
        out ??= { ...v }
        out[key] = next
      }
    }
    return out ?? v
  }
  return { value: walk(value) as T, refs }
}

/** STORED `value` with every reference replaced by the base64 string it stands for (escapes unwrapped). */
export function resolveChatBlobs<T>(value: T, get: ChatBlobGet): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let out: unknown[] | null = null
      for (let i = 0; i < v.length; i++) {
        const next = walk(v[i])
        if (next !== v[i]) {
          out ??= v.slice()
          out[i] = next
        }
      }
      return out ?? v
    }
    if (!isRecord(v)) return v
    if (isChatBlobRef(v)) return get(v.$chatBlob)
    if (isLiteral(v)) return v[CHAT_BLOB_LITERAL_KEY]
    let out: Record<string, unknown> | null = null
    for (const key of Object.keys(v)) {
      const next = walk(v[key])
      if (next !== v[key]) {
        out ??= { ...v }
        out[key] = next
      }
    }
    return out ?? v
  }
  return walk(value) as T
}

/** Every reference in STORED `value`, in document order (duplicates included; escapes skipped). */
export function chatBlobRefs(value: unknown): ChatBlobRefBody[] {
  const out: ChatBlobRefBody[] = []
  const pending: unknown[] = [value]
  while (pending.length) {
    const v = pending.pop()
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) pending.push(v[i])
    } else if (isRecord(v)) {
      if (isChatBlobRef(v)) out.push(v.$chatBlob)
      else if (!isLiteral(v)) {
        const keys = Object.keys(v)
        for (let i = keys.length - 1; i >= 0; i--) pending.push(v[keys[i]])
      }
    }
  }
  return out
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** `[image/png · 120 KB]`: how text output shows a reference. */
export function formatChatBlobRef(ref: ChatBlobRefBody): string {
  return `[${ref.mediaType} · ${formatBytes(ref.size)}]`
}

/**
 * `JSON.stringify` replacer for STORED values: references print as
 * {@link formatChatBlobRef}, escapes as the raw object they hold.
 */
export function chatBlobJsonReplacer(_key: string, value: unknown): unknown {
  if (isChatBlobRef(value)) return formatChatBlobRef(value.$chatBlob)
  if (isLiteral(value)) return (value as Record<string, unknown>)[CHAT_BLOB_LITERAL_KEY]
  return value
}

/** Base64 → bytes (no Buffer: renderer, mobile, node alike). */
export function base64ToBytes(base64: string): Uint8Array {
  const text = atob(base64)
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

/** Bytes → base64 (no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** One chunk of a stored blob, by sha256 and offset (`chat.readBlob`, `chat.archives.blob`). */
export type ChatBlobChunkReader = (sha256: string, offset: number) => Promise<ChatBlobChunk>

/**
 * The bytes `ref` stands for, read chunk by chunk and checked: every chunk where it
 * should start, the size the reference states, and — where WebCrypto exists (every
 * client but a non-secure web context) — its sha256. Throws on any mismatch.
 */
export async function readChatBlob(
  read: ChatBlobChunkReader,
  ref: ChatBlobRefBody
): Promise<Uint8Array> {
  const all = new Uint8Array(ref.size)
  let offset = 0
  while (offset < ref.size) {
    const chunk = await read(ref.sha256, offset)
    if (chunk.offset !== offset || chunk.size !== ref.size)
      throw new Error('Stored blob chunk integrity mismatch')
    const bytes = base64ToBytes(chunk.data)
    if (!bytes.length || offset + bytes.length > ref.size)
      throw new Error('Stored blob size integrity mismatch')
    all.set(bytes, offset)
    offset += bytes.length
  }
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', all as Uint8Array<ArrayBuffer>))
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    if (hex !== ref.sha256) throw new Error('Stored blob hash integrity mismatch')
  }
  return all
}

/**
 * RAW `value` in stored form WITHOUT moving any bytes: reference-shaped objects
 * escaped, base64 left inline. How a store serves rows saved before it extracted
 * (legacy rows), so every reader gets one form and a printed look-alike is never
 * taken for a reference.
 */
export function escapeChatBlobLiterals<T>(value: T): T {
  return extractChatBlobs(value, () => null).value
}
