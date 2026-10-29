export interface Frontmatter {
  name?: string
  description?: string
  /** `argument-hint:` — custom slash commands show it next to the name. */
  argumentHint?: string
  /** Raw markdown body (frontmatter + `---` removed). */
  body: string
}

/**
 * Parse a minimal YAML subset from a markdown file's frontmatter.
 * Extracts `name:`, `description:` (inline scalar or `|` / `>` block) and
 * `argument-hint:`.
 * Returns `body` = the markdown content after the closing `---`.
 * Intentionally narrow — no nested keys, no array values.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) {
    return { body: normalized }
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { body: normalized }

  const fmText = normalized.slice(3, end).replace(/^\n/, '')
  const body = normalized.slice(end + 4).replace(/^\n/, '')
  const lines = fmText.split('\n')

  const out: Frontmatter = { body }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2]
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      i++
      const collected: string[] = []
      let baseIndent = -1
      while (i < lines.length) {
        const ln = lines[i]
        if (ln.trim() === '') {
          collected.push('')
          i++
          continue
        }
        const indent = ln.match(/^\s*/)?.[0].length ?? 0
        if (baseIndent === -1) {
          if (indent === 0) break
          baseIndent = indent
        }
        if (indent < baseIndent) break
        collected.push(ln.slice(baseIndent))
        i++
      }
      setField(out, key, collected.join('\n').trim())
      continue
    }
    const value = rest.replace(/^['"]|['"]$/g, '').trim()
    setField(out, key, value)
    i++
  }
  return out
}

function setField(out: Frontmatter, key: string, value: string): void {
  if (key === 'name' || key === 'description') out[key] = value
  else if (key === 'argument-hint') out.argumentHint = value
}
