/**
 * A mermaid artifact (`.mmd`) as a page: its one diagram filling the width, drawn with
 * desktop's mermaid and options (`mermaid-script.ts`); pinch to zoom. A source mermaid
 * can't parse shows as code, as on desktop.
 */
import { mermaidBlock, mermaidScripts } from './mermaid-script'
import { contentPolicy, documentCss, newNonce, type PageTheme, pageShell } from './page-style'

export function mermaidPage(
  source: string,
  options: { theme: PageTheme; mermaidScript: string }
): string {
  const nonce = newNonce()
  return pageShell({
    policy: contentPolicy(nonce),
    css: documentCss(options.theme),
    body: mermaidBlock(source, { fill: true }),
    scripts: mermaidScripts(nonce, options.mermaidScript, options.theme)
  })
}
