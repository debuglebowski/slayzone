/**
 * Crash fix 4: a screenshot a tool returned is saved OUT-OF-LINE — the computer keeps
 * its bytes once in its blob store, the saved event a reference — and the chat still
 * shows it: live, and after a reload (bytes loaded through `chat.readBlob`).
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { cliRoot, resetApp, supervisedHubRoot } from '../fixtures/electron'
import { openActivityCard } from '../fixtures/chat-activity'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

/** A valid PNG of random RGB noise (incompressible: well over the 1 KiB inline threshold). */
function noisePng(width = 48, height = 48): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]))
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Files under `root` whose bytes contain `marker`. */
function filesContaining(root: string, marker: Buffer): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...filesContaining(file, marker))
    else if (entry.isFile()) {
      try {
        if (fs.readFileSync(file).includes(marker)) found.push(file)
      } catch (error) {
        // WAL/log rotation may remove a file between enumeration and read.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return found
}

test('a screenshot a tool returned is stored once, out-of-line, and shows live and after reload', async ({
  chat,
  electronApp,
  mainWindow
}) => {
  test.setTimeout(90_000)
  await resetApp(mainWindow)
  const png = noisePng()
  const b64 = png.toString('base64')
  const expected = `data:image/png;base64,${b64}`
  const t = await chat.openTask({
    title: 'Chat screenshot storage',
    scenario: {
      processes: [
        {
          turns: [
            [
              step.emit(
                ev.init(),
                ev.toolUse({
                  id: 'toolu_shot',
                  name: 'Read',
                  input: { file_path: '/tmp/shot.png' }
                }),
                ev.toolResult({
                  toolUseId: 'toolu_shot',
                  content: [
                    {
                      type: 'image',
                      source: { type: 'base64', media_type: 'image/png', data: b64 }
                    }
                  ],
                  structured: {
                    type: 'image',
                    file: { base64: b64, type: 'image/png', originalSize: png.length }
                  }
                }),
                ev.text('Looked at the screenshot.'),
                ev.result({ text: 'Looked at the screenshot.' })
              )
            ]
          ],
          defaultTurn: echoTurn()
        }
      ]
    }
  })

  await t.send('look at it')
  await expect(t.panel.getByText('Looked at the screenshot.')).toBeVisible()

  // The saved event holds references, not the base64.
  const saved = (await t.events()).find((e) => e.event.kind === 'tool-result')
  expect(saved).toBeTruthy()
  const savedJson = JSON.stringify(saved!.event)
  expect(savedJson).toContain('$chatBlob')
  expect(savedJson).not.toContain(b64.slice(0, 64))

  // Live: the card shows the image (its bytes read back from the computer).
  await openActivityCard(t.panel, /Read/)
  await expect(t.panel.getByAltText('shot.png').first()).toHaveAttribute('src', expected)

  // After a reload: history replays references; the image loads the same.
  await t.reload()
  await openActivityCard(t.panel, /Read/)
  await expect(t.panel.getByAltText('shot.png').first()).toHaveAttribute('src', expected)

  // On disk: the computer holds the bytes (its blob store); no database, WAL or log of
  // the computer or the hub holds the base64.
  const root = await cliRoot(electronApp)
  const computer = path.join(root, 'dev', 'computer')
  expect(root).toContain('.e2e-runtime')
  expect(filesContaining(computer, png).some((f) => /[\\/]blobs[\\/][a-f0-9]{64}$/.test(f))).toBe(
    true
  )
  const marker = Buffer.from(b64.slice(0, 256))
  expect(filesContaining(computer, marker), 'computer files holding the base64').toEqual([])
  expect(filesContaining(supervisedHubRoot(root), marker), 'hub files holding the base64').toEqual(
    []
  )
})
