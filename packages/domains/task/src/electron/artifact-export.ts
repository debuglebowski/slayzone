import { marked } from 'marked'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow } from 'electron'

export const PDF_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
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

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildPdfHtml(content: string, mode: string, title: string): string {
  let body = ''

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

    case 'code': {
      const lines = content.split('\n')
      const rows = lines.map((line, i) =>
        `<tr><td class="line-numbers">${i + 1}</td><td>${escapeHtml(line) || ' '}</td></tr>`
      ).join('\n')
      body = `<pre style="background:none;padding:0"><table class="code-table">${rows}</table></pre>`
      break
    }

    default:
      body = `<pre><code>${escapeHtml(content)}</code></pre>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PDF_CSS}</style></head><body>${body}</body></html>`
}

export function buildMermaidPdfHtml(content: string, title: string): string {
  let mermaidJs = ''
  try {
    const mermaidPath = require.resolve('mermaid/dist/mermaid.min.js')
    mermaidJs = readFileSync(mermaidPath, 'utf-8')
  } catch {
    // Fallback: render as code
    return buildPdfHtml(content, 'code', title)
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PDF_CSS} .mermaid svg { max-width: 100%; }</style>
</head><body>
<pre class="mermaid">${escapeHtml(content)}</pre>
<script>${mermaidJs}</script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'default' });
  mermaid.run().then(() => {
    document.title = 'MERMAID_READY';
  }).catch(() => {
    document.title = 'MERMAID_READY';
  });
</script>
</body></html>`
}

export function buildPngHtml(content: string, mode: string, title: string): string {
  const isMermaid = mode === 'mermaid-preview'
  const bodyHtml = isMermaid
    ? `<pre class="mermaid">${escapeHtml(content)}</pre>`
    : `<div style="display:inline-block">${content}</div>`

  let mermaidScript = ''
  if (isMermaid) {
    try {
      const mermaidPath = require.resolve('mermaid/dist/mermaid.min.js')
      const mermaidJs = readFileSync(mermaidPath, 'utf-8')
      mermaidScript = `<script>${mermaidJs}</script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'default' });
  mermaid.run().then(() => { document.title = 'READY'; }).catch(() => { document.title = 'READY'; });
</script>`
    } catch {
      return ''
    }
  } else {
    mermaidScript = `<script>document.title = 'READY';</script>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>* { margin: 0; padding: 0; } body { background: white; display: inline-block; } .mermaid svg { display: block; }</style>
</head><body>${bodyHtml}${mermaidScript}</body></html>`
}

// --- BrowserWindow rendering orchestration ---

async function waitForTitle(offscreen: BrowserWindow, expected: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await offscreen.webContents.executeJavaScript('document.title')
    if (ready === expected) return
    await new Promise(r => setTimeout(r, 100))
  }
}

/** Render HTML to PDF via offscreen BrowserWindow. Returns the PDF buffer. */
export async function renderToPdf(html: string, isMermaid: boolean): Promise<Buffer> {
  const tempPath = join(tmpdir(), `slayzone-pdf-${Date.now()}.html`)
  writeFileSync(tempPath, html, 'utf-8')

  let offscreen: BrowserWindow | null = null
  try {
    offscreen = new BrowserWindow({
      show: false, width: 800, height: 600,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    })
    await offscreen.loadFile(tempPath)

    if (isMermaid) await waitForTitle(offscreen, 'MERMAID_READY')

    return Buffer.from(await offscreen.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { marginType: 'default' },
    }))
  } finally {
    offscreen?.destroy()
    try { unlinkSync(tempPath) } catch {}
  }
}

/** Render HTML to PNG via offscreen BrowserWindow. Returns the PNG buffer. */
export async function renderToPng(html: string): Promise<Buffer> {
  const tempPath = join(tmpdir(), `slayzone-png-${Date.now()}.html`)
  writeFileSync(tempPath, html, 'utf-8')

  let offscreen: BrowserWindow | null = null
  try {
    offscreen = new BrowserWindow({
      show: false, width: 2000, height: 2000,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    })
    await offscreen.loadFile(tempPath)

    await waitForTitle(offscreen, 'READY')

    const rect = await offscreen.webContents.executeJavaScript(
      `(() => { const el = document.body.firstElementChild; if (!el) return { w: 400, h: 300 }; const r = el.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; })()`
    )
    const w = Math.max(rect.w, 10)
    const h = Math.max(rect.h, 10)
    offscreen.setContentSize(w, h)
    await new Promise(r => setTimeout(r, 100))

    const image = await offscreen.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    return image.toPNG()
  } finally {
    offscreen?.destroy()
    try { unlinkSync(tempPath) } catch {}
  }
}
