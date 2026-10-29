import { useEffect, useRef, useCallback } from 'react'
import { Search, ChevronUp, ChevronDown, ALargeSmall, X } from 'lucide-react'

interface ChatSearchBarProps {
  query: string
  onQueryChange: (q: string) => void
  caseSensitive: boolean
  onCaseSensitiveChange: (v: boolean) => void
  resultCount: number
  resultIndex: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  /** Bumped to refocus when reopening with bar already mounted. */
  focusToken?: number
}

/**
 * Chat-mode search bar. Mirrors `TerminalSearchBar` UX (input, prev/next,
 * case toggle, count) but searches the message timeline rather than xterm
 * SearchAddon. Result computation lives in the parent so navigation and
 * highlighting stay in sync.
 */
export function ChatSearchBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  resultCount,
  resultIndex,
  onPrev,
  onNext,
  onClose,
  focusToken
}: ChatSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        onPrev()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onNext()
      }
    },
    [onClose, onPrev, onNext]
  )

  const countDisplay = query ? (resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0/0') : ''

  return (
    <div
      className="absolute top-2 right-4 z-50 flex items-center gap-1 bg-surface-2 border border-border rounded-md px-2 py-1 shadow-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Search className="size-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none w-40"
        placeholder="Find in chat…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="text-xs text-muted-foreground tabular-nums shrink-0 min-w-[3ch] text-right">
        {countDisplay}
      </span>
      <button
        onClick={onPrev}
        title="Previous (Shift+Enter)"
        className="p-0.5 hover:bg-accent rounded"
        disabled={resultCount === 0}
      >
        <ChevronUp className="size-4 text-muted-foreground hover:text-foreground" />
      </button>
      <button
        onClick={onNext}
        title="Next (Enter)"
        className="p-0.5 hover:bg-accent rounded"
        disabled={resultCount === 0}
      >
        <ChevronDown className="size-4 text-muted-foreground hover:text-foreground" />
      </button>
      <button
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        title="Case sensitive"
        className={`p-0.5 rounded ${caseSensitive ? 'bg-accent text-search-match-active' : 'hover:bg-accent text-muted-foreground'}`}
      >
        <ALargeSmall className="size-4" />
      </button>
      <button onClick={onClose} title="Close (Escape)" className="p-0.5 hover:bg-accent rounded">
        <X className="size-3.5 text-muted-foreground hover:text-foreground" />
      </button>
    </div>
  )
}
