/**
 * Tests for the file-path clipboard (copy/paste of files in the file tree).
 *
 * Electron 44 made the clipboard async and W3C-shaped. `text/uri-list` now maps to
 * the OS's native file references (macOS NSFilenamesPboardType + file URLs, Windows
 * CF_HDROP), so one cross-platform path replaces the old macOS plist hack. These
 * tests drive the logic against an in-memory clipboard port; the shapes mirror what
 * a real Electron 44 clipboard returned for a Finder copy and a plain-text copy.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFilePathClipboard, type ClipboardPort } from './clipboard-file-paths'

/** An in-memory clipboard holding one entry of MIME type → text. */
function fakeClipboard(initial: Record<string, string> = {}): ClipboardPort & {
  entry: Record<string, string>
} {
  const port = {
    entry: { ...initial },
    async read() {
      const entry = port.entry
      if (Object.keys(entry).length === 0) return []
      return [
        {
          types: Object.keys(entry),
          getType: async (type: string) => {
            if (!(type in entry)) throw new Error(`no ${type}`)
            return new Blob([entry[type]])
          }
        }
      ]
    },
    async write(entry: Record<string, string>) {
      port.entry = { ...entry }
    },
    clear() {
      port.entry = {}
    }
  }
  return port
}

const dir = mkdtempSync(join(tmpdir(), 'slz-clipboard-'))
const fileA = join(dir, 'a b.txt')
const fileB = join(dir, 'c#d.txt')
writeFileSync(fileA, '')
writeFileSync(fileB, '')
const uriList = [fileA, fileB].map((p) => pathToFileURL(p).href).join('\r\n')

describe('clipboard-file-paths', () => {
  test('write puts native file refs (uri-list) and the paths as text', async () => {
    const cb = fakeClipboard()
    await createFilePathClipboard(cb).writeFilePaths([fileA, fileB])
    expect(cb.entry['text/uri-list'], 'uri-list').toEqual(uriList)
    expect(cb.entry['text/plain'], 'text').toEqual(`${fileA}\n${fileB}`)
  })

  test('write of no paths clears the clipboard', async () => {
    const cb = fakeClipboard({ 'text/plain': 'x' })
    await createFilePathClipboard(cb).writeFilePaths([])
    expect(cb.entry).toEqual({})
  })

  test('write → read round-trips paths with spaces and #', async () => {
    const cb = fakeClipboard()
    const fc = createFilePathClipboard(cb)
    await fc.writeFilePaths([fileA, fileB])
    expect(await fc.readFilePaths()).toEqual([fileA, fileB])
    expect(await fc.hasFilePaths()).toEqual(true)
  })

  test('reads a Finder-style copy (uri-list only, no text)', async () => {
    const cb = fakeClipboard({
      'text/uri-list': uriList,
      'electron application/osclipboard;format="NSFilenamesPboardType"': '<plist/>'
    })
    const fc = createFilePathClipboard(cb)
    expect(await fc.readFilePaths()).toEqual([fileA, fileB])
    expect(await fc.hasFilePaths()).toEqual(true)
  })

  test('uri-list comment lines and blank lines are ignored', async () => {
    const cb = fakeClipboard({
      'text/uri-list': `# comment\r\n\r\n${pathToFileURL(fileA).href}\r\n`
    })
    expect(await createFilePathClipboard(cb).readFilePaths()).toEqual([fileA])
  })

  test('plain text of existing absolute paths reads as files', async () => {
    const cb = fakeClipboard({ 'text/plain': `${fileA}\n${fileB}\n` })
    const fc = createFilePathClipboard(cb)
    expect(await fc.readFilePaths()).toEqual([fileA, fileB])
    expect(await fc.hasFilePaths()).toEqual(true)
  })

  test('plain text file:// URLs read as files', async () => {
    const cb = fakeClipboard({ 'text/plain': pathToFileURL(fileA).href })
    expect(await createFilePathClipboard(cb).readFilePaths()).toEqual([fileA])
  })

  test('plain text that is not a path is not files', async () => {
    const cb = fakeClipboard({ 'text/plain': 'hello world' })
    const fc = createFilePathClipboard(cb)
    expect(await fc.readFilePaths()).toEqual([])
    expect(await fc.hasFilePaths()).toEqual(false)
  })

  test('text naming a missing absolute path is not files', async () => {
    const cb = fakeClipboard({ 'text/plain': join(dir, 'missing.txt') })
    const fc = createFilePathClipboard(cb)
    expect(await fc.readFilePaths()).toEqual([])
    expect(await fc.hasFilePaths()).toEqual(false)
  })

  test('empty clipboard reads as no files', async () => {
    const fc = createFilePathClipboard(fakeClipboard())
    expect(await fc.readFilePaths()).toEqual([])
    expect(await fc.hasFilePaths()).toEqual(false)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})
