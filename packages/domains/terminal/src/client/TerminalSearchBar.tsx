import { useState, useEffect, useRef, useCallback } from 'react'
import type { SearchAddon } from '@xterm/addon-search'
import { Search, ChevronUp, ChevronDown, ALargeSmall, X } from 'lucide-react'

interface TerminalSearchBarProps {
  searchAddon: SearchAddon
  onClose: () => void
  /** Bump to pull focus back into the input when the bar is already open. */
  focusToken?: number
}

const decorations = {
  matchBackground: '#854d0e',
  matchBorder: '#a16207',
  matchOverviewRuler: '#854d0e',
  activeMatchBackground: '#ca8a04',
  activeMatchBorder: '#eab308',
  activeMatchColorOverviewRuler: '#ca8a04'
}

export function TerminalSearchBar({ searchAddon, onClose, focusToken }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [resultIndex, setResultIndex] = useState(-1)
  const [resultCount, setResultCount] = useState(0)

  // Subscribe to result changes
  useEffect(() => {
    let disposable: { dispose: () => void } | undefined
    try {
      disposable = searchAddon.onDidChangeResults((results) => {
        if (results) {
          setResultIndex(results.resultIndex)
          setResultCount(results.resultCount)
        } else {
          setResultIndex(-1)
          setResultCount(0)
        }
      })
    } catch {
      // Addon may not be ready
    }
    return () => disposable?.dispose()
  }, [searchAddon])

  // Empty query → no results. Reset while rendering whenever the search inputs
  // change (the same trigger as the effect below), so no commit shows stale counts.
  const [searchedQuery, setSearchedQuery] = useState(query)
  const [searchedCaseSensitive, setSearchedCaseSensitive] = useState(caseSensitive)
  const [searchedAddon, setSearchedAddon] = useState(searchAddon)
  if (
    searchedQuery !== query ||
    searchedCaseSensitive !== caseSensitive ||
    searchedAddon !== searchAddon
  ) {
    setSearchedQuery(query)
    setSearchedCaseSensitive(caseSensitive)
    setSearchedAddon(searchAddon)
    if (!query) {
      setResultIndex(-1)
      setResultCount(0)
    }
  }

  // Incremental search on query/caseSensitive change
  useEffect(() => {
    try {
      if (query) {
        searchAddon.findNext(query, { caseSensitive, incremental: true, decorations })
      } else {
        searchAddon.clearDecorations()
      }
    } catch {
      // Addon may be disposed
    }
  }, [query, caseSensitive, searchAddon])

  const findNext = useCallback(() => {
    try {
      if (query) searchAddon.findNext(query, { caseSensitive, decorations })
    } catch {
      /* */
    }
  }, [query, caseSensitive, searchAddon])

  const findPrevious = useCallback(() => {
    try {
      if (query) searchAddon.findPrevious(query, { caseSensitive, decorations })
    } catch {
      /* */
    }
  }, [query, caseSensitive, searchAddon])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        findPrevious()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        findNext()
      }
    },
    [onClose, findNext, findPrevious]
  )

  // Focus + select input on mount and whenever focusToken bumps
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const countDisplay = query ? (resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0/0') : ''

  return (
    // Stop propagation so container onClick doesn't steal focus from search input
    <div
      className="absolute top-2 right-4 z-50 flex items-center gap-1 bg-surface-2 border border-border dark:bg-surface-2 dark:border-border rounded-md px-2 py-1 shadow-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Search className="size-3.5 text-muted-foreground dark:text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground dark:text-foreground dark:placeholder:text-muted-foreground outline-none w-40"
        placeholder="Find..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="text-xs text-muted-foreground dark:text-muted-foreground tabular-nums shrink-0 min-w-[3ch] text-right">
        {countDisplay}
      </span>
      <button
        onClick={findPrevious}
        title="Previous (Shift+Enter)"
        className="p-0.5 hover:bg-accent dark:hover:bg-accent rounded"
      >
        <ChevronUp className="size-4 text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground" />
      </button>
      <button
        onClick={findNext}
        title="Next (Enter)"
        className="p-0.5 hover:bg-accent dark:hover:bg-accent rounded"
      >
        <ChevronDown className="size-4 text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground" />
      </button>
      <button
        onClick={() => setCaseSensitive(!caseSensitive)}
        title="Case Sensitive"
        className={`p-0.5 rounded ${caseSensitive ? 'bg-accent text-amber-600 dark:bg-accent dark:text-amber-400' : 'hover:bg-accent text-muted-foreground dark:hover:bg-accent dark:text-muted-foreground'}`}
      >
        <ALargeSmall className="size-4" />
      </button>
      <button
        onClick={onClose}
        title="Close (Escape)"
        className="p-0.5 hover:bg-accent dark:hover:bg-accent rounded"
      >
        <X className="size-3.5 text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground" />
      </button>
    </div>
  )
}
