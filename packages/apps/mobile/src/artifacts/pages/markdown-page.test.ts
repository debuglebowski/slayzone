import { testPageTheme } from '../testing'
import { markdownNeedsMermaid, markdownPage } from './markdown-page'

const theme = testPageTheme('dark')
const MERMAID = 'globalThis.mermaid={/*stub*/}'

describe('markdownPage', () => {
  it('renders GitHub-flavoured markdown: tables, task lists (read-only), strikethrough', () => {
    const { html, scripts } = markdownPage(
      '| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~old~~',
      { theme, mermaidScript: null }
    )
    expect(html).toContain('<table>')
    expect(html).toContain('<th align="center">b</th>')
    expect(html).toMatch(/<input checked="" disabled="" type="checkbox">/)
    expect(html).toMatch(/<input disabled="" type="checkbox">/)
    expect(html).toContain('<del>old</del>')
    expect(scripts).toBe(false)
  })

  it('draws artifact links as chips that open the artifact', () => {
    const { html } = markdownPage('See [Spec v2](artifact:6f1c) and [site](https://x.dev).', {
      theme,
      mermaidScript: null
    })
    expect(html).toContain('<a class="artifact-link" href="artifact:6f1c">Spec v2</a>')
    expect(html).toContain('<a href="https://x.dev">site</a>')
  })

  it('shows code blocks as escaped, unhighlighted text (desktop highlights none)', () => {
    const { html } = markdownPage('```ts\nconst a = <div/>\n```', { theme, mermaidScript: null })
    expect(html).toContain('<pre><code class="language-ts">const a = &lt;div/&gt;\n</code></pre>')
  })

  it('keeps raw HTML but drops <script> and <style>, as desktop does', () => {
    const { html } = markdownPage(
      '<details><summary>More</summary>Hidden</details>\n\n<script>alert(1)</script>\n\n<style>body{display:none}</style>\n\ntext <script>x()</script> end',
      { theme, mermaidScript: null }
    )
    expect(html).toContain('<details><summary>More</summary>Hidden</details>')
    const body = html.slice(html.indexOf('<body'))
    expect(body).not.toMatch(/<script|<style/)
  })

  it('runs no script at all without diagrams (CSP)', () => {
    const { html } = markdownPage('# Hi', { theme, mermaidScript: null })
    expect(html).toContain("script-src 'none'")
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy"/)
  })

  it("paints in the app's theme", () => {
    const { html } = markdownPage('# Hi', { theme, mermaidScript: null })
    expect(html).toContain(theme.colors.background)
    expect(html).toContain(theme.colors.foreground)
  })

  it('draws ```mermaid fences with the bundled mermaid, under a nonce, with a Preview/Raw toggle', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    expect(markdownNeedsMermaid(text)).toBe(true)
    expect(markdownNeedsMermaid('```js\ngraph TD\n```\n\ngraph TD')).toBe(false)

    const { html, scripts } = markdownPage(text, { theme, mermaidScript: MERMAID })
    expect(scripts).toBe(true)
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)?.[1]
    expect(nonce).toBeTruthy()
    expect(html).toContain(`<script nonce="${nonce}">${MERMAID}</script>`)
    expect(html).toContain('"securityLevel":"strict"')
    expect(html).toContain('"theme":"dark"')
    expect(html).toContain('class="mermaid-block"')
    expect(html).toContain('graph TD; A--&gt;B')
    expect(html).toContain('data-show="diagram"')
    expect(html).toContain('data-show="source"')
    // Every script on the page carries the nonce: raw HTML's could not run.
    expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull()
  })

  it('without the bundled mermaid, shows fences as code and runs nothing', () => {
    const { html, scripts } = markdownPage('```mermaid\ngraph TD\n```', {
      theme,
      mermaidScript: null
    })
    expect(scripts).toBe(false)
    expect(html).toContain('<pre><code class="language-mermaid">graph TD\n</code></pre>')
  })
})
