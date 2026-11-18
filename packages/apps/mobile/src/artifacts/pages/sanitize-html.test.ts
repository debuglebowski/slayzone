import { isSafeUrl, sanitizeHtml } from './sanitize-html'

describe('sanitizeHtml', () => {
  it('rebuilds kept tags: lower-case names, double-quoted escaped values', () => {
    expect(sanitizeHtml("<P ALIGN=center TITLE='a\"b'>x</P>")).toBe(
      '<p align="center" title="a&quot;b">x</p>'
    )
    expect(sanitizeHtml('<details open><summary>S</summary></details>')).toBe(
      '<details open=""><summary>S</summary></details>'
    )
  })

  it('drops scripts, styles and frames with their content; unknown tags keep only their text', () => {
    expect(sanitizeHtml('a<script>alert(1)</script>b<style>*{}</style>c')).toBe('abc')
    expect(sanitizeHtml('<svg><script>x</script></svg>ok')).toBe('ok')
    expect(sanitizeHtml('<blink>hi</blink>')).toBe('hi')
    expect(sanitizeHtml('<scr<script>ipt>alert(1)</script>')).not.toMatch(/<script/i)
  })

  it('drops handlers and unsafe URLs in any spelling', () => {
    expect(sanitizeHtml('<IMG SRC=x.png OnError=alert(1)>')).toBe('<img src="x.png">')
    expect(sanitizeHtml('<a href=javascript:alert(1)>x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<a href="&#x6A;avascript&colon;alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<a href="\u0001javascript:x">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toBe(
      '<img src="data:image/png;base64,AAAA">'
    )
    expect(sanitizeHtml('<video src="data:video/mp4;base64,AAAA"></video>')).toBe('<video></video>')
  })

  it('shows what it cannot read as a tag as text', () => {
    expect(sanitizeHtml('1 < 2 and <img src="x')).toBe('1 &lt; 2 and &lt;img src="x')
    expect(sanitizeHtml('a &amp; b & c &nbsp;')).toBe('a &amp; b &amp; c &nbsp;')
    expect(sanitizeHtml('x<!-- <script>y</script> -->z<!doctype html>')).toBe('xz')
  })
})

describe('isSafeUrl', () => {
  it('allows web, mail, artifact links and anchors; media only from the web', () => {
    for (const url of ['https://x', 'http://x', 'mailto:a@b', 'artifact:a1', '#top', 'rel/path']) {
      expect(isSafeUrl(url, 'link')).toBe(true)
    }
    for (const url of [
      'javascript:x',
      'vbscript:x',
      'data:text/html,x',
      'file:///etc',
      'slayzone://x'
    ]) {
      expect(isSafeUrl(url, 'link')).toBe(false)
    }
    expect(isSafeUrl('mailto:a@b', 'media')).toBe(false)
    expect(isSafeUrl('data:image/png;base64,A', 'media', 'img')).toBe(true)
  })
})
