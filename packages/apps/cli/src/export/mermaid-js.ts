/** mermaid's browser build, for documents that draw a mermaid diagram (read once). */
import { readMermaidJs } from './mermaid-js-source'

let cached: string | undefined

export function loadMermaidJs(): string {
  cached ??= readMermaidJs()
  return cached
}
