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

  describe('raw HTML: only an allowlist of tags and attributes survives', () => {
    const bodyOf = (md: string) => {
      const { html } = markdownPage(md, { theme, mermaidScript: null })
      return html.slice(html.indexOf('<body'))
    }

    it('drops a meta refresh (it would leave the page on load)', () => {
      const body = bodyOf(
        'Hi\n\n<meta http-equiv="refresh" content="0;url=https://evil.example">\n\ninline <meta http-equiv="refresh" content="0;url=artifact:a1"> end'
      )
      expect(body).not.toMatch(/<meta/i)
      expect(body).not.toContain('http-equiv')
    })

    it('drops forms and their controls, <base>, frames, objects and embeds', () => {
      const body = bodyOf(
        [
          '<form action="https://evil.example" method="post"><input name="pw"><button>Go</button></form>',
          '<base href="https://evil.example/">',
          '<iframe src="https://evil.example"></iframe>',
          '<object data="https://evil.example/x.swf"></object>',
          '<embed src="https://evil.example/x.swf">',
          '<link rel="stylesheet" href="https://evil.example/x.css">'
        ].join('\n\n')
      )
      expect(body).not.toMatch(/<(form|input|button|base|iframe|object|embed|link)\b/i)
      expect(body).not.toContain('evil.example')
    })

    it('drops event handlers and javascript: URLs, however they are spelt', () => {
      const body = bodyOf(
        [
          '<img src="https://x.dev/a.png" onerror="alert(1)">',
          '<a href="javascript:alert(1)">a</a>',
          '<a href="  JaVaScRiPt:alert(1)">b</a>',
          '<a href="java&#x09;script:alert(1)">c</a>',
          '<a href="&#106;avascript:alert(1)">d</a>',
          '<a href="vbscript:x">e</a> <a href="data:text/html,<script>x</script>">f</a>',
          '<div ONCLICK="x()" style="color: red">g</div>',
          '[md link](javascript:alert(1)) ![md img](javascript:alert(1))'
        ].join('\n\n')
      )
      expect(body).not.toMatch(/\son[a-z]+=/i)
      expect(body.toLowerCase()).not.toMatch(/(java|vb)\s*script:|&#106;|data:text/)
      expect(body).toContain('<img src="https://x.dev/a.png">')
      expect(body).toContain('<div style="color: red">g</div>')
      expect(body).toContain('md link')
    })

    it('keeps the formatting HTML desktop keeps, with safe links', () => {
      const body = bodyOf(
        '<p align="center"><img src="https://x.dev/logo.png" alt="Logo" width="80"></p>\n\n<a href="https://x.dev">site</a> <a href="artifact:a2">doc</a> <a href="#top">top</a> <kbd>Ctrl</kbd> <sup>2</sup>\n\n<!-- a comment -->'
      )
      expect(body).toContain(
        '<p align="center"><img src="https://x.dev/logo.png" alt="Logo" width="80"></p>'
      )
      expect(body).toContain('<a href="https://x.dev">site</a>')
      expect(body).toContain('<a href="artifact:a2">doc</a>')
      expect(body).toContain('<a href="#top">top</a>')
      expect(body).toContain('<kbd>Ctrl</kbd>')
      expect(body).toContain('<sup>2</sup>')
      expect(body).not.toContain('<!--')
    })

    it('never lets a broken tag swallow the page', () => {
      const body = bodyOf('<div title="x>y" class=a>ok</div>\n\n<img src="x\n\n<b>after</b>')
      expect(body).toContain('<div title="x&gt;y" class="a">ok</div>')
      expect(body).toContain('<b>after</b>')
    })
  })

  it('submits no form and takes no <base> (CSP)', () => {
    const { html } = markdownPage('# Hi', { theme, mermaidScript: null })
    expect(html).toContain("form-action 'none'")
    expect(html).toContain("base-uri 'none'")
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
