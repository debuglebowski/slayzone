// From xterm.js addon-web-links — matches http:// and https:// URLs.
// Excludes unsafe chars from RFC 3986/1738, trailing punctuation, and brackets.
export const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/

// Matches file paths with optional line:col suffix.
// Patterns: ./relative/path.ts, ../up/path.js, src/foo.tsx:42:10, /absolute/path.rs:10
// Also matches bare filenames inside parentheses: Write(test.tf), Edit(main.c:42)
// Requires a file extension to avoid false positives on plain words.
// The line:col suffix (:digits and optionally :digits) is captured but not part of the "file" match group.
export const FILE_REGEX =
  /(?:(?<![:/\w.])(?:\.{1,2}\/[\w./-]+|[a-zA-Z][\w./-]*\/[\w./-]*\.[a-zA-Z]\w*|\/[\w./-]+\.[a-zA-Z]\w*)|(?<=\()[\w.-]+\.[a-zA-Z]\w*)(?::(\d+)(?::(\d+))?)?/

export interface TextLinkMatch {
  kind: 'url' | 'file'
  text: string
  start: number
  end: number
  filePath?: string
  line?: number
  col?: number
}

/**
 * Scan a plain string for URLs and file-path references.
 * Pure-text version — no xterm dependency. Use for chat/markdown surfaces.
 * Returns all matches sorted by start offset.
 */
export function findLinksInString(text: string): TextLinkMatch[] {
  const out: TextLinkMatch[] = []

  const urlRe = new RegExp(URL_REGEX.source, 'g')
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(text)) !== null) {
    out.push({ kind: 'url', text: m[0], start: m.index, end: m.index + m[0].length })
  }

  const fileRe = new RegExp(FILE_REGEX.source, 'g')
  while ((m = fileRe.exec(text)) !== null) {
    const full = m[0]
    const line = m[1] ? parseInt(m[1], 10) : undefined
    const col = m[2] ? parseInt(m[2], 10) : undefined
    const filePath = line !== undefined ? full.replace(/:\d+(?::\d+)?$/, '') : full
    out.push({
      kind: 'file',
      text: full,
      start: m.index,
      end: m.index + full.length,
      filePath,
      line,
      col
    })
  }

  out.sort((a, b) => a.start - b.start)
  return out
}
