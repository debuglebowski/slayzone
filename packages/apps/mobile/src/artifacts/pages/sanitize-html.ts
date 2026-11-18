/**
 * Raw HTML inside a markdown artifact, made safe to show: an allowlist of tags and
 * attributes, the way desktop's editor shows it (DOMPurify's default allowlist minus
 * `<script>`/`<style>`, plus `align`). Everything that could act on its own is gone:
 * `<meta>` (a refresh leaves the page on load), forms and their controls, `<base>`,
 * frames, `<object>`/`<embed>`, `<link>`, SVG/MathML, every event handler, and any URL
 * that isn't web, mail, an artifact link, an in-page anchor or (images) a data image.
 *
 * It runs in the app (Hermes has no DOM for DOMPurify), so it never asks a parser what
 * the markup means: it rebuilds it. Text is re-escaped, and every tag it keeps is written
 * anew — its name from the allowlist, each kept attribute double-quoted with its value
 * escaped — so what the web view parses is exactly what was checked here. Anything it
 * can't read as a tag (a `<` that opens nothing, a tag cut off) is shown as text.
 */

const TAGS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'audio',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'video',
  'wbr'
])

/** Tags without content (never closed). */
const VOID = new Set(['br', 'col', 'hr', 'img', 'source', 'wbr'])

/**
 * Elements whose content goes with them when they are dropped: their content is code,
 * a raw-text element's, or markup of another kind (SVG/MathML).
 */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'applet',
  'noscript',
  'noembed',
  'noframes',
  'textarea',
  'title',
  'xmp',
  'plaintext',
  'select',
  'svg',
  'math'
])

const GLOBAL_ATTRS = new Set(['align', 'class', 'dir', 'id', 'lang', 'role', 'style', 'title'])

const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ['href'],
  audio: ['controls', 'loop', 'muted', 'preload', 'src'],
  blockquote: ['cite'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  del: ['cite', 'datetime'],
  details: ['open'],
  font: ['color', 'face', 'size'],
  img: ['alt', 'height', 'src', 'width'],
  ins: ['cite', 'datetime'],
  li: ['value'],
  ol: ['reversed', 'start', 'type'],
  q: ['cite'],
  source: ['media', 'src', 'type'],
  table: ['border', 'cellpadding', 'cellspacing', 'width'],
  td: ['colspan', 'headers', 'height', 'rowspan', 'valign', 'width'],
  th: ['colspan', 'headers', 'height', 'rowspan', 'scope', 'valign', 'width'],
  time: ['datetime'],
  ul: ['type'],
  video: ['controls', 'height', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'src', 'width']
}

/** Attributes holding a URL, and the URL schemes each kind of URL may have. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'artifact'])
const MEDIA_SCHEMES = new Set(['http', 'https'])
const URL_ATTRS: Record<string, 'link' | 'media'> = {
  href: 'link',
  cite: 'link',
  src: 'media',
  poster: 'media'
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  tab: '\t',
  newline: '\n'
}

/**
 * An attribute's value as the browser reads it, for the entities that matter here:
 * numeric ones and the common named ones. Any other named entity stays as written — and
 * since `&` is escaped on the way out, the browser then reads exactly that, too.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '�'
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Whether `url` (decoded) may stay: no scheme (in-page anchors, relative paths — which
 * lead nowhere from the page), or one `kind` allows; images also take data images.
 * Checked with every control character and space removed, since browsers ignore some of
 * them inside a scheme (`java\tscript:`).
 */
export function isSafeUrl(url: string, kind: 'link' | 'media', tag?: string): boolean {
  let compact = ''
  for (const ch of url) {
    const code = ch.charCodeAt(0)
    if (code > 0x20 && (code < 0x7f || code > 0x9f)) compact += ch
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase()
  if (scheme === undefined) return true
  if (kind === 'link') return LINK_SCHEMES.has(scheme)
  if (MEDIA_SCHEMES.has(scheme)) return true
  return tag === 'img' && scheme === 'data' && /^data:image\//i.test(compact)
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Text as written, minus anything that could open markup: `&` stays only as an entity. */
const escapeText = (text: string): string =>
  text
    .replace(/&(?!(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

interface StartTag {
  name: string
  attrs: Array<[string, string | null]>
  /** Index just past the tag's `>`. */
  end: number
}

const TAG_NAME = /[a-zA-Z][^\s/>]*/y
const ATTR_NAME = /[^\s/>][^\s/>=]*/y
const UNQUOTED = /[^\s>]*/y
const SPACE = /[\s/]*/y

function sticky(re: RegExp, input: string, at: number): string | null {
  re.lastIndex = at
  const m = re.exec(input)
  return m ? m[0] : null
}

/** The start tag at `at` (its `<`), or null if it isn't a whole one. */
function readStartTag(html: string, at: number): StartTag | null {
  const name = sticky(TAG_NAME, html, at + 1)
  if (!name) return null
  let i = at + 1 + name.length
  const attrs: StartTag['attrs'] = []
  for (;;) {
    i += sticky(SPACE, html, i)?.length ?? 0
    if (i >= html.length) return null
    if (html[i] === '>') return { name: name.toLowerCase(), attrs, end: i + 1 }
    const attr = sticky(ATTR_NAME, html, i)
    if (!attr) return null
    i += attr.length
    let j = i
    while (j < html.length && /\s/.test(html[j])) j++
    if (html[j] !== '=') {
      attrs.push([attr.toLowerCase(), null])
      continue
    }
    j++
    while (j < html.length && /\s/.test(html[j])) j++
    const quote = html[j]
    let value: string
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1)
      if (close < 0) return null
      value = html.slice(j + 1, close)
      i = close + 1
    } else {
      value = sticky(UNQUOTED, html, j) ?? ''
      i = j + value.length
    }
    attrs.push([attr.toLowerCase(), value])
  }
}

function keptAttributes(tag: string, attrs: StartTag['attrs']): string {
  const own = TAG_ATTRS[tag] ?? []
  const seen = new Set<string>()
  let out = ''
  for (const [name, raw] of attrs) {
    if (seen.has(name)) continue
    seen.add(name)
    const allowed = GLOBAL_ATTRS.has(name) || own.includes(name) || /^aria-[a-z-]+$/.test(name)
    if (!allowed) continue
    const value = raw === null ? '' : decodeEntities(raw)
    const urlKind = URL_ATTRS[name]
    if (urlKind && !isSafeUrl(value, urlKind, tag)) continue
    out += ` ${name}="${escapeAttribute(value)}"`
  }
  return out
}

/** `html` (a piece of raw HTML from a markdown document) with only what is allowed. */
export function sanitizeHtml(html: string): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += escapeText(html.slice(i))
      break
    }
    out += escapeText(html.slice(i, lt))
    const next = html[lt + 1] ?? ''
    if (html.startsWith('<!--', lt)) {
      // A comment; one never closed runs to the end, as in a browser.
      const close = html.indexOf('-->', lt + 4)
      i = close < 0 ? html.length : close + 3
    } else if (next === '!' || next === '?') {
      // A doctype, CDATA or processing instruction: up to the next `>`.
      const close = html.indexOf('>', lt)
      i = close < 0 ? html.length : close + 1
    } else if (next === '/') {
      const end = /^<\/([a-zA-Z][^\s/>]*)[^>]*>/.exec(html.slice(lt))
      if (!end) {
        out += '&lt;'
        i = lt + 1
        continue
      }
      const name = end[1].toLowerCase()
      if (TAGS.has(name) && !VOID.has(name)) out += `</${name}>`
      i = lt + end[0].length
    } else {
      const tag = readStartTag(html, lt)
      if (!tag) {
        out += '&lt;'
        i = lt + 1
        continue
      }
      i = tag.end
      if (DROP_WITH_CONTENT.has(tag.name)) {
        // Up to and past its end tag; with none here, the rest of this piece.
        const close = new RegExp(`</${tag.name}[\\s/>]`, 'i').exec(html.slice(i))
        if (!close) {
          i = html.length
        } else {
          const gt = html.indexOf('>', i + close.index)
          i = gt < 0 ? html.length : gt + 1
        }
      } else if (TAGS.has(tag.name)) {
        out += `<${tag.name}${keptAttributes(tag.name, tag.attrs)}>`
      }
    }
  }
  return out
}
