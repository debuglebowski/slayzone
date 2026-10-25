/**
 * Tests for the file-path clipboard (copy/paste of files in the file tree).
 *
 * Electron 44 made the clipboard async and W3C-shaped. `text/uri-list` now maps to
 * the OS's native file references (macOS NSFilenamesPboardType + file URLs, Windows
 * CF_HDROP), so one cross-platform path replaces the old macOS plist hack. These
 * tests drive the logic against an in-memory clipboard port; the shapes mirror what
 * a real Electron 44 clipboard returned for a Finder copy and a plain-text copy.
 *
 * Run with: npx tsx packages/apps/app/src/main/clipboard-file-paths.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFilePathClipboard, type ClipboardPort } from './clipboard-file-paths'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, label?: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ? `${label}: ` : ''}expected ${b}, got ${a}`)
}

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

async function main(): Promise<void> {
  console.log('clipboard-file-paths')

  await test('write puts native file refs (uri-list) and the paths as text', async () => {
    const cb = fakeClipboard()
    await createFilePathClipboard(cb).writeFilePaths([fileA, fileB])
    eq(cb.entry['text/uri-list'], uriList, 'uri-list')
    eq(cb.entry['text/plain'], `${fileA}\n${fileB}`, 'text')
  })

  await test('write of no paths clears the clipboard', async () => {
    const cb = fakeClipboard({ 'text/plain': 'x' })
    await createFilePathClipboard(cb).writeFilePaths([])
    eq(cb.entry, {})
  })

  await test('write → read round-trips paths with spaces and #', async () => {
    const cb = fakeClipboard()
    const fc = createFilePathClipboard(cb)
    await fc.writeFilePaths([fileA, fileB])
    eq(await fc.readFilePaths(), [fileA, fileB])
    eq(await fc.hasFilePaths(), true)
  })

  await test('reads a Finder-style copy (uri-list only, no text)', async () => {
    const cb = fakeClipboard({
      'text/uri-list': uriList,
      'electron application/osclipboard;format="NSFilenamesPboardType"': '<plist/>'
    })
    const fc = createFilePathClipboard(cb)
    eq(await fc.readFilePaths(), [fileA, fileB])
    eq(await fc.hasFilePaths(), true)
  })

  await test('uri-list comment lines and blank lines are ignored', async () => {
    const cb = fakeClipboard({
      'text/uri-list': `# comment\r\n\r\n${pathToFileURL(fileA).href}\r\n`
    })
    eq(await createFilePathClipboard(cb).readFilePaths(), [fileA])
  })

  await test('plain text of existing absolute paths reads as files', async () => {
    const cb = fakeClipboard({ 'text/plain': `${fileA}\n${fileB}\n` })
    const fc = createFilePathClipboard(cb)
    eq(await fc.readFilePaths(), [fileA, fileB])
    eq(await fc.hasFilePaths(), true)
  })

  await test('plain text file:// URLs read as files', async () => {
    const cb = fakeClipboard({ 'text/plain': pathToFileURL(fileA).href })
    eq(await createFilePathClipboard(cb).readFilePaths(), [fileA])
  })

  await test('plain text that is not a path is not files', async () => {
    const cb = fakeClipboard({ 'text/plain': 'hello world' })
    const fc = createFilePathClipboard(cb)
    eq(await fc.readFilePaths(), [])
    eq(await fc.hasFilePaths(), false)
  })

  await test('text naming a missing absolute path is not files', async () => {
    const cb = fakeClipboard({ 'text/plain': join(dir, 'missing.txt') })
    const fc = createFilePathClipboard(cb)
    eq(await fc.readFilePaths(), [])
    eq(await fc.hasFilePaths(), false)
  })

  await test('empty clipboard reads as no files', async () => {
    const fc = createFilePathClipboard(fakeClipboard())
    eq(await fc.readFilePaths(), [])
    eq(await fc.hasFilePaths(), false)
  })

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
