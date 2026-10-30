/**
 * An SVG artifact as a page, as desktop's preview shows it: the markup inline; with a
 * `viewBox`, its root `width`/`height`/`style` dropped so it fits the screen's width,
 * else at its own size. Pinch to zoom. Inline markup runs no script here: the page loads
 * with JavaScript off and its policy allows none.
 */
import { baseCss, contentPolicy, type PageTheme, pageShell } from './page-style'

const ROOT_SVG = /<svg\b[^>]*>/i
const SIZE_ATTR = /\s(?:width|height|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

export function fitSvg(svg: string): string {
  const root = ROOT_SVG.exec(svg)
  if (!root || !/\sviewBox\s*=/i.test(root[0])) return svg
  return (
    svg.slice(0, root.index) +
    root[0].replace(SIZE_ATTR, '') +
    svg.slice(root.index + root[0].length)
  )
}

export function svgPage(svg: string, theme: PageTheme): string {
  const css = `${baseCss(theme)}
.svg-host svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
`
  return pageShell({
    policy: contentPolicy(null),
    css,
    body: `<div class="svg-host">${fitSvg(svg)}</div>`
  })
}
