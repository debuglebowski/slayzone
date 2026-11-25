/**
 * The artifact's zoom (`zoom_pct`, desktop's header control) applied to a page, the way
 * desktop applies it:
 *
 * - A document (markdown, code, a source view): CSS `zoom` on the root, a layout-level
 *   scale, so the text reflows to the narrower width as browser zoom does (desktop's
 *   `ZoomPane`).
 * - An HTML report: its frame is another document behind `sandbox`, out of reach of the
 *   host's CSS. The frame's viewport shrinks by the zoom and the frame is scaled back up
 *   by it, so the report reflows, then paints enlarged (desktop's `HtmlPreviewFrame`).
 *   The report scrolls itself; the host never does.
 * - A file (PDF): untouched; WebKit zooms it itself.
 *
 * A style, not a script: pages without scripts load with JavaScript off, which also
 * keeps the app's own scripts out (`DocumentWebView`).
 */
import type { DocumentPage } from '../DocumentWebView'

const HEAD_CLOSE = '</head>'

/** `style` last in the page's own head (the first `</head>`: the app writes the head). */
function withStyle(html: string, style: string): string {
  const at = html.indexOf(HEAD_CLOSE)
  if (at < 0) throw new Error('pageAtZoom: the page has no head')
  return `${html.slice(0, at)}<style>${style}</style>${html.slice(at)}`
}

/** `pct`: the zoom in percent (100 = as the page is). */
export function pageAtZoom(page: DocumentPage, pct: number): DocumentPage {
  if (pct === 100 || page.kind === 'file') return page
  const zoom = pct / 100
  if (page.kind === 'document') return { ...page, html: withStyle(page.html, `html{zoom:${zoom}}`) }
  const viewport = `${100 / zoom}%`
  return {
    ...page,
    html: withStyle(
      page.html,
      // The frame's box keeps its unscaled size: below 100% it is wider than the screen.
      `html,body{overflow:hidden}iframe{width:${viewport};height:${viewport};transform:scale(${zoom});transform-origin:0 0}`
    )
  }
}
