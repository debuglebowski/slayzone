/** Convert task description to Markdown for the editor, handling legacy HTML format. */
export function normalizeDescription(raw: string | null, format: 'html' | 'markdown'): string {
  if (!raw) return ''
  if (format === 'html') return htmlToMarkdown(raw)
  return raw
}

/** Strip Markdown formatting to get plain text (for terminal injection). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^[-*]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .trim()
}

/** Lightweight HTML-to-Markdown converter for legacy TipTap descriptions. */
function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let s = html
  s = s.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `\`\`\`\n${unescapeHtml(code)}\n\`\`\``)
  s = s.replace(/<h([123])[^>]*>(.*?)<\/h\1>/g, (_m, level, content) => `${'#'.repeat(Number(level))} ${stripTags(content)}`)
  // Blockquotes
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_m, content) => {
    const inner = content.replace(/<p>(.*?)<\/p>/g, '$1').trim()
    return inner.split('\n').map((line: string) => `> ${line}`).join('\n')
  })
  // Horizontal rules
  s = s.replace(/<hr\s*\/?>/g, '\n---\n')
  s = s.replace(/<li data-type="taskItem" data-checked="true"[^>]*><p>(.*?)<\/p><\/li>/g, '- [x] $1')
  s = s.replace(/<li data-type="taskItem" data-checked="false"[^>]*><p>(.*?)<\/p><\/li>/g, '- [ ] $1')
  s = s.replace(/<li><p>(.*?)<\/p><\/li>/g, '- $1')
  s = s.replace(/<\/?(?:ul|ol)[^>]*>/g, '')
  s = s.replace(/<strong>(.*?)<\/strong>/g, '**$1**')
  s = s.replace(/<em>(.*?)<\/em>/g, '*$1*')
  s = s.replace(/<code>(.*?)<\/code>/g, '`$1`')
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)')
  s = s.replace(/<br\s*\/?>/g, '\n')
  s = s.replace(/<p>(.*?)<\/p>/g, '$1\n\n')
  s = stripTags(s)
  return unescapeHtml(s).trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}
