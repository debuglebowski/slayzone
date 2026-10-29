/** Readable views of Claude Code's WebSearch / WebFetch tool results. */

export interface WebLink {
  title: string
  url: string
}

export interface WebSearchView {
  query: string
  links: WebLink[]
  /** Text the search returned besides links. */
  notes: string[]
  durationSeconds?: number
}

export interface WebFetchView {
  url: string
  /** What the agent asked about the page. */
  prompt?: string
  /** e.g. `HTTP 200 OK`. */
  status?: string
  /** Content type, size, time — whatever the result reports. */
  details?: string[]
  /** The fetch model's answer (older CLIs). */
  summary?: string
  /** The fetched page text (CLI 2.1.3xx hands it to the web-fetch sub-agent). */
  content?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function toLinks(v: unknown): WebLink[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((l) =>
    isRecord(l) && typeof l.url === 'string' ? [{ title: str(l.title) || l.url, url: l.url }] : []
  )
}

function uniqueByUrl(links: WebLink[]): WebLink[] {
  const seen = new Set<string>()
  return links.filter((l) => !seen.has(l.url) && seen.add(l.url))
}

/**
 * WebSearch input + result. Structured result (`tool_use_result`):
 * `{query, results: ({tool_use_id, content: [{title, url}]} | string)[], durationSeconds}`.
 * Without it, the text the model got (`Links: [...]` lines) or citation blocks.
 */
export function webSearchView(
  input: unknown,
  structured: unknown,
  rawContent: unknown
): WebSearchView {
  const query =
    str(isRecord(input) ? input.query : undefined) ||
    str(isRecord(structured) ? structured.query : undefined)
  if (isRecord(structured) && Array.isArray(structured.results)) {
    const links: WebLink[] = []
    const notes: string[] = []
    for (const r of structured.results) {
      if (typeof r === 'string') {
        if (r.trim()) notes.push(r.trim())
      } else if (isRecord(r)) links.push(...toLinks(r.content))
    }
    return {
      query,
      links: uniqueByUrl(links),
      notes,
      ...(typeof structured.durationSeconds === 'number'
        ? { durationSeconds: structured.durationSeconds }
        : {})
    }
  }
  if (Array.isArray(rawContent)) {
    const links = rawContent.flatMap((b) =>
      isRecord(b) && b.type === 'search_result' && typeof b.source === 'string'
        ? [{ title: str(b.title) || b.source, url: b.source }]
        : []
    )
    return { query, links: uniqueByUrl(links), notes: [] }
  }
  const links: WebLink[] = []
  const notes: string[] = []
  for (const block of str(rawContent).split(/\n\s*\n/)) {
    const line = block.trim()
    if (!line || line.startsWith('Web search results for query:') || line.startsWith('REMINDER:'))
      continue
    const m = /^Links: (\[[\s\S]*\])$/.exec(line)
    if (m) {
      try {
        links.push(...toLinks(JSON.parse(m[1])))
      } catch {
        notes.push(line)
      }
    } else notes.push(line)
  }
  return { query, links: uniqueByUrl(links), notes }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/**
 * WebFetch input + result. Older CLIs return `{code, codeText, bytes, result,
 * durationMs, url}` (result = the fetch model's answer). CLI 2.1.3xx returns the
 * page itself as text: `Fetched <url> (HTTP 200 OK, text/html, 172 characters).`,
 * reporting rules, then `<fetched-web-content>…</fetched-web-content>`.
 */
export function webFetchView(
  input: unknown,
  structured: unknown,
  rawContent: unknown
): WebFetchView {
  const inp = isRecord(input) ? input : {}
  const view: WebFetchView = {
    url: str(inp.url) || str(isRecord(structured) ? structured.url : undefined)
  }
  if (str(inp.prompt)) view.prompt = str(inp.prompt)
  if (isRecord(structured) && typeof structured.code === 'number') {
    view.status = `HTTP ${structured.code}${structured.codeText ? ` ${str(structured.codeText)}` : ''}`
    const details: string[] = []
    if (typeof structured.bytes === 'number') details.push(formatBytes(structured.bytes))
    if (typeof structured.durationMs === 'number')
      details.push(`${(structured.durationMs / 1000).toFixed(1)}s`)
    if (details.length) view.details = details
    if (str(structured.result).trim()) view.summary = str(structured.result).trim()
    return view
  }
  const text = str(rawContent)
  const head = /^Fetched \S+ \(([^)]*)\)\./.exec(text)
  if (!head) return view
  const [status, ...details] = head[1].split(',').map((s) => s.trim())
  view.status = status
  if (details.length) view.details = details
  // The reporting rules above the page mention the tag too: take the last opening tag.
  const close = text.lastIndexOf('</fetched-web-content>')
  const open = close < 0 ? -1 : text.lastIndexOf('<fetched-web-content>', close)
  const body = open < 0 ? '' : text.slice(open + '<fetched-web-content>'.length, close).trim()
  if (body) view.content = body
  return view
}
