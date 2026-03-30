import type { ILinkProvider, ILink, Terminal, IBufferLine } from '@xterm/xterm'

// From xterm.js addon-web-links — matches http:// and https:// URLs.
// Excludes unsafe chars from RFC 3986/1738, trailing punctuation, and brackets.
export const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/

/**
 * Join wrapped lines around `lineIndex` into a single string for URL matching.
 * Stops expanding at whitespace boundaries or 2048 chars (same heuristic as xterm).
 * Returns [joinedText, topLineIndex].
 */
export function getWindowedLineStrings(lineIndex: number, terminal: Terminal): [string[], number] {
  let line: IBufferLine | undefined
  let topIdx = lineIndex
  let bottomIdx = lineIndex
  let length = 0
  let content = ''
  const lines: string[] = []

  if ((line = terminal.buffer.active.getLine(lineIndex))) {
    const currentContent = line.translateToString(true)

    // Expand upward through wrapped lines
    if (line.isWrapped && currentContent[0] !== ' ') {
      length = 0
      while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
        content = line.translateToString(true)
        length += content.length
        lines.push(content)
        if (!line.isWrapped || content.indexOf(' ') !== -1) break
      }
      lines.reverse()
    }

    lines.push(currentContent)

    // Expand downward through wrapped lines
    length = 0
    while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
      content = line.translateToString(true)
      length += content.length
      lines.push(content)
      if (content.indexOf(' ') !== -1) break
    }
  }
  return [lines, topIdx]
}

/**
 * Map a string index within the joined text back to a buffer position [lineIndex, columnIndex].
 * Both values are 0-based. Returns [-1, -1] if the line doesn't exist.
 */
export function mapStringIndex(terminal: Terminal, lineIndex: number, startCol: number, stringIndex: number): [number, number] {
  const buf = terminal.buffer.active
  let col = startCol
  while (stringIndex > 0) {
    const line = buf.getLine(lineIndex)
    if (!line) return [-1, -1]
    const lineLen = line.length
    const remaining = lineLen - col
    if (stringIndex < remaining) return [lineIndex, col + stringIndex]
    stringIndex -= remaining
    lineIndex++
    col = 0
  }
  return [lineIndex, col]
}

// Matches file paths with optional line:col suffix.
// Patterns: ./relative/path.ts, ../up/path.js, src/foo.tsx:42:10, /absolute/path.rs:10
// Requires a file extension to avoid false positives on plain words.
// The line:col suffix (:digits and optionally :digits) is captured but not part of the "file" match group.
export const FILE_REGEX = /(?<![:/\w.])(?:\.{1,2}\/[\w./-]+|[a-zA-Z][\w./-]*\/[\w./-]*\.[a-zA-Z]\w*|\/[\w./-]+\.[a-zA-Z]\w*)(?::(\d+)(?::(\d+))?)?/

export class FileLinkProvider implements ILinkProvider {
  constructor(
    private _terminal: Terminal,
    private _activate: (event: MouseEvent, filePath: string, line?: number, col?: number) => void,
    private _hover?: (event: MouseEvent, text: string) => void,
    private _leave?: (event: MouseEvent, text: string) => void,
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this._terminal.buffer.active.getLine(bufferLineNumber - 1)
    if (!line) {
      callback(undefined)
      return
    }

    // File links don't span wrapped lines — paths with spaces aren't matched anyway
    const text = line.translateToString(true)
    const regex = new RegExp(FILE_REGEX.source, 'g')
    const links: ILink[] = []
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0]
      const lineNum = match[1] ? parseInt(match[1], 10) : undefined
      const colNum = match[2] ? parseInt(match[2], 10) : undefined
      // Strip the :line:col suffix from the file path
      const filePath = lineNum !== undefined ? fullMatch.replace(/:\d+(?::\d+)?$/, '') : fullMatch
      const startX = match.index

      links.push({
        range: {
          start: { x: startX + 1, y: bufferLineNumber },
          end: { x: startX + fullMatch.length + 1, y: bufferLineNumber }
        },
        text: fullMatch,
        decorations: { underline: false, pointerCursor: true },
        activate: (event: MouseEvent) => this._activate(event, filePath, lineNum, colNum),
        hover: this._hover ? (event: MouseEvent, text: string) => this._hover!(event, text) : undefined,
        leave: this._leave ? (event: MouseEvent, text: string) => this._leave!(event, text) : undefined,
      })
    }

    callback(links.length > 0 ? links : undefined)
  }
}

export class WebLinkProvider implements ILinkProvider {
  constructor(
    private _terminal: Terminal,
    private _activate: (event: MouseEvent, uri: string) => void,
    private _hover?: (event: MouseEvent, uri: string) => void,
    private _leave?: (event: MouseEvent, uri: string) => void,
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const lineIndex = bufferLineNumber - 1
    const [lines, topLineIndex] = getWindowedLineStrings(lineIndex, this._terminal)
    const joinedText = lines.join('')
    if (!joinedText) {
      callback(undefined)
      return
    }

    const regex = new RegExp(URL_REGEX.source, 'g')
    const links: ILink[] = []
    let match: RegExpExecArray | null

    while ((match = regex.exec(joinedText)) !== null) {
      let uri = match[0]

      const [startY, startX] = mapStringIndex(this._terminal, topLineIndex, 0, match.index)
      let [endY, endX] = mapStringIndex(this._terminal, topLineIndex, 0, match.index + uri.length)
      if (startY === -1 || endY === -1) continue

      // If URL reaches near end of joined text, extend through soft-wrapped
      // continuation lines (TUI apps that format long URLs across lines)
      if (match.index + uri.length >= joinedText.length - 2) {
        const extended = this._extendUrlSoft(uri, topLineIndex + lines.length)
        if (extended) {
          uri = extended.uri
          endY = extended.endLine
          endX = extended.endCol
        }
      }

      links.push({
        range: {
          start: { x: startX + 1, y: startY + 1 },
          end: { x: endX, y: endY + 1 }
        },
        text: uri,
        decorations: { underline: false, pointerCursor: true },
        activate: (event: MouseEvent) => this._activate(event, uri),
        hover: this._hover ? (event: MouseEvent, text: string) => this._hover!(event, text) : undefined,
        leave: this._leave ? (event: MouseEvent, text: string) => this._leave!(event, text) : undefined,
      })
    }

    // If no URL found, check if this line is a soft-continuation of a URL above
    if (links.length === 0) {
      const fullUri = this._resolveUrlFromContext(lineIndex)
      if (fullUri) {
        const content = this._terminal.buffer.active.getLine(lineIndex)!.translateToString(true)
        const trimmed = content.trimStart()
        const offset = content.length - trimmed.length
        links.push({
          range: {
            start: { x: offset + 1, y: bufferLineNumber },
            end: { x: offset + trimmed.length + 1, y: bufferLineNumber }
          },
          text: fullUri,
          decorations: { underline: false, pointerCursor: true },
          activate: (event: MouseEvent) => this._activate(event, fullUri),
          hover: this._hover ? (event: MouseEvent, text: string) => this._hover!(event, text) : undefined,
          leave: this._leave ? (event: MouseEvent, text: string) => this._leave!(event, text) : undefined,
        })
      }
    }

    callback(links.length > 0 ? links : undefined)
  }

  /** Extend a partial URL through subsequent non-wrapped indented lines */
  private _extendUrlSoft(partialUri: string, fromLineIndex: number): { uri: string; endLine: number; endCol: number } | null {
    const buf = this._terminal.buffer.active
    let extended = partialUri
    let found = false
    const consumed: { lineIndex: number; indent: number; trimmedLen: number }[] = []

    for (let idx = fromLineIndex; extended.length < 4096; idx++) {
      const line = buf.getLine(idx)
      if (!line || line.isWrapped) break
      const content = line.translateToString(true)
      const trimmed = content.trimStart()
      if (!trimmed || /\s/.test(trimmed)) break
      consumed.push({ lineIndex: idx, indent: content.length - trimmed.length, trimmedLen: trimmed.length })
      extended += trimmed
      found = true
    }

    if (!found) return null
    const m = new RegExp('^' + URL_REGEX.source).exec(extended)
    if (!m) return null

    // Compute end position within continuation lines
    let remaining = m[0].length - partialUri.length
    for (const c of consumed) {
      if (remaining <= c.trimmedLen) {
        return { uri: m[0], endLine: c.lineIndex, endCol: c.indent + remaining }
      }
      remaining -= c.trimmedLen
    }
    const last = consumed[consumed.length - 1]
    return { uri: m[0], endLine: last.lineIndex, endCol: last.indent + last.trimmedLen }
  }

  /** Look upward from a continuation line to find and assemble the full URL */
  private _resolveUrlFromContext(lineIndex: number): string | null {
    const buf = this._terminal.buffer.active
    const currentLine = buf.getLine(lineIndex)
    if (!currentLine) return null
    const currentContent = currentLine.translateToString(true)
    const trimmed = currentContent.trimStart()

    // Must be indented, non-empty, no internal whitespace (URL-like fragment)
    if (!trimmed || trimmed === currentContent || /\s/.test(trimmed)) return null

    const parts: string[] = []
    let foundScheme = false

    // Scan upward for URL scheme
    for (let idx = lineIndex; idx >= Math.max(0, lineIndex - 30); idx--) {
      const line = buf.getLine(idx)
      if (!line) break
      const content = line.translateToString(true)
      const t = content.trimStart()
      if (!t) break
      parts.unshift(t)
      if (/https?:\/\//i.test(t)) { foundScheme = true; break }
      if (/\s/.test(t)) { parts.shift(); break }
    }

    if (!foundScheme || parts.length < 2) return null

    // Scan downward for more continuation lines
    for (let idx = lineIndex + 1; idx <= lineIndex + 30; idx++) {
      const line = buf.getLine(idx)
      if (!line || line.isWrapped) break
      const content = line.translateToString(true)
      const t = content.trimStart()
      if (!t || /\s/.test(t)) break
      parts.push(t)
    }

    const joined = parts.join('')
    const m = new RegExp(URL_REGEX.source).exec(joined)
    return m ? m[0] : null
  }
}
