/**
 * Where a search's query matches inside a result's line, for highlighting: the hub sends
 * the line, not the match positions. Found the way the hub matched (plain text or a
 * regular expression, with or without case); a query that is no valid pattern here
 * highlights nothing.
 */
export interface HighlightPart {
  text: string
  match: boolean
}

export function highlightParts(
  text: string,
  q: string,
  options: { caseSensitive: boolean; regex: boolean }
): HighlightPart[] {
  if (!q) return [{ text, match: false }]
  let pattern: RegExp
  try {
    const source = options.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    pattern = new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return [{ text, match: false }]
  }
  const parts: HighlightPart[] = []
  let at = 0
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0
    // An empty match (`a*`) highlights nothing and must not stall.
    if (m[0].length === 0) continue
    if (start > at) parts.push({ text: text.slice(at, start), match: false })
    parts.push({ text: m[0], match: true })
    at = start + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts.length > 0 ? parts : [{ text, match: false }]
}
