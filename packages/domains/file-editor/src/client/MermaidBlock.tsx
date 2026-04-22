import { useState, useEffect, useLayoutEffect, useRef } from 'react'

// --- Mermaid lazy loader ---

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

// Cache SVG by code string — instant re-display when typing other parts of doc
const svgCache = new Map<string, string>()

// --- Pan/zoom controls ---

const PAN_STEP = 50
const ZOOM_STEP = 0.25
const DEFAULT_ZOOM = 0.75
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

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
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
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

  function pan(dx: number, dy: number) { fitWidth = false; panX += dx / zoom; panY += dy / zoom; applyTransform() }
  function zoomBy(delta: number) { fitWidth = false; zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta)); applyTransform() }
  function reset() { zoom = DEFAULT_ZOOM; panX = 0; panY = 0; fitWidth = false; applyTransform() }

  const controls = document.createElement('div')
  controls.className = 'absolute top-2 right-2 grid grid-cols-3 gap-0.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity'

  controls.appendChild(createControlButton('Fit width', ICON.moveHorizontal,
    () => { fitWidth = !fitWidth; if (fitWidth) { zoom = DEFAULT_ZOOM; panX = 0; panY = 0 }; applyTransform() }))
  controls.appendChild(createControlButton('Pan up', ICON.chevronUp, () => pan(0, PAN_STEP)))
  controls.appendChild(createControlButton('Zoom in', ICON.zoomIn, () => zoomBy(ZOOM_STEP)))
  controls.appendChild(createControlButton('Pan left', ICON.chevronLeft, () => pan(PAN_STEP, 0)))
  controls.appendChild(createControlButton('Reset', ICON.rotateCcw, reset))
  controls.appendChild(createControlButton('Pan right', ICON.chevronRight, () => pan(-PAN_STEP, 0)))
  controls.appendChild(createControlButton('Copy as image', ICON.copy,
    () => { copyDiagramAsImage(svgEl).catch(() => {}) }))
  controls.appendChild(createControlButton('Pan down', ICON.chevronDown, () => pan(0, -PAN_STEP)))
  controls.appendChild(createControlButton('Zoom out', ICON.zoomOut, () => zoomBy(-ZOOM_STEP)))

  container.appendChild(controls)
}

// --- Component ---

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(code) ?? null)
  const [hasError, setHasError] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Attach pan/zoom controls after SVG is injected into DOM
  useLayoutEffect(() => {
    if (!svg || !containerRef.current) return
    const svgEl = containerRef.current.querySelector('svg') as SVGSVGElement | null
    if (!svgEl) return
    svgEl.style.maxWidth = '100%'
    svgEl.removeAttribute('height')
    svgEl.style.backgroundColor = 'transparent'
    attachControls(containerRef.current, svgEl)
  }, [svg])

  useEffect(() => {
    // Cached — render instantly, no flicker
    const cached = svgCache.get(code)
    if (cached !== undefined) {
      setSvg(cached)
      setHasError(false)
      return
    }

    let cancelled = false
    setHasError(false)

    const dark = document.documentElement.classList.contains('dark')
    getMermaid(dark).then(async (m) => {
      const id = `mermaid-fe-${++mermaidIdCounter}`
      const { svg: rendered } = await m.render(id, code)
      if (!cancelled) {
        if (rendered) {
          svgCache.set(code, rendered)
          setSvg(rendered)
        } else {
          setHasError(true)
        }
      }
    }).catch((err) => {
      console.warn('[MermaidBlock] render failed:', err)
      if (!cancelled) setHasError(true)
    })

    return () => { cancelled = true }
  }, [code])

  if (hasError) {
    return (
      <pre className="text-[11px] bg-muted rounded-md p-3 overflow-x-auto text-foreground">
        <code>{code}</code>
      </pre>
    )
  }

  if (!svg) {
    return <div className="my-2 h-12 rounded-md bg-muted/30 animate-pulse" />
  }

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-hidden rounded-md border bg-muted/30 p-4 relative group"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
