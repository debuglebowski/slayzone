import { existsSync } from 'fs'
import { isAbsolute } from 'path'
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
