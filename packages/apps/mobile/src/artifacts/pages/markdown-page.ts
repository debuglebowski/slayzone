/**
 * A markdown artifact as a page, rendered the way desktop's editor shows it: GitHub
 * flavoured (tables, task lists, strikethrough, autolinks), raw HTML kept but `<script>`
 * and `<style>` dropped (desktop: DOMPurify, `FORBID_TAGS: ['script','style']`), artifact
 * links (`[Title](artifact:<id>)`) as chips that open the artifact, code blocks as plain
 * monospace (desktop highlights none), ```` ```mermaid ```` fences drawn as diagrams.
 * Task-list checkboxes show their state but are not toggles: the phone views, it does
 * not edit.
 *
 * Parsed with `marked` (the app's one markdown parser; chat uses it too).
 */
import { MERMAID_FENCE_LANGUAGE } from '@slayzone/markdown/mermaid-config'
import { Marked, type Tokens } from 'marked'
import { mermaidBlock, mermaidScripts } from './mermaid-script'
import {
  contentPolicy,
  documentCss,
  escapeHtml,
  newNonce,
  type PageTheme,
  pageShell
} from './page-style'

const SCRIPT_OR_STYLE_ELEMENT = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi
const SCRIPT_OR_STYLE_TAG = /<\/?(?:script|style)\b[^>]*>/gi

/** Raw HTML minus `<script>`/`<style>` (whole elements; a stray tag alone). */
const withoutScriptsAndStyles = (html: string): string =>
  html.replace(SCRIPT_OR_STYLE_ELEMENT, '').replace(SCRIPT_OR_STYLE_TAG, '')

const isMermaidFence = (token: Tokens.Code): boolean =>
  token.lang?.trim().split(/\s+/, 1)[0] === MERMAID_FENCE_LANGUAGE

function parser(drawDiagrams: boolean): Marked {
  return new Marked({
    gfm: true,
    renderer: {
      link(token) {
        if (!token.href.startsWith('artifact:')) return false
        const text = this.parser.parseInline(token.tokens)
        return `<a class="artifact-link" href="${escapeHtml(token.href)}">${text}</a>`
      },
      code(token) {
        if (!drawDiagrams || !isMermaidFence(token)) return false
        return mermaidBlock(token.text, { fill: false })
      },
      html(token) {
        return withoutScriptsAndStyles(token.text)
      }
    }
  })
}

/** Whether the text has a diagram to draw (and so the page needs mermaid). */
export function markdownNeedsMermaid(text: string): boolean {
  const marked = new Marked({ gfm: true })
  let found = false
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type === 'code' && isMermaidFence(token as Tokens.Code)) found = true
  })
  return found
}

export interface MarkdownPage {
  html: string
  /** The page runs scripts (its diagrams): load it with JavaScript on. */
  scripts: boolean
}

/**
 * `mermaidScript`: the bundled mermaid build, or null — then fences show as code and the
 * page runs nothing.
 */
export function markdownPage(
  text: string,
  options: { theme: PageTheme; mermaidScript: string | null }
): MarkdownPage {
  const draw = options.mermaidScript !== null && markdownNeedsMermaid(text)
  const body = parser(draw).parse(text, { async: false })
  const nonce = draw ? newNonce() : null
  return {
    html: pageShell({
      policy: contentPolicy(nonce),
      css: documentCss(options.theme),
      body,
      scripts:
        nonce && options.mermaidScript !== null
          ? mermaidScripts(nonce, options.mermaidScript, options.theme)
          : ''
    }),
    scripts: draw
  }
}
