/**
 * Lightweight markdown-to-HTML converter for Linear issue descriptions.
 * Covers: paragraphs, line breaks, headings, bold, italic, inline code,
 * code blocks, links, unordered/ordered lists, and task lists.
 */
export function markdownToHtml(md: string): string {
  if (!md) return ''

  // Normalize line endings
  let text = md.replace(/\r\n/g, '\n')

  // Extract code blocks before processing
  const codeBlocks: string[] = []
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`)
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // Split into blocks by double newlines
  const blocks = text.split(/\n{2,}/)
  const html: string[] = []

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue

    // Code block placeholder
    const cbMatch = trimmed.match(/^\x00CB(\d+)\x00$/)
    if (cbMatch) {
      html.push(codeBlocks[parseInt(cbMatch[1])])
      continue
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      html.push(`<h${level}>${inline(headingMatch[2])}</h${level}>`)
      continue
    }

    // Task list (- [ ] or - [x])
    const taskLines = trimmed.split('\n')
    if (taskLines.every((l) => /^\s*[-*]\s+\[[ xX]\]\s/.test(l))) {
      const items = taskLines.map((l) => {
        const checked = /\[[xX]\]/.test(l)
        const content = l.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '')
        return `<li data-type="taskItem" data-checked="${checked}"><p>${inline(content)}</p></li>`
      })
      html.push(`<ul data-type="taskList">${items.join('')}</ul>`)
      continue
    }

    // Unordered list
    if (taskLines.every((l) => /^\s*[-*]\s/.test(l))) {
      const items = taskLines.map((l) => `<li><p>${inline(l.replace(/^\s*[-*]\s+/, ''))}</p></li>`)
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (taskLines.every((l) => /^\s*\d+\.\s/.test(l))) {
      const items = taskLines.map((l) => `<li><p>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</p></li>`)
      html.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Paragraph — convert single newlines to <br>
    const lines = trimmed.split('\n').map((l) => inline(l)).join('<br>')
    html.push(`<p>${lines}</p>`)
  }

  return html.join('')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Convert inline markdown: bold, italic, code, links */
function inline(text: string): string {
  let s = text
  // Inline code (before other patterns to avoid conflicts)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return s
}

/** Simple HTML-to-markdown for pushing descriptions to Linear (two-way sync). */
export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let s = html
  // Code blocks
  s = s.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `\`\`\`\n${unescapeHtml(code)}\n\`\`\``)
  // Headings
  s = s.replace(/<h([123])[^>]*>(.*?)<\/h\1>/g, (_m, level, content) => `${'#'.repeat(Number(level))} ${stripTags(content)}`)
  // Task list items
  s = s.replace(/<li data-type="taskItem" data-checked="true"[^>]*><p>(.*?)<\/p><\/li>/g, '- [x] $1')
  s = s.replace(/<li data-type="taskItem" data-checked="false"[^>]*><p>(.*?)<\/p><\/li>/g, '- [ ] $1')
  // List items
  s = s.replace(/<li><p>(.*?)<\/p><\/li>/g, '- $1')
  // Remove list wrappers
  s = s.replace(/<\/?(?:ul|ol)[^>]*>/g, '')
  // Bold / italic / code
  s = s.replace(/<strong>(.*?)<\/strong>/g, '**$1**')
  s = s.replace(/<em>(.*?)<\/em>/g, '*$1*')
  s = s.replace(/<code>(.*?)<\/code>/g, '`$1`')
  // Links
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)')
  // Line breaks
  s = s.replace(/<br\s*\/?>/g, '\n')
  // Paragraphs
  s = s.replace(/<p>(.*?)<\/p>/g, '$1\n\n')
  // Strip remaining tags
  s = stripTags(s)
  return unescapeHtml(s).trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}
