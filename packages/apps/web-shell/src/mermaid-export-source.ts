// The mermaid source the web shell draws an export from: the diagram with the export's
// look (light theme, dagre layout) given as an init directive, which applies to that
// one render — the in-app MermaidBlock owns mermaid's global config (its dark/light
// theme), so `initialize` is not ours to call.
//
// Mermaid reads frontmatter (`---\ntitle: …\n---`) only at the very start of the
// source, so the directive goes after it. A directive outranks frontmatter config,
// while every other client sets the look with `initialize`, which frontmatter
// outranks — so the directive carries only what the diagram leaves unset.

const whitespace = /\s/
const isLineBreak = (ch: string | undefined): boolean => ch === '\n' || ch === '\r'

/** The last line break in the whitespace run starting at `from`, or -1. */
function lastLineBreakInWhitespace(text: string, from: number): number {
  let found = -1
  for (let i = from; i < text.length && whitespace.test(text[i]); i++) {
    if (isLineBreak(text[i])) found = i
  }
  return found
}

/**
 * The length of the frontmatter block `code` starts with (with the blank lines after
 * it), or 0 when it has none. The rule mermaid 12 applies (`matchFrontMatter`): an
 * optionally indented `---` line, then the first line that is the same indent and
 * `---` with a line break after it.
 */
export function frontmatterLength(code: string): number {
  let cursor = 0
  while (cursor < code.length && whitespace.test(code[cursor]) && !isLineBreak(code[cursor])) {
    cursor++
  }
  const indent = code.slice(0, cursor)
  if (!code.startsWith('---', cursor)) return 0
  const opened = lastLineBreakInWhitespace(code, cursor + 3)
  if (opened === -1) return 0
  // The first line break of the opening fence's whitespace starts the body search;
  // only a line break followed by the fence can close it.
  let bodyFrom = cursor + 3
  while (!isLineBreak(code[bodyFrom])) bodyFrom++
  const fence = `${indent}---`
  for (let i = bodyFrom + 1; i < code.length; i++) {
    if (!isLineBreak(code[i]) || !code.startsWith(fence, i + 1)) continue
    const end = lastLineBreakInWhitespace(code, i + 1 + fence.length)
    if (end !== -1) return end + 1
  }
  return 0
}

/** The part of a mermaid config this module reads (what `mermaid.parse` reports). */
export interface OwnMermaidConfig {
  theme?: unknown
  layout?: unknown
}

/**
 * `code` with the export's look as an init directive, placed after any frontmatter.
 * `own` is the diagram's own config (`mermaid.parse(code).config`: its frontmatter and
 * directives); a setting it has is left to it. `htmlLabels: false` (labels as SVG
 * text, which a tainting browser can rasterise) is always applied.
 */
export function withExportDirective(
  code: string,
  own: OwnMermaidConfig,
  opts: { htmlLabels: boolean }
): string {
  const look: Record<string, unknown> = {}
  if (own.theme === undefined) look.theme = 'default'
  if (own.layout === undefined) look.layout = 'dagre'
  if (!opts.htmlLabels) {
    look.htmlLabels = false
    look.flowchart = { htmlLabels: false }
  }
  const at = frontmatterLength(code)
  return `${code.slice(0, at)}%%{init: ${JSON.stringify(look)}}%%\n${code.slice(at)}`
}
