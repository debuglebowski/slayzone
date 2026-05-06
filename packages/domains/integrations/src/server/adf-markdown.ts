/**
 * Bidirectional ADF (Atlassian Document Format) ↔ Markdown conversion.
 * Handles core node types; unknown nodes fall back to plain text.
 * No external dependencies.
 */

interface AdfNode {
  type: string
  content?: AdfNode[]
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

// --- ADF → Markdown ---

function renderMarks(text: string, marks?: AdfNode['marks']): string {
  if (!marks || marks.length === 0) return text
  let result = text
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        result = `**${result}**`
        break
      case 'em':
        result = `*${result}*`
        break
      case 'code':
        result = `\`${result}\``
        break
      case 'strike':
        result = `~~${result}~~`
        break
      case 'link':
        result = `[${result}](${(mark.attrs?.href as string) ?? ''})`
        break
    }
  }
  return result
}

function adfNodeToMarkdown(node: AdfNode, listPrefix?: string): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map((child) => adfNodeToMarkdown(child)).join('')

    case 'paragraph':
      return (node.content ?? []).map((child) => adfNodeToMarkdown(child)).join('') + '\n\n'

    case 'heading': {
      const level = Math.min(Math.max((node.attrs?.level as number) ?? 1, 1), 6)
      const text = (node.content ?? []).map((child) => adfNodeToMarkdown(child)).join('')
      return '#'.repeat(level) + ' ' + text + '\n\n'
    }

    case 'text':
      return renderMarks(node.text ?? '', node.marks)

    case 'hardBreak':
      return '\n'

    case 'bulletList':
      return (node.content ?? []).map((child) => adfNodeToMarkdown(child, '- ')).join('') + '\n'

    case 'orderedList':
      return (node.content ?? []).map((child, i) => adfNodeToMarkdown(child, `${i + 1}. `)).join('') + '\n'

    case 'listItem': {
      const prefix = listPrefix ?? '- '
      const inner = (node.content ?? []).map((child) => adfNodeToMarkdown(child)).join('').trim()
      return prefix + inner + '\n'
    }

    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? ''
      const code = (node.content ?? []).map((child) => child.text ?? '').join('')
      return '```' + lang + '\n' + code + '\n```\n\n'
    }

    case 'blockquote': {
      const inner = (node.content ?? []).map((child) => adfNodeToMarkdown(child)).join('')
      return inner.split('\n').filter(Boolean).map((line) => '> ' + line).join('\n') + '\n\n'
    }

    case 'rule':
      return '---\n\n'

    case 'mention':
      return `@${(node.attrs?.text as string) ?? 'user'}`

    case 'emoji':
      return (node.attrs?.text as string) ?? (node.attrs?.shortName as string) ?? ''

    default:
      // Unknown node: try to extract text content
      if (node.content) {
        return node.content.map((child) => adfNodeToMarkdown(child)).join('')
      }
      return node.text ?? ''
  }
}

export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return ''
  return adfNodeToMarkdown(adf as AdfNode).trim()
}

// --- Markdown → ADF ---

function parseInlineMarks(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  // Regex for inline marks: **bold**, *italic*, `code`, ~~strike~~, [text](url)
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[(.+?)\]\((.+?)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[2]) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] })
    } else if (match[3]) {
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'em' }] })
    } else if (match[4]) {
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'code' }] })
    } else if (match[5]) {
      nodes.push({ type: 'text', text: match[5], marks: [{ type: 'strike' }] })
    } else if (match[6] && match[7]) {
      nodes.push({ type: 'text', text: match[6], marks: [{ type: 'link', attrs: { href: match[7] } }] })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

function paragraphNode(text: string): AdfNode {
  return { type: 'paragraph', content: parseInlineMarks(text) }
}

export function markdownToAdf(md: string): object {
  const lines = md.split('\n')
  const content: AdfNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Empty line
    if (line.trim() === '') {
      i++
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      content.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarks(headingMatch[2])
      })
      i++
      continue
    }

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      content.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text: codeLines.join('\n') }]
      })
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      content.push({
        type: 'blockquote',
        content: [paragraphNode(quoteLines.join('\n'))]
      })
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      content.push({ type: 'rule' })
      i++
      continue
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: AdfNode[] = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: [paragraphNode(lines[i].replace(/^[-*+]\s/, ''))]
        })
        i++
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: AdfNode[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push({
          type: 'listItem',
          content: [paragraphNode(lines[i].replace(/^\d+\.\s/, ''))]
        })
        i++
      }
      content.push({ type: 'orderedList', content: items })
      continue
    }

    // Regular paragraph
    content.push(paragraphNode(line))
    i++
  }

  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [paragraphNode('')]
  }
}
