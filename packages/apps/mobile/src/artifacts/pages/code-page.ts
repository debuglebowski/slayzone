/**
 * A code or plain-text artifact as a page, as desktop's code view shows it: monospace,
 * line numbers, long lines wrapped, no highlighting. The numbers are drawn by CSS
 * counters, so selecting and copying the text copies only the text.
 */
import { baseCss, contentPolicy, escapeHtml, type PageTheme, pageShell } from './page-style'

export function codePage(text: string, theme: PageTheme): string {
  const lines = text.split(/\r?\n/)
  const body = `<pre class="code">${lines.map((line) => `<span class="l">${escapeHtml(line)}</span>`).join('\n')}</pre>`
  const { colors } = theme
  const css = `${baseCss(theme)}
body { padding: 8px 12px 8px 0; }
pre.code { margin: 0; font-size: 13px; line-height: 1.5; counter-reset: line;
  white-space: pre-wrap; word-break: break-word; }
.l { display: block; position: relative; padding-left: 4.2em; min-height: 1.5em; counter-increment: line; }
.l::before { content: counter(line); position: absolute; left: 0; width: 3.4em; text-align: right;
  color: ${colors.mutedForeground}; -webkit-user-select: none; user-select: none; }
`
  return pageShell({ policy: contentPolicy(null), css, body })
}
