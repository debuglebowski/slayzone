/**
 * Claude Code chat: real attachments (plan 3.5). Images, PDFs and text files are
 * attached as task artifacts and reach the CLI as content blocks — image /
 * document (base64 PDF) / document (text) — built from the stored bytes at write
 * time. They show in the user's bubble and survive a reload. A large image is
 * scaled down (TUI parity); a file Claude can't read is refused with a reason.
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import zlib from 'node:zlib'
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

/** A solid-colour RGB PNG of the given size. */
function png(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3, 0x80)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const RED = png(16, 16)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')
const NOTES = 'Inventory note.\nThe secret word is MANGOSTEEN.\n'

type Block = {
  type: string
  text?: string
  title?: string
  source?: { type: string; media_type: string; data: string }
}

test.describe('Claude chat: attachments as content blocks', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('image + PDF + text reach the CLI as blocks, show in the bubble, survive a reload', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat attachments',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.panel.getByTestId('chat-attach-input').setInputFiles([
      { name: 'red.png', mimeType: 'image/png', buffer: RED },
      { name: 'spec.pdf', mimeType: 'application/pdf', buffer: PDF },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) }
    ])
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(3)
    await t.send('what is in these?')
    await expect(t.panel.getByText('echo: what is in these?')).toBeVisible()

    const run = await t.run(0, (r) => r.userContents().length === 1)
    const content = run.userContents()[0] as Block[]
    expect(content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: RED.toString('base64') }
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') },
        title: 'spec.pdf'
      },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: NOTES },
        title: 'notes.md'
      },
      { type: 'text', text: 'what is in these?' }
    ])

    const sent = t.panel.getByTestId('chat-message-attachments').locator('[data-kind]')
    await expect(sent).toHaveCount(3)
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(0)
    await t.reload()
    await expect(
      t.panel.getByTestId('chat-message-attachments').locator('[data-kind]')
    ).toHaveCount(3)
    await expect(
      t.panel.getByTestId('chat-message-attachments').getByText('spec.pdf')
    ).toBeVisible()
  })

  test('an image over 2000 px is scaled down before it is sent', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat attachment downscale',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.panel
      .getByTestId('chat-attach-input')
      .setInputFiles([{ name: 'wide.png', mimeType: 'image/png', buffer: png(3000, 600) }])
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
    await t.send('look')
    const run = await t.run(0, (r) => r.userContents().length === 1)
    const [image] = run.userContents()[0] as Block[]
    expect(image.type).toBe('image')
    const bytes = Buffer.from(image.source!.data, 'base64')
    // IHDR: width at byte 16, height at byte 20 (PNG) — or a JPEG if PNG was too big.
    if (image.source!.media_type === 'image/png') {
      expect(bytes.readUInt32BE(16)).toBe(2000)
      expect(bytes.readUInt32BE(20)).toBe(400)
    } else {
      expect(image.source!.media_type).toBe('image/jpeg')
    }
  })

  test('a file Claude cannot read is refused with a reason, nothing is attached', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat attachment refused',
      spawn: 'on-send',
      scenario: { processes: [] }
    })
    await t.panel.getByTestId('chat-attach-input').setInputFiles([
      {
        name: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64)])
      }
    ])
    await expect(t.page.getByText(/report\.docx can't be attached/)).toBeVisible()
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(0)
  })
})
