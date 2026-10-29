import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import type { LanguageSupport } from '@codemirror/language'
import { highlightTree, classHighlighter } from '@lezer/highlight'

export interface HlSpan {
  from: number
  to: number
  classes: string
}

export interface TokenizeRequest {
  id: string
  content: string
  path: string
}

export type TokenizeResponse = { id: string; spans: HlSpan[][] } | { id: string; error: string }

function getLanguageByExt(ext: string | undefined): LanguageSupport | null {
  switch (ext?.toLowerCase()) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'html':
    case 'htm':
      return html()
    case 'md':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'go':
      return go()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'sql':
      return sql()
    default:
      return null
  }
}

function getExt(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return undefined
  return path.slice(dot + 1)
}

function upperBound(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function tokenize(content: string, path: string): HlSpan[][] {
  const lang = getLanguageByExt(getExt(path))
  if (!lang || !content) return []

  const lineStarts: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
  const totalLines = lineStarts.length

  const tree = lang.language.parser.parse(content)
  const spansByLine: HlSpan[][] = Array.from({ length: totalLines }, () => [])

  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (!classes) return
    let lineIdx = upperBound(lineStarts, from) - 1
    while (lineIdx < totalLines && from < to) {
      const lineStart = lineStarts[lineIdx]
      const lineEnd = lineIdx + 1 < totalLines ? lineStarts[lineIdx + 1] - 1 : content.length
      const segFrom = Math.max(from, lineStart) - lineStart
      const segTo = Math.min(to, lineEnd) - lineStart
      if (segTo > segFrom) {
        spansByLine[lineIdx].push({ from: segFrom, to: segTo, classes })
      }
      if (to <= lineEnd) break
      lineIdx++
      from = lineStarts[lineIdx]
    }
  })

  return spansByLine
}

self.addEventListener('message', (event: MessageEvent<TokenizeRequest>) => {
  const { id, content, path } = event.data
  try {
    const spans = tokenize(content, path)
    const response: TokenizeResponse = { id, spans }
    ;(self as unknown as Worker).postMessage(response)
  } catch (err) {
    const response: TokenizeResponse = {
      id,
      error: err instanceof Error ? err.message : String(err)
    }
    ;(self as unknown as Worker).postMessage(response)
  }
})
