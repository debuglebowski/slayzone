import { useEffect, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

// --- Mermaid (lazy-loaded) ---

const MERMAID_KEYWORDS = /^%%\{|^(classDiagram|flowchart|sequenceDiagram|stateDiagram|erDiagram|gantt|pie|graph\s|gitGraph|mindmap|timeline|sankey|xychart|block-beta|journey|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Deployment)\b/

let mermaidModule: typeof import('mermaid')['default'] | null = null
let mermaidTheme: string | null = null
let mermaidIdCounter = 0

async function getMermaid(dark: boolean) {
  const theme = dark ? 'dark' : 'default'
  if (!mermaidModule) {
    const mod = await import('mermaid')
    mermaidModule = mod.default
    mermaidModule.initialize({ startOnLoad: false, theme, securityLevel: 'loose' })
    mermaidTheme = theme
  } else if (mermaidTheme !== theme) {
    mermaidModule.initialize({ startOnLoad: false, theme, securityLevel: 'loose' })
    mermaidTheme = theme
  }
  return mermaidModule
}

function showAsCodeBlock(container: HTMLElement, code: string) {
  container.innerHTML = ''
  container.className = ''
  const pre = document.createElement('pre')
  pre.className = 'text-[11px] bg-muted rounded-md p-3 overflow-x-auto text-foreground'
  const codeEl = document.createElement('code')
  codeEl.textContent = code
  pre.appendChild(codeEl)
  container.appendChild(pre)
}

// --- Diagram controls ---

const PAN_STEP = 50
const ZOOM_STEP = 0.25
const DEFAULT_ZOOM = 0.75
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

// Lucide icon paths (matching lucide-react used elsewhere in the app)
const ICON = {
  chevronUp: '<polyline points="18 15 12 9 6 15"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
  rotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  moveHorizontal: '<polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" y1="12" x2="22" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
} as const

function createControlButton(label: string, iconPath: string, onClick: () => void) {
  const btn = document.createElement('button')
  btn.title = label
  btn.className =
    'flex items-center justify-center w-7 h-7 rounded border bg-background/80 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors'
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>`
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

async function copyDiagramAsImage(svgEl: SVGSVGElement) {
  const svgClone = svgEl.cloneNode(true) as SVGSVGElement
  svgClone.style.backgroundColor = document.documentElement.classList.contains('dark') ? '#1e1e1e' : '#ffffff'
  const data = new XMLSerializer().serializeToString(svgClone)
  const blob = new Blob([data], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth * 2
      canvas.height = img.naturalHeight * 2
      const ctx = canvas.getContext('2d')!
      ctx.scale(2, 2)
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob((b) => {
        if (b) navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(resolve, reject)
        else reject(new Error('toBlob returned null'))
      })
    }
    img.onerror = reject
    img.src = url
  })
}

function attachControls(container: HTMLElement, svgEl: SVGSVGElement) {
  let zoom = DEFAULT_ZOOM
  let panX = 0
  let panY = 0
  let fitWidth = false

  const viewport = document.createElement('div')
  viewport.className = 'overflow-hidden relative'
  const inner = document.createElement('div')
  inner.className = 'transition-transform duration-150 origin-center'
  inner.style.willChange = 'transform'
  inner.appendChild(svgEl)
  viewport.appendChild(inner)
  container.insertBefore(viewport, container.firstChild)
  applyTransform()

  function applyTransform() {
    if (fitWidth) {
      inner.style.transform = ''
      inner.style.width = '100%'
      svgEl.style.width = '100%'
      svgEl.style.maxWidth = '100%'
    } else {
      inner.style.width = ''
      svgEl.style.width = ''
      svgEl.style.maxWidth = '100%'
      inner.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`
    }
  }

  // Divide by zoom so pan distance feels the same regardless of zoom level
  function pan(dx: number, dy: number) { fitWidth = false; panX += dx / zoom; panY += dy / zoom; applyTransform() }
  function zoomBy(delta: number) { fitWidth = false; zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta)); applyTransform() }
  function reset() { zoom = DEFAULT_ZOOM; panX = 0; panY = 0; fitWidth = false; applyTransform() }

  const controls = document.createElement('div')
  controls.className = 'absolute top-2 right-2 grid grid-cols-3 gap-0.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity'

  // Row 1: fit-width, up, zoom+
  controls.appendChild(createControlButton('Fit width', ICON.moveHorizontal,
    () => { fitWidth = !fitWidth; if (fitWidth) { zoom = DEFAULT_ZOOM; panX = 0; panY = 0 }; applyTransform() }))
  controls.appendChild(createControlButton('Pan up', ICON.chevronUp, () => pan(0, PAN_STEP)))
  controls.appendChild(createControlButton('Zoom in', ICON.zoomIn, () => zoomBy(ZOOM_STEP)))
  // Row 2: left, reset, right
  controls.appendChild(createControlButton('Pan left', ICON.chevronLeft, () => pan(PAN_STEP, 0)))
  controls.appendChild(createControlButton('Reset', ICON.rotateCcw, reset))
  controls.appendChild(createControlButton('Pan right', ICON.chevronRight, () => pan(-PAN_STEP, 0)))
  // Row 3: copy, down, zoom-
  controls.appendChild(createControlButton('Copy as image', ICON.copy,
    () => { copyDiagramAsImage(svgEl).catch(() => {}) }))
  controls.appendChild(createControlButton('Pan down', ICON.chevronDown, () => pan(0, -PAN_STEP)))
  controls.appendChild(createControlButton('Zoom out', ICON.zoomOut, () => zoomBy(-ZOOM_STEP)))

  container.style.position = 'relative'
  container.classList.add('group')
  container.appendChild(controls)
}

async function renderSvg(container: HTMLElement, code: string) {
  const dark = document.documentElement.classList.contains('dark')
  try {
    const m = await getMermaid(dark)
    const id = `mermaid-${++mermaidIdCounter}`
    const { svg } = await m.render(id, code)
    if (!svg) {
      showAsCodeBlock(container, code)
      return
    }
    container.innerHTML = svg
    container.className = 'my-2 overflow-hidden rounded-md border bg-muted/30 p-4'
    const svgEl = container.querySelector('svg')
    if (svgEl) {
      svgEl.style.maxWidth = '100%'
      svgEl.removeAttribute('height')
      svgEl.style.backgroundColor = 'transparent'
      attachControls(container, svgEl)
    }
  } catch (err) {
    console.warn('[GhMarkdown] mermaid render failed:', err)
    showAsCodeBlock(container, code)
  }
}

/**
 * Post-render: find mermaid placeholders and code blocks, render as SVG.
 */
async function renderMermaidBlocks(container: HTMLElement, codeMap: Map<string, string>) {
  // 1. Placeholder divs from preprocessed markdown
  const placeholders = container.querySelectorAll<HTMLElement>('[data-mermaid-id]')
  for (const el of placeholders) {
    if (el.getAttribute('data-rendered') === '1') continue
    el.setAttribute('data-rendered', '1')
    const id = el.getAttribute('data-mermaid-id')!
    const code = codeMap.get(id)
    if (code) await renderSvg(el, code)
  }

  // 2. Also scan pre>code blocks (handles code fences parsed normally by markdown)
  const codeBlocks = container.querySelectorAll('pre > code')
  for (const codeEl of codeBlocks) {
    const text = codeEl.textContent?.trim() ?? ''
    const hasClass = codeEl.classList.contains('language-mermaid')
    const looksLikeMermaid = MERMAID_KEYWORDS.test(text)
    if (!hasClass && !looksLikeMermaid) continue

    const pre = codeEl.parentElement
    if (!pre || pre.getAttribute('data-rendered') === '1') continue
    pre.setAttribute('data-rendered', '1')

    const wrapper = document.createElement('div')
    pre.replaceWith(wrapper)
    await renderSvg(wrapper, text)
  }
}

/**
 * Extract mermaid code blocks from markdown, replace with lightweight placeholders.
 * Returns the modified markdown and a map of id → mermaid code.
 */
function preprocessMermaid(md: string): { processed: string; codeMap: Map<string, string> } {
  const codeMap = new Map<string, string>()
  let counter = 0
  const processed = md.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_match, code: string) => {
    const id = `mm-${++counter}`
    codeMap.set(id, code.trim())
    return `<div data-mermaid-id="${id}"></div>`
  })
  return { processed, codeMap }
}

// --- Prose classes ---

const PROSE_CLASSES = `prose prose-sm dark:prose-invert max-w-none
  [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
  prose-p:my-1.5 prose-p:leading-relaxed
  prose-pre:my-2 prose-pre:text-[11px] prose-pre:rounded-md prose-pre:bg-muted prose-pre:text-foreground
  prose-code:text-[11px] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:bg-muted
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none
  prose-a:text-primary prose-a:no-underline hover:prose-a:underline
  prose-blockquote:border-l-2 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:my-2
  prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
  prose-img:rounded-md prose-img:my-2
  [&_details]:my-2 [&_details]:rounded-md
  [&_summary]:cursor-pointer [&_summary]:select-none
  [&_summary>h1]:inline [&_summary>h2]:inline [&_summary>h3]:inline [&_summary>h4]:inline
  [&_summary>h1]:my-0 [&_summary>h2]:my-0 [&_summary>h3]:my-0 [&_summary>h4]:my-0`

// --- Public component ---

export function GhMarkdown({ children }: { children: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const { processed, codeMap } = useMemo(() => preprocessMermaid(children), [children])

  useEffect(() => {
    if (ref.current) renderMermaidBlocks(ref.current, codeMap)
  }, [processed, codeMap])

  // Re-scan on <details> toggle
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = () => renderMermaidBlocks(el, codeMap)
    el.addEventListener('toggle', onToggle, true)
    return () => el.removeEventListener('toggle', onToggle, true)
  }, [codeMap])

  return (
    <div ref={ref} className={PROSE_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
        {processed}
      </ReactMarkdown>
    </div>
  )
}
