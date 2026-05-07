import { clipboard } from 'electron'
import { existsSync } from 'fs'

const PLIST_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n'
const PLIST_FOOTER = '</array>\n</plist>\n'

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildFilenamesPlist(paths: string[]): Buffer {
  const inner = paths.map((p) => `\t<string>${escapeXml(p)}</string>`).join('\n')
  return Buffer.from(`${PLIST_HEADER}${inner}\n${PLIST_FOOTER}`, 'utf-8')
}

function parseFilenamesPlist(buf: Buffer): string[] {
  const xml = buf.toString('utf-8')
  const out: string[] = []
  const re = /<string>([\s\S]*?)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const decoded = m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    out.push(decoded)
  }
  return out
}

function fileUrlsToPaths(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => {
      if (s.startsWith('file://')) {
        try {
          return decodeURIComponent(new URL(s).pathname)
        } catch {
          return ''
        }
      }
      return s
    })
    .filter((s) => s.length > 0)
}

function pathsToFileUrls(paths: string[]): string {
  return paths.map((p) => `file://${encodeURI(p).replace(/#/g, '%23')}`).join('\n')
}

export function writeFilePaths(paths: string[]): void {
  if (!paths.length) {
    clipboard.clear()
    return
  }
  if (process.platform === 'darwin') {
    clipboard.writeBuffer('NSFilenamesPboardType', buildFilenamesPlist(paths))
    clipboard.writeText(paths.join('\n'))
  } else {
    clipboard.write({
      text: paths.join('\n'),
      bookmark: pathsToFileUrls(paths),
    })
  }
}

export function readFilePaths(): string[] {
  if (process.platform === 'darwin') {
    const buf = clipboard.readBuffer('NSFilenamesPboardType')
    if (buf && buf.length > 0) {
      const parsed = parseFilenamesPlist(buf)
      if (parsed.length) return parsed
    }
  }
  const formats = clipboard.availableFormats()
  if (formats.includes('text/uri-list')) {
    const buf = clipboard.readBuffer('text/uri-list')
    if (buf && buf.length > 0) {
      const parsed = fileUrlsToPaths(buf.toString('utf-8'))
      if (parsed.length) return parsed
    }
  }
  const text = clipboard.readText().trim()
  if (!text) return []
  const candidates = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const paths = candidates.map((c) => {
    if (c.startsWith('file://')) {
      try { return decodeURIComponent(new URL(c).pathname) } catch { return '' }
    }
    return c
  }).filter(Boolean)
  return paths.filter((p) => p.startsWith('/') && existsSync(p))
}

export function hasFilePaths(): boolean {
  if (process.platform === 'darwin') {
    if (clipboard.availableFormats().some((f) => f.includes('NSFilenamesPboardType') || f === 'public.file-url')) {
      return true
    }
    const buf = clipboard.readBuffer('NSFilenamesPboardType')
    if (buf && buf.length > 0) return parseFilenamesPlist(buf).length > 0
  }
  const formats = clipboard.availableFormats()
  if (formats.includes('text/uri-list')) return true
  const text = clipboard.readText().trim()
  if (!text) return false
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .some((s) => (s.startsWith('/') && existsSync(s)) || s.startsWith('file://'))
}

