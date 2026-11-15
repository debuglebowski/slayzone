/**
 * The self-contained HTML documents an artifact export renders: one per render mode,
 * for PDF (also the "Download as HTML" file) and for PNG. Pure — no DOM, no fs, no
 * Electron — so every client that exports builds the identical document and only the
 * engine that rasterises it differs: desktop's offscreen BrowserWindow, the web shell's
 * print frame, the phone's native print, the CLI's headless Chrome.
 *
 * Mermaid diagrams are drawn inside the document by mermaid's standalone browser build
 * (`mermaid/dist/mermaid.min.js`), which each client loads its own way and passes in as
 * `mermaidJs`. When a diagram is present the document flags itself ready once mermaid
 * has finished (see `EXPORT_READY_EXPRESSION`); a renderer must wait for that before
 * printing or capturing.
 */
import { marked } from 'marked'
import type { RenderMode } from '@slayzone/task-contracts'

/** What a client produces from an artifact. */
export type ArtifactExportFormat = 'pdf' | 'png' | 'html'

export const PDF_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; background: white; line-height: 1.6; padding: 2rem; font-size: 14px; }
    h1 { font-size: 1.8em; margin: 1em 0 0.5em; font-weight: 700; }
    h2 { font-size: 1.4em; margin: 1em 0 0.4em; font-weight: 600; }
    h3 { font-size: 1.2em; margin: 0.8em 0 0.3em; font-weight: 600; }
    h4, h5, h6 { font-size: 1em; margin: 0.6em 0 0.2em; font-weight: 600; }
    p { margin: 0.5em 0; }
    a { color: #2563eb; text-decoration: underline; }
    ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
    li { margin: 0.2em 0; }
    blockquote { border-left: 3px solid #d1d5db; padding-left: 1em; margin: 0.5em 0; color: #4b5563; font-style: italic; }
    code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; background: #f3f4f6; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f3f4f6; padding: 1em; border-radius: 6px; overflow-x: auto; margin: 0.8em 0; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
    th, td { border: 1px solid #d1d5db; padding: 0.5em 0.75em; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #d1d5db; margin: 1.5em 0; }
    .line-numbers { color: #9ca3af; text-align: right; padding-right: 1em; user-select: none; border-right: 1px solid #e5e7eb; }
    .code-table { width: 100%; border: none; }
    .code-table td { border: none; padding: 0 0.5em; white-space: pre; vertical-align: top; }
    @page { margin: 1.5cm; }
  `

/**
 * Evaluates to `true` in a built document once it is ready to print/capture. Only a
 * document that draws a mermaid diagram has anything to wait for (`needsReadyWait`).
 * A data attribute, not `document.title`: the exported HTML file keeps the artifact's
 * title when a person opens it.
 */
export const EXPORT_READY_EXPRESSION = "document.documentElement.dataset.exportReady === '1'"

/** Whether the document for `mode` draws asynchronously and must be awaited. */
export function needsReadyWait(mode: RenderMode | string): boolean {
  return mode === 'mermaid-preview'
}

/** Whether building `mode`'s document needs mermaid's browser build. */
export function needsMermaidScript(mode: RenderMode | string): boolean {
  return mode === 'mermaid-preview'
}

/** File name for an export: the artifact title without its extension. */
export function exportBaseName(title: string): string {
  return title.replace(/\.[^.]+$/, '') || title
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// `layout: 'dagre'` keeps mermaid 12's ELK default out, matching the in-app
// MermaidBlock. A failed render still flags ready: the page shows mermaid's error
// rather than hanging the export.
function mermaidRunScript(mermaidJs: string, nonce: string): string {
  // `</script` inside the bundle would end the tag early.
  const safe = mermaidJs.replace(/<\/script/gi, '<\\/script')
  return `<script nonce="${nonce}">${safe}</script>
<script nonce="${nonce}">
  mermaid.initialize({ startOnLoad: false, theme: 'default', layout: 'dagre' });
  mermaid.run().catch(function () {}).then(function () {
    document.documentElement.dataset.exportReady = '1';
  });
</script>`
}

function codeTableHtml(content: string): string {
  const rows = content
    .split('\n')
    .map(
      (line, i) =>
        `<tr><td class="line-numbers">${i + 1}</td><td>${escapeHtml(line) || ' '}</td></tr>`
    )
    .join('\n')
  return `<pre style="background:none;padding:0"><table class="code-table">${rows}</table></pre>`
}

/** How a document is built for one renderer. */
export interface DocumentOptions {
  /**
   * The nonce scripts must carry to run (a caller that adds a script of its own
   * passes it). Generated when the document inlines mermaid and none is given.
   */
  nonce?: string
  /**
   * The exported HTML FILE (not a render): no policy, exactly as main exported it. A
   * file opened later from disk carries no app privilege, so a policy would only
   * break it (an artifact's own scripts, external styles).
   */
  standalone?: boolean
}

/** An unguessable nonce: an artifact cannot carry one that matches. */
function newNonce(): string {
  const bytes = new Uint8Array(16)
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  // Hermes has no crypto: as the phone's own viewer pages do.
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The Content-Security-Policy every exported document carries, first in its head: no
 * script runs but those carrying `nonce` (none when null), nothing is fetched but
 * images, fonts and media. An artifact's markup — `<img onerror>`, `<script>`, SVG
 * handlers — is inert in every renderer.
 */
export function exportDocumentPolicy(nonce: string | null): string {
  return [
    "default-src 'none'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob: http: https:',
    'font-src data: http: https:',
    'media-src data: blob: http: https:',
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

function documentHead(title: string, nonce: string | null, policy = true): string {
  const csp = policy
    ? `<meta http-equiv="Content-Security-Policy" content="${exportDocumentPolicy(nonce)}">`
    : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<title>${escapeHtml(title)}</title>`
}

/**
 * The paged document for `mode`: what PDF export prints and HTML export saves.
 * A mermaid artifact without `mermaidJs` degrades to its source as code.
 */
export function buildDocumentHtml(
  content: string,
  mode: RenderMode | string,
  title: string,
  mermaidJs?: string | null,
  opts: DocumentOptions = {}
): string {
  if (mode === 'mermaid-preview') {
    if (!mermaidJs) return buildDocumentHtml(content, 'code', title, null, opts)
    const nonce = opts.nonce ?? newNonce()
    return `${documentHead(title, nonce, !opts.standalone)}
<style>${PDF_CSS} .mermaid svg { max-width: 100%; }</style>
</head><body>
<pre class="mermaid">${escapeHtml(content)}</pre>
${mermaidRunScript(mermaidJs, nonce)}
</body></html>`
  }
  // An html artifact is a page of its own: rendered as written — its scripts and
  // external styles included, as main rendered it. Each host isolates that render
  // (desktop: a throwaway session on an opaque origin; CLI: a throwaway profile; web:
  // the hub's sandboxed export frame; phone: a hidden web view it controls, then prints
  // the drawn page with scripts blocked).
  const head = documentHead(title, opts.nonce ?? null, !opts.standalone && mode !== 'html-preview')

  let body: string
  switch (mode) {
    case 'markdown':
      body = marked.parse(content, { async: false }) as string
      break
    case 'html-preview':
      body = content
      break
    case 'svg-preview':
      body = `<div style="display:flex;justify-content:center;padding:2rem">${content}</div>`
      break
    case 'code':
      body = codeTableHtml(content)
      break
    default:
      body = `<pre><code>${escapeHtml(content)}</code></pre>`
  }
  return `${head}<style>${PDF_CSS}</style></head><body>${body}</body></html>`
}

/**
 * `buildDocumentHtml`'s mermaid document for a diagram the client has ALREADY drawn
 * to `svg` (in its own page, with its own mermaid): same layout, no script, nothing
 * to wait for. For a client that renders the export where scripts cannot run.
 */
export function buildDrawnMermaidDocumentHtml(svg: string, title: string): string {
  return `${documentHead(title, null)}
<style>${PDF_CSS} .mermaid svg { max-width: 100%; }</style>
</head><body>
<pre class="mermaid">${svg}</pre>
</body></html>`
}

/**
 * The tight document a PNG is captured from: the drawing alone, on white, as the
 * body's first element (a renderer sizes the capture to it). Null when `mode` has
 * no PNG form or a mermaid artifact comes without `mermaidJs`.
 */
export function buildPngHtml(
  content: string,
  mode: RenderMode | string,
  title: string,
  mermaidJs?: string | null,
  opts: Pick<DocumentOptions, 'nonce'> = {}
): string | null {
  const isMermaid = mode === 'mermaid-preview'
  if (!isMermaid && mode !== 'svg-preview') return null
  if (isMermaid && !mermaidJs) return null

  const nonce = opts.nonce ?? (isMermaid ? newNonce() : null)
  const body = isMermaid
    ? `<pre class="mermaid">${escapeHtml(content)}</pre>${mermaidRunScript(mermaidJs as string, nonce as string)}`
    : `<div style="display:inline-block">${content}</div>`

  return `${documentHead(title, nonce)}
<style>* { margin: 0; padding: 0; } body { background: white; display: inline-block; } svg { display: block; }</style>
</head><body>${body}</body></html>`
}

/**
 * Measures the PNG document's drawing in CSS pixels, at least 10×10. Run inside the
 * document (it is an expression string for `executeJavaScript` / CDP `Runtime.evaluate`).
 */
export const PNG_MEASURE_EXPRESSION = `(() => { const el = document.body.firstElementChild; if (!el) return { w: 400, h: 300 }; const r = el.getBoundingClientRect(); return { w: Math.max(Math.ceil(r.width), 10), h: Math.max(Math.ceil(r.height), 10) }; })()`
