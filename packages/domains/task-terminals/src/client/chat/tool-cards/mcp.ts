/** MCP tool naming and result content, for the MCP tool card. */

/** `mcp__<server>__<tool>` (Claude Code's MCP tool names) → its parts, else null. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep + 2 >= rest.length) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

export type McpBlock =
  | { kind: 'text'; text: string }
  /** Text that parsed as JSON, pretty-printed. */
  | { kind: 'json'; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'resource'; uri: string; text?: string }
  | { kind: 'other'; text: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function textBlock(text: string): McpBlock {
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(t), null, 2) }
    } catch {
      // not JSON — plain text
    }
  }
  return { kind: 'text', text }
}

function contentBlock(b: unknown): McpBlock {
  if (!isRecord(b)) return { kind: 'other', text: JSON.stringify(b, null, 2) }
  if (b.type === 'text' && typeof b.text === 'string') return textBlock(b.text)
  if (b.type === 'image') {
    // Anthropic block (`source: {type:'base64', media_type, data}`) or MCP block (`data`, `mimeType`).
    const src = isRecord(b.source) ? b.source : b
    const mime = (src.media_type ?? src.mimeType) as unknown
    if (typeof src.data === 'string' && typeof mime === 'string') {
      return { kind: 'image', src: `data:${mime};base64,${src.data}` }
    }
  }
  if (b.type === 'resource' && isRecord(b.resource) && typeof b.resource.uri === 'string') {
    const text = typeof b.resource.text === 'string' ? b.resource.text : undefined
    return { kind: 'resource', uri: b.resource.uri, ...(text !== undefined ? { text } : {}) }
  }
  if (b.type === 'resource_link' && typeof b.uri === 'string') {
    const text = typeof b.name === 'string' ? b.name : undefined
    return { kind: 'resource', uri: b.uri, ...(text !== undefined ? { text } : {}) }
  }
  return { kind: 'other', text: JSON.stringify(b, null, 2) }
}

/** An MCP tool's result (`tool_result` content: string or content blocks) as display blocks. */
export function mcpResultBlocks(rawContent: unknown): McpBlock[] {
  if (rawContent == null) return []
  if (typeof rawContent === 'string') return rawContent.trim() ? [textBlock(rawContent)] : []
  if (Array.isArray(rawContent)) return rawContent.map(contentBlock)
  return [contentBlock(rawContent)]
}
