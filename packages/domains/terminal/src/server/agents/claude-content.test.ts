/**
 * buildClaudeContent: a message's attachment references → the content blocks
 * Claude Code takes on stdin. Bytes come from the artifact store at write time;
 * what a file is comes from its bytes, never from what the client said.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/agents/claude-content.test.ts
 */
import { describe, expect, test } from 'vitest'
import type { ChatAttachment, UserContentBlock } from '@slayzone/terminal-contracts'
import { buildClaudeContent, type ChatAttachmentReader } from './claude-content'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PDF = Buffer.from('%PDF-1.7\nsecret')
const TXT = Buffer.from('The secret word is MANGOSTEEN.\n')

function reader(files: Record<string, Uint8Array>, calls: unknown[] = []): ChatAttachmentReader {
  return {
    read: async (ref) => {
      calls.push(ref)
      const bytes = files[ref.artifactId]
      if (!bytes) throw new Error(`no artifact ${ref.artifactId}`)
      return bytes
    }
  }
}

const att = (artifactId: string, over: Partial<ChatAttachment> = {}): UserContentBlock => ({
  type: 'attachment',
  attachment: {
    artifactId,
    name: `${artifactId}.png`,
    kind: 'image',
    mediaType: 'image/png',
    size: 11,
    ...over
  }
})

describe('buildClaudeContent', () => {
  test('image, PDF and text become image / document blocks; typed text goes LAST', async () => {
    const content: UserContentBlock[] = [
      { type: 'text', text: '/x MANGO 3' },
      att('img'),
      att('doc', { name: 'secret.pdf', kind: 'pdf', mediaType: 'application/pdf' }),
      att('notes', { name: 'notes.txt', kind: 'text', mediaType: 'text/plain' })
    ]
    const out = await buildClaudeContent(content, reader({ img: PNG, doc: PDF, notes: TXT }))
    expect(out).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') }
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') },
        title: 'secret.pdf'
      },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: TXT.toString('utf8') },
        title: 'notes.txt'
      },
      // Claude Code reads the LAST text block as what the user typed: a
      // `/command` there runs; before the attachments it would be plain text.
      { type: 'text', text: '/x MANGO 3' }
    ])
  })

  test('reads the sealed version (content hash) when the message carries one', async () => {
    const calls: unknown[] = []
    await buildClaudeContent([att('img', { contentHash: 'abc123' })], reader({ img: PNG }, calls))
    expect(calls).toEqual([{ artifactId: 'img', contentHash: 'abc123' }])
  })

  test('the bytes decide the type: a "png" that is a PDF goes as a PDF', async () => {
    const out = await buildClaudeContent([att('doc')], reader({ doc: PDF }))
    expect(out[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } })
  })

  test('text-only content stays text', async () => {
    expect(await buildClaudeContent([{ type: 'text', text: 'hi' }], undefined)).toEqual([
      { type: 'text', text: 'hi' }
    ])
  })

  test('a deleted file fails with its name', async () => {
    await expect(buildClaudeContent([att('gone')], reader({}))).rejects.toThrow(
      /gone\.png is no longer available/
    )
  })

  test('an unsupported or too large file fails with the reason', async () => {
    await expect(
      buildClaudeContent(
        [att('zip', { name: 'a.docx' })],
        reader({ zip: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]) })
      )
    ).rejects.toThrow(/a\.docx can't be attached/)
    const big = Buffer.alloc(300 * 1024, 0x61)
    await expect(
      buildClaudeContent(
        [att('log', { name: 'big.log', kind: 'text', mediaType: 'text/plain' })],
        reader({ log: big })
      )
    ).rejects.toThrow(/@path/)
  })

  test('no reader (a hub without artifact access): attachments fail clearly', async () => {
    await expect(buildClaudeContent([att('img')], undefined)).rejects.toThrow(/attached files/)
  })
})
