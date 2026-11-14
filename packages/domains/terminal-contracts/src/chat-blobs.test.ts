/**
 * chat-blobs: base64 payloads of saved chat events stored out-of-line, as typed
 * references. The transform must be LOSSLESS (resolve ∘ extract = identity).
 */
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  CHAT_BLOB_MIN_BASE64,
  chatBlobJsonReplacer,
  chatBlobRefs,
  extractChatBlobs,
  formatChatBlobRef,
  isChatBlobRef,
  resolveChatBlobs,
  type ChatBlobRefBody
} from './chat-blobs.js'

/** A fake store: base64 → body keyed by a cheap content key (the real one hashes bytes). */
function fakeStore() {
  const byKey = new Map<string, string>()
  const puts: string[] = []
  const put = (base64: string, mediaType: string): ChatBlobRefBody => {
    puts.push(base64)
    const sha256 = createHash('sha256').update(base64).digest('hex')
    byKey.set(sha256, base64)
    return { v: 1, sha256, mediaType, size: Math.floor((base64.length * 3) / 4) }
  }
  const get = (ref: ChatBlobRefBody) => {
    const b = byKey.get(ref.sha256)
    if (b === undefined) throw new Error('missing')
    return b
  }
  return { put, get, puts, byKey }
}

const big = (seed: string, n = CHAT_BLOB_MIN_BASE64 * 2) => {
  let s = ''
  while (s.length < n) s += seed
  return s.slice(0, n)
}
const PNG = big('iVBORw0KGgoAAAANSUhEUg')
const JPG = big('/9j/4AAQSkZJRgABAQAAAQ')

const anthropicImage = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data }
})
const toolResult = (rawContent: unknown, structured: unknown = null) => ({
  kind: 'tool-result' as const,
  toolUseId: 'tu1',
  isError: false,
  rawContent,
  structured
})

describe('extractChatBlobs', () => {
  test('Anthropic base64 source (image and document)', () => {
    const s = fakeStore()
    const doc = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: JPG }
    }
    const event = toolResult([anthropicImage(PNG), doc, { type: 'text', text: 'hi' }])
    const { value, refs } = extractChatBlobs(event, s.put)
    expect(refs.map((r) => r.mediaType)).toEqual(['image/png', 'application/pdf'])
    const raw = value.rawContent as Array<{ source?: { data: unknown } }>
    expect(isChatBlobRef(raw[0].source!.data)).toBe(true)
    expect(isChatBlobRef(raw[1].source!.data)).toBe(true)
    expect(raw[2]).toEqual({ type: 'text', text: 'hi' })
  })

  test('MCP image/audio blocks and embedded resource blobs', () => {
    const s = fakeStore()
    const event = toolResult([
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'audio', data: JPG, mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: { uri: 'file:///x.bin', blob: big('AAEC'), mimeType: 'application/zip' }
      }
    ])
    const { refs } = extractChatBlobs(event, s.put)
    expect(refs.map((r) => r.mediaType)).toEqual(['image/png', 'audio/wav', 'application/zip'])
  })

  test('Claude Read structured file.base64 and Codex MCP structured.result.content', () => {
    const s = fakeStore()
    const event = toolResult([anthropicImage(PNG)], {
      type: 'image',
      file: { base64: PNG, type: 'image/png', originalSize: 1234 }
    })
    const codex = toolResult('', {
      type: 'mcpToolCall',
      result: { content: [{ type: 'image', data: JPG, mimeType: 'image/jpeg' }] }
    })
    const a = extractChatBlobs(event, s.put)
    const b = extractChatBlobs(codex, s.put)
    expect(a.refs).toHaveLength(2)
    expect((a.value.structured as { file: { base64: unknown } }).file.base64).toEqual(
      a.value.rawContent &&
        (a.value.rawContent as Array<{ source: { data: unknown } }>)[0].source.data
    )
    expect(b.refs).toHaveLength(1)
  })

  test('raw CLI lines of `unknown` events are covered too', () => {
    const s = fakeStore()
    const event = {
      kind: 'unknown' as const,
      raw: {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [anthropicImage(PNG)] }] }
      }
    }
    expect(extractChatBlobs(event, s.put).refs).toHaveLength(1)
  })

  test('payloads below the threshold stay inline', () => {
    const s = fakeStore()
    const small = PNG.slice(0, CHAT_BLOB_MIN_BASE64 - 4)
    const event = toolResult([anthropicImage(small)])
    const out = extractChatBlobs(event, s.put)
    expect(out.refs).toEqual([])
    expect(out.value).toBe(event)
    expect(s.puts).toEqual([])
  })

  test('a sink that declines (non-canonical base64) leaves the slot inline', () => {
    const event = toolResult([anthropicImage(PNG)])
    const out = extractChatBlobs(event, () => null)
    expect(out.refs).toEqual([])
    expect(out.value).toBe(event)
  })

  test('typed text fields are never touched, even when they hold base64-like text', () => {
    const s = fakeStore()
    const text = { kind: 'assistant-text' as const, text: PNG }
    const user = {
      kind: 'user-message' as const,
      text: PNG,
      content: [{ type: 'text', text: PNG }]
    }
    expect(extractChatBlobs(text, s.put).value).toBe(text)
    expect(extractChatBlobs(user, s.put).value).toBe(user)
    expect(extractChatBlobs(toolResult(PNG), s.put).value.rawContent).toBe(PNG)
  })

  test('does not mutate its input; unchanged subtrees keep their identity', () => {
    const s = fakeStore()
    const keep = { type: 'text', text: 'x' }
    const event = toolResult([anthropicImage(PNG), keep])
    const before = JSON.stringify(event)
    const out = extractChatBlobs(event, s.put)
    expect(JSON.stringify(event)).toBe(before)
    expect((out.value.rawContent as unknown[])[1]).toBe(keep)
  })

  test('ref-shaped objects already in raw content are escaped, never taken for references', () => {
    const s = fakeStore()
    const body = { v: 1, sha256: 'b'.repeat(64), mediaType: 'image/png', size: 9 }
    const forged = { $chatBlob: body }
    const literal = { $chatBlobLiteral: { x: 1 } }
    const event = toolResult([forged, literal, anthropicImage(PNG)])
    const out = extractChatBlobs(event, s.put)
    expect(out.refs).toHaveLength(1)
    expect(chatBlobRefs(out.value)).toEqual(out.refs)
    expect(resolveChatBlobs(out.value, s.get)).toEqual(event)
  })
})

describe('resolveChatBlobs', () => {
  const fixtures: unknown[] = [
    toolResult([anthropicImage(PNG), anthropicImage(PNG), { type: 'text', text: 'a' }]),
    toolResult([{ type: 'image', data: JPG, mimeType: 'image/jpeg' }], {
      type: 'image',
      file: { base64: JPG, type: 'image/jpeg' }
    }),
    toolResult('plain', {
      nested: [[{ type: 'resource', resource: { uri: 'u', blob: PNG, mimeType: 'x/y' } }]]
    }),
    { kind: 'unknown', raw: { deep: { deeper: [anthropicImage(JPG), null, 3, 'x'] } } },
    toolResult([anthropicImage(PNG.slice(0, 10))])
  ]

  test('lossless: resolve(extract(x)) deep-equals x for every fixture', () => {
    for (const x of fixtures) {
      const s = fakeStore()
      const { value } = extractChatBlobs(x, s.put)
      expect(resolveChatBlobs(value, s.get)).toEqual(x)
      // And survives a JSON round trip (what storage does).
      expect(resolveChatBlobs(JSON.parse(JSON.stringify(value)), s.get)).toEqual(x)
    }
  })

  test('chatBlobRefs lists every reference, duplicates included', () => {
    const s = fakeStore()
    const { value, refs } = extractChatBlobs(fixtures[0], s.put)
    expect(chatBlobRefs(value)).toEqual(refs)
    expect(new Set(refs.map((r) => r.sha256)).size).toBe(1)
  })
})

describe('references', () => {
  test('isChatBlobRef rejects look-alikes', () => {
    const body = { v: 1, sha256: 'a'.repeat(64), mediaType: 'image/png', size: 3 }
    expect(isChatBlobRef({ $chatBlob: body })).toBe(true)
    expect(isChatBlobRef({ $chatBlob: { ...body, sha256: 'nothex' } })).toBe(false)
    expect(isChatBlobRef({ $chatBlob: { ...body, v: 2 } })).toBe(false)
    expect(isChatBlobRef({ $chatBlob: body, extra: 1 })).toBe(false)
    expect(isChatBlobRef('x')).toBe(false)
  })

  test('formatChatBlobRef / chatBlobJsonReplacer print a compact label', () => {
    const body = { v: 1 as const, sha256: 'a'.repeat(64), mediaType: 'image/png', size: 120 * 1024 }
    expect(formatChatBlobRef(body)).toBe('[image/png · 120 KB]')
    expect(JSON.stringify({ data: { $chatBlob: body } }, chatBlobJsonReplacer)).toBe(
      '{"data":"[image/png · 120 KB]"}'
    )
  })
})
