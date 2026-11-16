/**
 * Export of an archived conversation (Settings → computer chat backups): the file
 * holds the history as it was saved — images inline. A v13 backup stores them
 * out-of-line (`chat-blobs`); its export must equal the v12 export of the same history.
 */
import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
  escapeChatBlobLiterals,
  extractChatBlobs,
  type AgentEvent,
  type ChatBlobChunk,
  type ChatBlobRefBody
} from '@slayzone/terminal-contracts'
import { collectArchivedConversation, type ArchiveExportApi } from './archive-export'

const target = { computerId: 'pc', archiveId: 'archive', conversationId: 'conv' }
const png = (seed: number) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2500, seed)])
const shot = (bytes: Buffer): AgentEvent => ({
  kind: 'tool-result',
  toolUseId: 't',
  isError: false,
  rawContent: [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') }
    }
  ],
  structured: { type: 'image', file: { base64: bytes.toString('base64'), type: 'image/png' } }
})
const a = png(1),
  b = png(2)
/** The history as a pre-v13 store saved it (raw). */
const raw: Array<{ seq: number; at: number; event: AgentEvent }> = [
  { seq: 0, at: 1, event: { kind: 'user-message', text: 'look' } },
  { seq: 1, at: 2, event: shot(a) },
  { seq: 2, at: 3, event: shot(b) },
  {
    seq: 3,
    at: 4,
    // A tool printed something shaped like a reference: it stays exactly as printed.
    event: {
      kind: 'tool-result',
      toolUseId: 'u',
      isError: false,
      rawContent: [{ $chatBlob: { v: 1, sha256: 'f'.repeat(64), mediaType: 'x/y', size: 1 } }],
      structured: null
    } as AgentEvent
  },
  { seq: 4, at: 5, event: shot(a) }
]

/** The same history as a v13 store saves it, plus its blobs. */
function stored() {
  const blobs = new Map<string, Buffer>()
  const events = raw.map((e) => ({
    ...e,
    event: extractChatBlobs(e.event, (base64, mediaType): ChatBlobRefBody => {
      const bytes = Buffer.from(base64, 'base64')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      blobs.set(sha256, bytes)
      return { v: 1, sha256, mediaType, size: bytes.length }
    }).value
  }))
  return { events, blobs }
}

function api(
  events: Array<{ seq: number; at: number; event: AgentEvent }>,
  blobs = new Map<string, Buffer>(),
  tamper = false
) {
  const blob = vi.fn(
    async (input: typeof target & { sha256: string; offset: number }): Promise<ChatBlobChunk> => {
      const bytes = blobs.get(input.sha256)
      if (!bytes) throw new Error('Blob is not part of this archive conversation')
      const chunk = Buffer.from(bytes.subarray(input.offset, input.offset + 1000))
      if (tamper) chunk[0] ^= 1
      return {
        mediaType: 'image/png',
        size: bytes.length,
        offset: input.offset,
        data: chunk.toString('base64')
      }
    }
  )
  const value: ArchiveExportApi = {
    chat: {
      archives: {
        read: {
          query: async ({ afterSeq }) => {
            const page = events.filter((e) => e.seq > afterSeq).slice(0, 2)
            return {
              events: page,
              hasMore: events.some((e) => e.seq > (page.at(-1)?.seq ?? afterSeq)),
              nextSeq: page.at(-1)?.seq ?? afterSeq
            }
          }
        },
        records: { query: async () => ({ records: [], hasMore: false, nextCursor: 0 }) },
        attachment: { query: async () => ({ data: '' }) },
        file: { query: async () => ({ name: '', data: '' }) },
        blob: { query: blob }
      }
    }
  }
  return { api: value, blob }
}

describe('collectArchivedConversation', () => {
  test('a v13 archive (images out-of-line) exports exactly what the v12 archive of the same history exports', async () => {
    // What the computer serves for a pre-v13 archive: raw rows in stored form
    // (ref-shaped objects escaped, base64 inline).
    const v12 = await collectArchivedConversation(
      api(raw.map((e) => ({ ...e, event: escapeChatBlobLiterals(e.event) }))).api,
      target
    )
    const { events, blobs } = stored()
    expect(JSON.stringify(events)).not.toContain(a.toString('base64').slice(0, 40))
    const v13 = api(events, blobs)
    expect(await collectArchivedConversation(v13.api, target)).toEqual(v12)
    expect(v12.events).toEqual(raw)
    // Each distinct image is read once, in chunks.
    const shaA = createHash('sha256').update(a).digest('hex')
    expect(v13.blob.mock.calls.filter(([i]) => i.sha256 === shaA).map(([i]) => i.offset)).toEqual([
      0, 1000, 2000
    ])
    expect(new Set(v13.blob.mock.calls.map(([i]) => i.sha256)).size).toBe(2)
  })

  test('bytes that do not match their reference fail the export instead of writing a wrong image', async () => {
    const { events, blobs } = stored()
    await expect(collectArchivedConversation(api(events, blobs, true).api, target)).rejects.toThrow(
      /integrity/i
    )
  })
})
