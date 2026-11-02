import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync
} from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

// Electron 44 made the clipboard async and W3C-shaped. `text/uri-list` maps to the
// OS's native file references (macOS NSFilenamesPboardType + file URLs, Windows
// CF_HDROP, Linux text/uri-list), so a Finder/Explorer copy reads back as a uri-list
// and a uri-list we write pastes as files there. One path for every platform.
const URI_LIST = 'text/uri-list'
const TEXT = 'text/plain'

/** The slice of Electron's clipboard this module needs; swapped for a fake in tests. */
export interface ClipboardPort {
  read(): Promise<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>
  write(entry: Record<string, string>): Promise<void>
  clear(): void
}

function fileUrlToPath(url: string): string {
  try {
    return fileURLToPath(url)
  } catch {
    return ''
  }
}

function parseUriList(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => (s.startsWith('file://') ? fileUrlToPath(s) : s))
    .filter((s) => s.length > 0)
}

/** Lines of copied text that name existing files (absolute paths or file:// URLs). */
function parseTextPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('file://') ? fileUrlToPath(s) : s))
    .filter((p) => p && isAbsolute(p) && existsSync(p))
}

async function readType(port: ClipboardPort, type: string): Promise<string | null> {
  for (const item of await port.read()) {
    if (item.types.includes(type)) return (await item.getType(type)).text()
  }
  return null
}

/** Explicit clipboard export lives on the client, never in hub storage. */
function materializeArtifactUrl(value: string): string {
  if (!value.startsWith('data:')) return value
  const match = /^data:[^;,]+;name=([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || match[2].length > 20_000_000) throw new Error('Invalid clipboard artifact')
  const name = decodeURIComponent(match[1]).split(/[\\/]/).at(-1)
  if (!name || name === '.' || name === '..' || name.includes('\0'))
    throw new Error('Invalid clipboard filename')
  const root = join(tmpdir(), 'slayzone-clipboard-files')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const child of readdirSync(root)) {
    const path = join(root, child)
    if (Date.now() - statSync(path).mtimeMs > 24 * 60 * 60 * 1000)
      rmSync(path, { recursive: true, force: true })
  }
  const dir = mkdtempSync(join(root, 'export-')),
    path = join(dir, name)
  writeFileSync(path, Buffer.from(match[2], 'base64'), { mode: 0o600 })
  return path
}

export function createFilePathClipboard(port: ClipboardPort) {
  async function readFilePaths(): Promise<string[]> {
    const uriList = await readType(port, URI_LIST)
    if (uriList) {
      const parsed = parseUriList(uriList)
      if (parsed.length) return parsed
    }
    const text = await readType(port, TEXT)
    return text ? parseTextPaths(text) : []
  }

  return {
    async writeFilePaths(paths: string[]): Promise<void> {
      if (!paths.length) {
        port.clear()
        return
      }
      paths = paths.map(materializeArtifactUrl)
      await port.write({
        [URI_LIST]: paths.map((p) => pathToFileURL(p).href).join('\r\n'),
        [TEXT]: paths.join('\n')
      })
    },
    readFilePaths,
    async hasFilePaths(): Promise<boolean> {
      return (await readFilePaths()).length > 0
    }
  }
}
