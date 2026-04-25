import { useState, useEffect, useRef } from 'react'
import { useTheme } from '@slayzone/settings/client'
import { IconButton } from '@slayzone/ui'
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  MoveHorizontal,
  Copy,
} from 'lucide-react'

const MAX_CACHE = 50
const PAN_STEP = 50
const ZOOM_STEP = 0.25
const DEFAULT_ZOOM = 0.75
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

type Mermaid = typeof import('mermaid')['default']

let mermaidInflight: Promise<Mermaid> | null = null
let mermaidTheme: 'dark' | 'default' | null = null
let mermaidIdCounter = 0
const svgCache = new Map<string, string>()

async function getMermaid(theme: 'dark' | 'light'): Promise<Mermaid> {
  const target: 'dark' | 'default' = theme === 'dark' ? 'dark' : 'default'

  if (!mermaidInflight) {
    mermaidInflight = import('mermaid').then((mod) => {
      mod.default.initialize({ startOnLoad: false, theme: target, securityLevel: 'strict' })
      mermaidTheme = target
      return mod.default
    })
    return mermaidInflight
  }

  const m = await mermaidInflight
  if (mermaidTheme !== target) {
    svgCache.clear()
    m.initialize({ startOnLoad: false, theme: target, securityLevel: 'strict' })
    mermaidTheme = target
  }
  return m
}

async function copyDiagramAsImage(svgEl: SVGSVGElement, dark: boolean): Promise<void> {
  const svgClone = svgEl.cloneNode(true) as SVGSVGElement
  svgClone.style.backgroundColor = dark ? '#1e1e1e' : '#ffffff'
  const data = new XMLSerializer().serializeToString(svgClone)
  const blob = new Blob([data], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth * 2
          canvas.height = img.naturalHeight * 2
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('canvas 2d context unavailable'))
            return
          }
          ctx.scale(2, 2)
          ctx.drawImage(img, 0, 0)
          canvas.toBlob((b) => {
            if (b) navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(resolve, reject)
            else reject(new Error('toBlob returned null'))
          })
        } catch (err) {
          reject(err)
        }
      }
      img.onerror = () => reject(new Error('image load failed'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const { theme } = useTheme()
  const cacheKey = `${theme}::${code}`
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(cacheKey) ?? null)
  const [hasError, setHasError] = useState(false)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [fitWidth, setFitWidth] = useState(false)
  const svgHostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cached = svgCache.get(cacheKey)
    if (cached !== undefined) {
      setSvg(cached)
      setHasError(false)
      return
    }
    let cancelled = false
    setHasError(false)
    setSvg(null)
    getMermaid(theme)
      .then(async (m) => {
        const id = `mermaid-shared-${++mermaidIdCounter}`
        const { svg: rendered } = await m.render(id, code)
        if (cancelled) return
        if (rendered) {
          if (svgCache.size >= MAX_CACHE) {
            const firstKey = svgCache.keys().next().value
            if (firstKey !== undefined) svgCache.delete(firstKey)
          }
          svgCache.set(cacheKey, rendered)
          setSvg(rendered)
        } else {
          setHasError(true)
        }
      })
      .catch((err) => {
        console.warn('[MermaidBlock] render failed:', err)
        if (!cancelled) setHasError(true)
      })
    return () => {
      cancelled = true
    }
  }, [code, theme, cacheKey])

  useEffect(() => {
    if (!svg || !svgHostRef.current) return
    const svgEl = svgHostRef.current.querySelector('svg')
    if (!svgEl) return
    svgEl.style.maxWidth = '100%'
    svgEl.removeAttribute('height')
    svgEl.style.backgroundColor = 'transparent'
  }, [svg])

  function pan(dx: number, dy: number) {
    setFitWidth(false)
    setPanX((x) => x + dx / zoom)
    setPanY((y) => y + dy / zoom)
  }
  function zoomBy(delta: number) {
    setFitWidth(false)
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)))
  }
  function reset() {
    setZoom(DEFAULT_ZOOM)
    setPanX(0)
    setPanY(0)
    setFitWidth(false)
  }
  function toggleFitWidth() {
    setFitWidth((prev) => {
      const next = !prev
      if (next) {
        setZoom(DEFAULT_ZOOM)
        setPanX(0)
        setPanY(0)
      }
      return next
    })
  }
  function copy() {
    const svgEl = svgHostRef.current?.querySelector('svg') as SVGSVGElement | null
    if (!svgEl) return
    copyDiagramAsImage(svgEl, theme === 'dark').catch((err) => {
      console.warn('[MermaidBlock] copy failed:', err)
    })
  }

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

  const innerStyle = fitWidth
    ? { width: '100%' }
    : { transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`, willChange: 'transform' as const }

  return (
    <div className="my-2 overflow-hidden rounded-md border bg-muted/30 p-4 relative group">
      <div className="overflow-hidden relative">
        <div
          ref={svgHostRef}
          className="transition-transform duration-150 origin-center"
          style={innerStyle}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute top-2 right-2 grid grid-cols-3 gap-0.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton aria-label="Fit width" size="icon-sm" variant="outline" onClick={toggleFitWidth}>
          <MoveHorizontal className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Pan up" size="icon-sm" variant="outline" onClick={() => pan(0, PAN_STEP)}>
          <ChevronUp className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Zoom in" size="icon-sm" variant="outline" onClick={() => zoomBy(ZOOM_STEP)}>
          <ZoomIn className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Pan left" size="icon-sm" variant="outline" onClick={() => pan(PAN_STEP, 0)}>
          <ChevronLeft className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Reset" size="icon-sm" variant="outline" onClick={reset}>
          <RotateCcw className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Pan right" size="icon-sm" variant="outline" onClick={() => pan(-PAN_STEP, 0)}>
          <ChevronRight className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Copy as image" size="icon-sm" variant="outline" onClick={copy}>
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Pan down" size="icon-sm" variant="outline" onClick={() => pan(0, -PAN_STEP)}>
          <ChevronDown className="size-3.5" />
        </IconButton>
        <IconButton aria-label="Zoom out" size="icon-sm" variant="outline" onClick={() => zoomBy(-ZOOM_STEP)}>
          <ZoomOut className="size-3.5" />
        </IconButton>
      </div>
    </div>
  )
}
