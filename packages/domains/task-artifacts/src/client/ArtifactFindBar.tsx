import { useEffect, useRef, useCallback } from 'react'
import { Search, ALargeSmall, Regex, ChevronUp, ChevronDown, X } from 'lucide-react'

interface ArtifactFindBarProps {
  query: string
  onQueryChange: (q: string) => void
  onClose: () => void
  matchCount: number
  activeIndex: number
  onActiveIndexChange: (fn: (i: number) => number) => void
  matchCase: boolean
  onMatchCaseChange: (v: boolean) => void
  useRegex: boolean
  onUseRegexChange: (v: boolean) => void
  /** Bump to pull focus back into the input when the bar is already open. */
  focusToken?: number
}

export function ArtifactFindBar({
  query,
  onQueryChange,
  onClose,
  matchCount,
  activeIndex,
  onActiveIndexChange,
  matchCase,
  onMatchCaseChange,
  useRegex,
  onUseRegexChange,
  focusToken
}: ArtifactFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const goNext = useCallback(() => {
    if (matchCount === 0) return
    onActiveIndexChange((i) => (i + 1) % matchCount)
  }, [matchCount, onActiveIndexChange])

  const goPrev = useCallback(() => {
    if (matchCount === 0) return
    onActiveIndexChange((i) => (i - 1 + matchCount) % matchCount)
  }, [matchCount, onActiveIndexChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        goNext()
      }
    },
    [onClose, goNext, goPrev]
  )

  const display = query.trim()
    ? matchCount > 0
      ? `${Math.min(activeIndex, matchCount - 1) + 1}/${matchCount}`
      : '0/0'
    : ''

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
        onClick={() => onMatchCaseChange(!matchCase)}
        title="Match Case"
        className={`p-0.5 rounded shrink-0 ${matchCase ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <ALargeSmall className="size-3.5" />
      </button>
      <button
        onClick={() => onUseRegexChange(!useRegex)}
        title="Use Regular Expression"
        className={`p-0.5 rounded shrink-0 ${useRegex ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <Regex className="size-3.5" />
      </button>
      <span className="text-[10px] text-muted-foreground tabular-nums min-w-[4ch] text-center shrink-0">
        {display}
      </span>
      <button
        onClick={goPrev}
        title="Previous (Shift+Enter)"
        className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 disabled:opacity-30"
        disabled={matchCount === 0}
      >
        <ChevronUp className="size-3.5" />
      </button>
      <button
        onClick={goNext}
        title="Next (Enter)"
        className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 disabled:opacity-30"
        disabled={matchCount === 0}
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        onClick={onClose}
        title="Close (Escape)"
        className="p-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
