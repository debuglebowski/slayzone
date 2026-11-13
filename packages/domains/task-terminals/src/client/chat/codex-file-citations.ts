/**
 * Codex plugin skills (Google Drive, documents, spreadsheets, pdf…) make the
 * agent emit file citations as markdown text directives:
 *
 *   :codex-file-citation{path="https://docs.google.com/document/d/…" purpose="output"}
 *
 * `purpose="output"` = a file the agent created/edited, `"source"` = a file it
 * read to support the answer. The Codex app renders these as file chips; plain
 * markdown shows the raw directive. `renderCodexFileCitations` rewrites each
 * directive (outside code) into an inline anchor carrying
 * `data-file-citation-path`, so `ChatPanel`'s link interception can open web
 * targets in the browser and local paths in the editor.
 */

const DIRECTIVE = /:codex-file-citation\{((?:[^}"]|"[^"]*")*)\}/g
const ATTR = /([\w-]+)\s*=\s*"([^"]*)"/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/

export type CodexFileCitationPurpose = 'output' | 'source'

export interface CodexFileCitation {
  path: string
  purpose: CodexFileCitationPurpose | null
}

export function parseCodexFileCitation(attrs: string): CodexFileCitation | null {
  const values = new Map<string, string>()
  for (const m of attrs.matchAll(ATTR)) values.set(m[1], m[2])
  const path = values.get('path')?.trim()
  if (!path) return null
  const purpose = values.get('purpose')
  return { path, purpose: purpose === 'output' || purpose === 'source' ? purpose : null }
}

const GOOGLE_KINDS: Record<string, string> = {
  document: 'Google Doc',
  spreadsheets: 'Google Sheet',
  presentation: 'Google Slides',
  forms: 'Google Form'
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** Human label for a cited target: Google file kind, else file name, else host. */
export function codexFileCitationLabel(path: string): string {
  if (!/^https?:\/\//i.test(path)) return basename(path)
  let url: URL
  try {
    url = new URL(path)
  } catch {
    return path
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'docs.google.com') {
    const kind = GOOGLE_KINDS[segments[0] ?? '']
    if (kind) return kind
  }
  if (url.hostname === 'drive.google.com') return 'Google Drive file'
  const last = segments.at(-1)
  if (last) {
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  }
  return url.hostname
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PURPOSE_TITLE: Record<CodexFileCitationPurpose, string> = {
  output: 'Created or edited',
  source: 'Source'
}

const CHIP_CLASS =
  'inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-px align-baseline text-[0.85em] font-medium text-foreground no-underline hover:bg-accent'

function citationHtml(citation: CodexFileCitation): string {
  const title = citation.purpose
    ? `${PURPOSE_TITLE[citation.purpose]}: ${citation.path}`
    : citation.path
  const purposeAttr = citation.purpose ? ` data-file-citation="${citation.purpose}"` : ''
  return (
    `<a href="${escapeHtml(citation.path)}" data-file-citation-path="${escapeHtml(citation.path)}"` +
    `${purposeAttr} title="${escapeHtml(title)}" class="${CHIP_CLASS}">` +
    `${escapeHtml(codexFileCitationLabel(citation.path))}</a>`
  )
}

function replaceDirectives(prose: string): string {
  // Odd indices of the split are inline code spans — left verbatim.
  return prose
    .split(/(`+[^`]*?`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(DIRECTIVE, (whole, attrs: string) => {
            const citation = parseCodexFileCitation(attrs)
            return citation ? citationHtml(citation) : whole
          })
    )
    .join('')
}

/** Rewrite Codex file-citation directives in markdown, skipping fenced + inline code. */
export function renderCodexFileCitations(markdown: string): string {
  if (!markdown.includes(':codex-file-citation{')) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flushProse = (): void => {
    if (prose.length > 0) out.push(replaceDirectives(prose.join('\n')))
    prose = []
  }
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      out.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
    } else if (marker) {
      flushProse()
      out.push(line)
      fence = marker
    } else {
      prose.push(line)
    }
  }
  flushProse()
  return out.join('\n')
}

/** Absolute path for a local cited target: strips `file://`, resolves relative paths against `cwd`. */
export function resolveCitedPath(path: string, cwd: string): string {
  let p = path
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      p = p.replace(/^file:\/\//i, '')
    }
  }
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || !cwd) return p
  return `${cwd.replace(/[\\/]+$/, '')}/${p.replace(/^\.\//, '')}`
}
