import { useState, useEffect, useRef, useSyncExternalStore, useMemo } from 'react'
import { CanvasMediaView } from './CanvasMediaView'

/**
 * Reads `dark`/`light` from the `<html>` element and re-subscribes when the
 * `class` attribute mutates. Provider-free so MermaidBlock works in detached
 * React roots (e.g. ProseMirror NodeViews) where ThemeContext isn't reachable.
 */
function useThemeVariant(): 'dark' | 'light' {
  return useSyncExternalStore(
    (onChange) => {
      const obs = new MutationObserver(onChange)
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => obs.disconnect()
    },
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    () => 'dark',
  )
}

const MAX_CACHE = 50

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

export interface MermaidBlockProps {
  code: string
  fill?: boolean
}

export function MermaidBlock({ code, fill = false }: MermaidBlockProps) {
  const theme = useThemeVariant()
  const cacheKey = `${theme}::${code}`
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(cacheKey) ?? null)
  const [hasError, setHasError] = useState(false)
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
    if (fill || !svg || !svgHostRef.current) return
    const svgEl = svgHostRef.current.querySelector('svg') as SVGSVGElement | null
    if (!svgEl) return
    svgEl.style.backgroundColor = 'transparent'
    svgEl.style.maxWidth = '100%'
    svgEl.removeAttribute('height')
  }, [svg, fill])

  if (hasError) {
    return (
      <pre className="text-[11px] bg-muted rounded-md p-3 overflow-x-auto text-foreground">
        <code>{code}</code>
      </pre>
    )
  }

  if (!svg) {
    return <div className={fill ? 'flex-1 bg-muted/30 animate-pulse' : 'my-2 h-12 rounded-md bg-muted/30 animate-pulse'} />
  }

  if (fill) {
    return <FillMermaid svg={svg} />
  }

  return (
    <div className="my-2 overflow-hidden rounded-md border bg-muted/30 p-4">
      <div ref={svgHostRef} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}

function FillMermaid({ svg }: { svg: string }) {
  const source = useMemo(() => ({ kind: 'svg' as const, svg }), [svg])
  return (
    <div className="flex-1 min-h-0 bg-muted/30 relative overflow-hidden">
      <CanvasMediaView source={source} className="absolute inset-0" />
    </div>
  )
}
