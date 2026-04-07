import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, ALargeSmall, ChevronUp, ChevronDown, X } from 'lucide-react'

interface AssetFindBarProps {
  query: string
  onQueryChange: (q: string) => void
  onClose: () => void
  content: string
  onScrollToLine?: (line: number) => void
}

interface Match {
  index: number
  line: number
  col: number
}

export function AssetFindBar({ query, onQueryChange, onClose, content, onScrollToLine }: AssetFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [matchCase, setMatchCase] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => { inputRef.current?.focus() }, [])

  const matches = useMemo(() => {
    if (!query.trim()) return [] as Match[]
    try {
      const flags = matchCase ? 'g' : 'gi'
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped, flags)
      const result: Match[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const before = content.slice(0, m.index)
        const line = before.split('\n').length
        const lastNl = before.lastIndexOf('\n')
        const col = m.index - (lastNl === -1 ? 0 : lastNl + 1)
        result.push({ index: m.index, line, col })
        if (m[0].length === 0) { re.lastIndex++; break }
      }
      return result
    } catch {
      return [] as Match[]
    }
  }, [query, content, matchCase])

  // Reset active index when matches change
  useEffect(() => { setActiveIndex(0) }, [matches])

  // Scroll to active match
  useEffect(() => {
    if (matches.length > 0 && onScrollToLine) {
      onScrollToLine(matches[activeIndex]?.line ?? 1)
    }
  }, [activeIndex, matches, onScrollToLine])

  const goNext = useCallback(() => {
    if (matches.length === 0) return
    setActiveIndex(i => (i + 1) % matches.length)
  }, [matches.length])

  const goPrev = useCallback(() => {
    if (matches.length === 0) return
    setActiveIndex(i => (i - 1 + matches.length) % matches.length)
  }, [matches.length])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goPrev() }
    else if (e.key === 'Enter') { e.preventDefault(); goNext() }
  }, [onClose, goNext, goPrev])

  return (
    <div className="absolute top-1 right-3 z-20 flex items-center gap-1 bg-surface-1 border border-border rounded-md shadow-md px-2 py-1">
      <Search className="size-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none w-36"
        placeholder="Find..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        onClick={() => setMatchCase(!matchCase)}
        title="Match Case"
        className={`p-0.5 rounded shrink-0 ${matchCase ? 'bg-muted text-amber-600 dark:text-amber-400' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <ALargeSmall className="size-3.5" />
      </button>
      <span className="text-[10px] text-muted-foreground tabular-nums min-w-[4ch] text-center shrink-0">
        {query.trim() ? (matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : '0/0') : ''}
      </span>
      <button onClick={goPrev} title="Previous (Shift+Enter)" className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 disabled:opacity-30" disabled={matches.length === 0}>
        <ChevronUp className="size-3.5" />
      </button>
      <button onClick={goNext} title="Next (Enter)" className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 disabled:opacity-30" disabled={matches.length === 0}>
        <ChevronDown className="size-3.5" />
      </button>
      <button onClick={onClose} title="Close (Escape)" className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0">
        <X className="size-3.5" />
      </button>
    </div>
  )
}
