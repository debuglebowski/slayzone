/**
 * What every artifact page shares: escaping, the page shell with its content security
 * policy, and the document style in the app's theme (colours are the theme's values,
 * named only in `src/theme.ts`).
 *
 * Pages that run no script (markdown without diagrams, code, SVG) also load with
 * JavaScript off in the web view; the policy says the same (`script-src 'none'`). A page
 * that draws diagrams runs exactly the scripts it carries, each with the page's nonce —
 * so a `<script>` (or an `onclick`) inside an artifact never runs, as on desktop, where
 * the markdown renderer drops them.
 */
import type { ChromeColors } from '@slayzone/theme-tokens'

export interface PageTheme {
  colors: ChromeColors
  variant: 'dark' | 'light'
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)

/** A fresh nonce per page: content inside the page cannot know it. */
export function newNonce(): string {
  let nonce = ''
  for (let i = 0; i < 4; i++) nonce += Math.floor(Math.random() * 0x100000000).toString(36)
  return nonce
}

/**
 * A script for inline embedding: refused if it holds `<script` or `</script`, which
 * would end (or nest) the element early and turn the rest into page content.
 */
export function inlineScript(nonce: string, js: string): string {
  if (/<\/?script/i.test(js)) throw new Error('inlineScript: the script contains a script tag')
  return `<script nonce="${nonce}">${js}</script>`
}

/** Images, media and fonts from the web (desktop's previews load them too); no requests else. */
const BASE_POLICY =
  "default-src 'none'; img-src https: data:; media-src https:; font-src https: data:; style-src 'unsafe-inline'"

export function contentPolicy(scriptNonce: string | null): string {
  return `${BASE_POLICY}; script-src ${scriptNonce ? `'nonce-${scriptNonce}'` : "'none'"}`
}

export function pageShell(options: {
  policy: string
  css: string
  body: string
  /** After the body: the page's own scripts. */
  scripts?: string
  bodyClass?: string
}): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${options.policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">',
    `<style>${options.css}</style></head>`,
    `<body${options.bodyClass ? ` class="${options.bodyClass}"` : ''}>${options.body}`,
    options.scripts ?? '',
    '</body></html>'
  ].join('')
}

/** The page's base: the theme's background and text, system fonts (Dynamic Type). */
export function baseCss({ colors, variant }: PageTheme): string {
  return `
:root { color-scheme: ${variant}; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 16px; background: ${colors.background}; color: ${colors.foreground};
  font: -apple-system-body; line-height: 1.55; overflow-wrap: anywhere; }
a { color: ${colors.primary}; }
code, pre, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; }
`
}

/** Rendered markdown (GFM) and the mermaid blocks in it. */
export function documentCss(theme: PageTheme): string {
  const { colors } = theme
  return `${baseCss(theme)}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
h1, h2 { padding-bottom: 0.25em; border-bottom: 1px solid ${colors.border}; }
p, ul, ol, blockquote, pre, table, details { margin: 0 0 0.9em; }
ul, ol { padding-left: 1.4em; }
li > ul, li > ol { margin-bottom: 0; }
li:has(> input[type="checkbox"]) { list-style: none; }
li > input[type="checkbox"] { margin: 0 0.45em 0 -1.3em; vertical-align: middle; }
code { background: ${colors.muted}; border-radius: 4px; padding: 0.1em 0.35em; }
pre { background: ${colors.muted}; border-radius: 6px; padding: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; white-space: pre; }
blockquote { margin-left: 0; padding: 0 0 0 0.9em; border-left: 3px solid ${colors.border};
  color: ${colors.mutedForeground}; }
hr { border: 0; border-top: 1px solid ${colors.border}; margin: 1.4em 0; }
img { max-width: 100%; height: auto; }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
th, td { border: 1px solid ${colors.border}; padding: 6px 10px; }
th { background: ${colors.muted}; }
a.artifact-link { text-decoration: none; color: ${colors.foreground}; background: ${colors.muted};
  border: 1px solid ${colors.border}; border-radius: 6px; padding: 0.05em 0.45em; }
.mermaid-block { margin: 0.6em 0 1em; border: 1px solid ${colors.border}; border-radius: 6px;
  background: color-mix(in srgb, ${colors.muted} 30%, transparent); padding: 12px; }
.mermaid-toolbar { display: none; gap: 4px; justify-content: flex-end; margin-bottom: 8px; }
.mermaid-toolbar button { font: inherit; font-size: 0.8em; color: ${colors.mutedForeground};
  background: none; border: 1px solid ${colors.border}; border-radius: 5px; padding: 2px 10px; }
.mermaid-block[data-view="diagram"] .mermaid-toolbar,
.mermaid-block[data-view="source"] .mermaid-toolbar { display: flex; }
.mermaid-block[data-view="diagram"] [data-show="diagram"],
.mermaid-block[data-view="source"] [data-show="source"] { color: ${colors.foreground};
  background: ${colors.muted}; }
.mermaid-block[data-view="diagram"] .mermaid-source { display: none; }
.mermaid-block:not([data-view="diagram"]) .mermaid-diagram { display: none; }
.mermaid-block[data-view="loading"] .mermaid-source { opacity: 0.4; }
.mermaid-block .mermaid-source { margin: 0; }
.mermaid-fill { border: 0; background: none; padding: 0; margin: 0; }
.mermaid-fill .mermaid-diagram svg { max-width: 100%; height: auto; }
`
}
